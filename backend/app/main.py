import logging

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1 import router as api_router
from app.core.auth import require_user
from app.core.config import settings

logger = logging.getLogger(__name__)

_IS_PROD = settings.ENVIRONMENT == "production"

app = FastAPI(
    title="Axis Performance API",
    description="Instant satellite roof quotes, scored exclusive leads, and a roofing CRM.",
    version="0.2.0",
    # No public API map in production — Swagger/UI stays available in dev.
    docs_url=None if _IS_PROD else "/docs",
    redoc_url=None if _IS_PROD else "/redoc",
    openapi_url=None if _IS_PROD else "/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # @app.exception_handler(Exception) runs inside ServerErrorMiddleware, which is
    # OUTSIDE CORSMiddleware — so CORS headers are never added automatically here.
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    origin = request.headers.get("origin", "")
    allowed = origin if origin in settings.allowed_origins_list else ""
    detail = str(exc) if settings.ENVIRONMENT != "production" else "Internal server error"
    headers = {}
    if allowed:
        headers["Access-Control-Allow-Origin"] = allowed
        headers["Access-Control-Allow-Credentials"] = "true"
    return JSONResponse(status_code=500, content={"detail": detail}, headers=headers)


app.include_router(api_router, prefix="/api/v1")

if _IS_PROD and not settings.SUPABASE_JWT_SECRET:
    logger.critical(
        "SUPABASE_JWT_SECRET is not set in production — JWTs are NOT being "
        "verified (legacy mode). Set it in Render immediately."
    )


@app.get("/diag/gemini")
async def diag_gemini(user: dict = Depends(require_user)):
    """Tests every configured Gemini key against every fallback model and
    reports which (key, model) pairs work. Read-only, no secrets — returns
    only boolean success + a truncated error, plus the last 4 chars of each
    key so you can map them to what Render has. Auth-gated: each call spends
    a real token per (key, model), and key suffixes are fingerprintable."""
    import asyncio as _asyncio
    from app.services.llm import GEMINI_FALLBACKS, GEMINI_MODEL, _gemini_keys

    def _suffix(v: str) -> str:
        return v[-4:] if v and len(v) >= 4 else "(empty)"

    keys = _gemini_keys()
    if not keys:
        return {"error": "no Gemini keys loaded"}

    models = [GEMINI_MODEL, *GEMINI_FALLBACKS]

    def _probe(api_key: str, model: str) -> dict:
        try:
            from google import genai
            from google.genai import types
            client = genai.Client(api_key=api_key)
            resp = client.models.generate_content(
                model=model,
                contents="Reply with the single word: ok",
                config=types.GenerateContentConfig(max_output_tokens=10),
            )
            return {"ok": True, "reply": (resp.text or "")[:40]}
        except Exception as e:
            return {"ok": False, "error": str(e)[:300]}

    results: list[dict] = []
    for key in keys:
        for model in models:
            outcome = await _asyncio.to_thread(_probe, key, model)
            results.append({
                "key_suffix": _suffix(key),
                "model": model,
                **outcome,
            })
    return {
        "keys_loaded": len(keys),
        "results": results,
    }


@app.get("/health")
async def health():
    # Booleans/counts only — never key material, not even suffixes (they let
    # an outsider fingerprint which keys rotate). Detailed per-key probing
    # lives behind auth at /diag/gemini.
    if settings.SUPABASE_JWT_SECRET:
        auth_mode = "strict" if settings.AUTH_ENFORCE_SIGNATURE else "shadow"
    else:
        auth_mode = "legacy"
    return {
        "status": "ok",
        "version": "0.2.0",
        "auth_mode": auth_mode,
        "gemini_keys_loaded": sum(bool(k) for k in (
            settings.GEMINI_API_KEY, settings.GEMINI_API_KEY_2, settings.GEMINI_API_KEY_3,
        )),
        "groq_configured": bool(settings.GROQ_API_KEY),
        "anthropic_configured": bool(settings.ANTHROPIC_API_KEY),
    }


if settings.ENVIRONMENT != "production":
    # Debug routes — only mounted outside production. Still require auth so a dev
    # environment shared on the public internet can't leak key prefixes to anyone.
    @app.get("/debug/keys")
    async def debug_keys(user: dict = Depends(require_user)):
        import os

        def _state(value: str) -> str:
            return "set" if value else "NOT SET"

        hf_env = os.environ.get("HUGGINGFACE_API_KEY", "")
        gem_env = os.environ.get("GEMINI_API_KEY", "")
        return {
            "environment": settings.ENVIRONMENT,
            "huggingface_env": _state(hf_env),
            "gemini_env": _state(gem_env),
            "settings_huggingface": _state(settings.HUGGINGFACE_API_KEY),
            "settings_gemini": _state(settings.GEMINI_API_KEY),
        }
