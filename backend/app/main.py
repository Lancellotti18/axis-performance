import os
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
    title="Axis Roofing Performance API",
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
    # Make it visible somewhere other than a console nobody is watching.
    from app.core.errors import record
    record(exc, path=request.url.path, method=request.method,
           context={"query": str(request.url.query)[:200]})
    origin = request.headers.get("origin", "")
    allowed = origin if origin in settings.allowed_origins_list else ""
    detail = str(exc) if settings.ENVIRONMENT != "production" else "Internal server error"
    headers = {}
    if allowed:
        headers["Access-Control-Allow-Origin"] = allowed
        headers["Access-Control-Allow-Credentials"] = "true"
    return JSONResponse(status_code=500, content={"detail": detail}, headers=headers)


app.include_router(api_router, prefix="/api/v1")

# This used to fire whenever SUPABASE_JWT_SECRET was unset — which is now the
# NORMAL, correct configuration, because tokens are verified against the
# project's published keys instead. Warn on the real condition: no usable key
# source at all.
if _IS_PROD:
    from app.core.auth import auth_key_source
    if auth_key_source() == "none":
        logger.critical(
            "No JWT key source available in production — tokens are NOT being "
            "verified. Set SUPABASE_URL (for published keys) or "
            "SUPABASE_JWT_SECRET, and AUTH_ENFORCE_SIGNATURE=true."
        )


@app.get("/diag/errors")
async def diag_errors(limit: int = 25, user: dict = Depends(require_user)):
    """Recent unhandled failures, newest first, with a summary.

    Authenticated because tracebacks leak internals. In-memory, so it resets on
    deploy — this answers "what is breaking right now", not "what broke last
    week". Set SENTRY_DSN for durable history; no code change needed.
    """
    from app.core.errors import recent, summary
    return {"summary": summary(), "errors": recent(min(limit, 100))}


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


@app.get("/health/deep")
async def health_deep(request: Request, images: int = 1):
    """Does Axis actually still WORK? Not: is it configured.

    /health counts non-empty environment variables. That is useful for spotting
    a missing key, and useless for the failure that has actually bitten Axis:
    Google retiring a model. The model names in llm.py are hardcoded, two of the
    four fallbacks are 2.0-generation, and on the day they are retired /health
    still reports status: ok and gemini_keys_loaded: 3 while every roof
    detection fails. This endpoint calls the providers and renders a real PDF,
    so it fails when the product fails.

    Auth is a shared secret rather than a user token, so the morning routine
    needs no test account and no stored password.

    `?images=0` skips the image-generation probes. They are the only ones that
    cost real money per run (four billed generations), so the lever exists
    without needing a code change — e.g. run them weekly rather than daily. Unset secret = disabled, not
    open: this endpoint spends real tokens and burns CPU, so an unconfigured
    deploy must not leave it callable by anyone.
    """
    import asyncio as _asyncio
    import secrets as _secrets

    expected = settings.HEALTH_CHECK_SECRET
    if not expected:
        raise HTTPException(status_code=503, detail="Deep health check is not configured.")
    provided = request.headers.get("x-health-secret") or ""
    # Constant-time: a plain == leaks the secret one character at a time to
    # anyone willing to measure the response.
    if not _secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Bad or missing health secret.")

    # ?images=0 turns off the only probes that cost real money per run.
    include_images = bool(images)

    problems: list[str] = []
    checks: dict = {}

    # ── 1. Gemini: every key against every model we actually call ──────────
    from app.services.llm import GEMINI_FALLBACKS, GEMINI_MODEL, _gemini_keys

    def _probe_gemini(api_key: str, model: str) -> dict:
        try:
            from google import genai
            from google.genai import types
            client = genai.Client(api_key=api_key)
            cfg: dict = {"max_output_tokens": 64}
            # Mirror _gemini_text: without this a 2.5 model spends the whole
            # token budget thinking and returns empty text, which the probe
            # would report as a dead model. Match how Axis really calls it.
            from app.services.llm import _thinks
            if _thinks(model):
                cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
            resp = client.models.generate_content(
                model=model, contents="Reply with the single word: ok",
                config=types.GenerateContentConfig(**cfg),
            )
            text = (resp.text or "").strip()
            if text:
                return {"ok": True}
            # Reachable but empty is NOT the same as retired — say which.
            reason = "empty response"
            try:
                cand = (getattr(resp, "candidates", None) or [None])[0]
                fr = getattr(cand, "finish_reason", None)
                if fr is not None:
                    reason = f"empty response (finish_reason={fr})"
            except Exception:
                pass
            return {"ok": False, "error": reason}
        except Exception as e:
            return {"ok": False, "error": str(e)[:200]}

    keys = _gemini_keys()
    models = [GEMINI_MODEL, *GEMINI_FALLBACKS]
    gem: list[dict] = []
    for i, key in enumerate(keys):
        for model in models:
            r = await _asyncio.to_thread(_probe_gemini, key, model)
            gem.append({"key_index": i, "model": model, **r})
    working_models = sorted({g["model"] for g in gem if g["ok"]})
    checks["gemini"] = {
        "keys_loaded": len(keys),
        "models_tried": models,
        "models_working": working_models,
        "probes": gem,
    }
    if not keys:
        problems.append("CRITICAL: no Gemini keys loaded.")
    elif not working_models:
        problems.append(
            "CRITICAL: every Gemini key/model pair failed. Axis cannot measure roofs. "
            "Check whether the models in llm.py have been retired by Google."
        )
    else:
        missing = [m for m in models if m not in working_models]
        if GEMINI_MODEL not in working_models:
            problems.append(
                f"HIGH: the primary model {GEMINI_MODEL} is failing; running on fallbacks only."
            )
        if missing:
            problems.append(
                f"WARN: these models no longer answer: {', '.join(missing)}. "
                "Likely retired by Google — replace them in GEMINI_FALLBACKS before the rest go."
            )

    # ── 2. The fallback floor: Groq and Anthropic ──────────────────────────
    def _probe_groq() -> dict:
        if not settings.GROQ_API_KEY:
            return {"ok": False, "error": "not configured"}
        try:
            from groq import Groq
            client = Groq(api_key=settings.GROQ_API_KEY)
            # Both models llm.py actually calls, primary first. Probing only
            # the fallback reported a working Groq as dead.
            errs = []
            for model in ("llama-3.3-70b-versatile", "llama-3.1-8b-instant"):
                try:
                    client.chat.completions.create(
                        model=model,
                        messages=[{"role": "user", "content": "say ok"}], max_tokens=5)
                    return {"ok": True, "model": model,
                            "degraded": model != "llama-3.3-70b-versatile",
                            "errors": errs or None}
                except Exception as e:
                    errs.append(f"{model}: {str(e)[:120]}")
            return {"ok": False, "error": " | ".join(errs)}
        except Exception as e:
            return {"ok": False, "error": str(e)[:200]}

    def _probe_anthropic() -> dict:
        if not settings.ANTHROPIC_API_KEY:
            return {"ok": False, "error": "not configured"}
        try:
            import anthropic
            anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY).messages.create(
                model="claude-haiku-4-5", max_tokens=5,
                messages=[{"role": "user", "content": "say ok"}])
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)[:200]}

    checks["groq"] = await _asyncio.to_thread(_probe_groq)
    checks["anthropic"] = await _asyncio.to_thread(_probe_anthropic)
    if not checks["groq"]["ok"] and not checks["anthropic"]["ok"]:
        problems.append(
            "HIGH: both fallback providers are down, so Gemini has no safety net. "
            f"groq: {checks['groq'].get('error')} | anthropic: {checks['anthropic'].get('error')}"
        )
    elif not checks["anthropic"]["ok"]:
        problems.append(
            f"WARN: Anthropic (last fallback) is unavailable — {checks['anthropic'].get('error')}. "
            "Out-of-credit shows up here."
        )

    # ── 3. Render a real report from one fixed run ─────────────────────────
    run_id = settings.HEALTH_CHECK_RUN_ID
    if not run_id:
        checks["report_render"] = {"ok": None, "skipped": "HEALTH_CHECK_RUN_ID not set"}
        problems.append(
            "WARN: report generation is NOT being checked. Set HEALTH_CHECK_RUN_ID "
            "to a finished roof run so this proves the renderer still works."
        )
    else:
        try:
            from app.api.v1.roofing_v2 import _build_and_store_report
            # user_id omitted on purpose: no billing row for a health probe.
            pdf, _fn, _url = await _build_and_store_report(run_id)
            ok = pdf[:4] == b"%PDF" and len(pdf) > 20_000
            checks["report_render"] = {"ok": ok, "bytes": len(pdf), "run_id": run_id}
            if not ok:
                problems.append(
                    f"CRITICAL: report renderer produced {len(pdf)} bytes that do not look "
                    "like a PDF. Contractors cannot generate reports."
                )
        except Exception as e:
            checks["report_render"] = {"ok": False, "run_id": run_id, "error": str(e)[:300]}
            problems.append(f"CRITICAL: report generation raised — {str(e)[:200]}")

    # ── 4. Image generation — FOUR providers on their own keys ────────────
    # Probed individually, not as a chain. The chain short-circuits on the
    # first success, so a working fal.ai hides three dead providers behind it
    # and the failure only surfaces the day fal goes down. This chain also
    # RAISES when exhausted rather than degrading (see visualizer_service:
    # "No text-to-image fallback"), so the Roof Visualizer breaks outright.
    if include_images:
        from app.services import visualizer_service as vis

        def _swatch() -> bytes:
            """Smallest image the providers will accept — this is billed per
            generation, so there is no reason to send a large one."""
            import io
            from PIL import Image
            buf = io.BytesIO()
            Image.new("RGB", (256, 256), (150, 150, 155)).save(buf, format="PNG")
            return buf.getvalue()

        img_bytes = _swatch()
        prompt = "change the roof shingles to dark grey"
        providers = [
            ("fal",       vis._fal_key,    lambda: vis._fal_img2img(img_bytes, "image/png", prompt)),
            ("gemini",    vis._gemini_key, lambda: vis._gemini_img2img(img_bytes, "image/png", prompt)),
            ("huggingface", vis._hf_key,   lambda: vis._hf_img2img(img_bytes, prompt)),
            ("replicate", vis._rep_key,    lambda: vis._replicate_img2img(img_bytes, "image/png", prompt)),
        ]
        img_results: dict = {}
        for name, keyfn, call in providers:
            if not keyfn():
                img_results[name] = {"ok": False, "error": "no key configured"}
                continue
            try:
                out = await call()
                img_results[name] = {"ok": bool(out), "returned": bool(out)}
            except Exception as e:
                img_results[name] = {"ok": False, "error": str(e)[:200]}
        checks["image_generation"] = img_results
        working_img = [n for n, r in img_results.items() if r.get("ok")]
        if not working_img:
            problems.append(
                "CRITICAL: every image provider failed — the Roof Visualizer is down. "
                "That chain raises rather than falling back, so contractors get an error."
            )
        elif len(working_img) == 1:
            dead = ", ".join(f"{n} ({img_results[n].get('error')})"
                             for n in img_results if n not in working_img)
            problems.append(
                f"HIGH: the Roof Visualizer is running on ONE provider ({working_img[0]}). "
                f"Down: {dead}. If it fails the visualizer stops entirely."
            )
        elif len(working_img) < len(providers):
            dead = ", ".join(n for n in img_results if n not in working_img)
            problems.append(f"WARN: image providers unavailable: {dead}.")
    else:
        checks["image_generation"] = {"skipped": "images=0"}

    # ── 5. Storm Risk Report — exercises llm_text AND Tavily search ───────
    try:
        from app.services.risk_score_service import get_risk_score
        storm = await get_risk_score("Wilmington", "NC")
        hazards = storm.get("hazards") or storm.get("scores") or {}
        ok = bool(hazards)
        checks["storm_report"] = {"ok": ok, "hazards_returned": len(hazards) if hazards else 0}
        if not ok:
            problems.append(
                "HIGH: the Storm Risk Report returned no hazard scores. Either the "
                "model call failed or Tavily returned nothing to ground it in."
            )
    except Exception as e:
        checks["storm_report"] = {"ok": False, "error": str(e)[:300]}
        problems.append(f"HIGH: Storm Risk Report raised — {str(e)[:200]}")

    return {
        "healthy": not problems,
        "problem_count": len(problems),
        "problems": problems,
        "checks": checks,
    }


@app.get("/health")
async def health():
    # Booleans/counts only — never key material, not even suffixes (they let
    # an outsider fingerprint which keys rotate). Detailed per-key probing
    # lives behind auth at /diag/gemini.
    # Reflect the key source that will ACTUALLY be used. Reporting on the
    # shared secret alone said "strict" for a project whose tokens no secret
    # could ever verify — the config looked correct while every request 401'd.
    from app.core.auth import auth_key_source
    key_source = auth_key_source()
    if key_source != "none":
        auth_mode = "strict" if settings.AUTH_ENFORCE_SIGNATURE else "shadow"
    else:
        auth_mode = "legacy"
    return {
        "status": "ok",
        "version": "0.2.0",
        # Render injects RENDER_GIT_COMMIT on every deploy. Without it there is no
        # way to tell a freshly-deployed container from a stale one still serving
        # old code — /health returned 200 either way, which has already caused a
        # deploy to be reported as live when it was not.
        "commit": (os.getenv("RENDER_GIT_COMMIT") or "unknown")[:7],
        "auth_mode": auth_mode,
        "auth_key_source": key_source,   # "jwks" | "secret" | "none"
        "gemini_keys_loaded": sum(bool(k) for k in (
            settings.GEMINI_API_KEY, settings.GEMINI_API_KEY_2, settings.GEMINI_API_KEY_3,
        )),
        "groq_configured": bool(settings.GROQ_API_KEY),
        "anthropic_configured": bool(settings.ANTHROPIC_API_KEY),
        # Whether Google Solar can be consulted at all. Without it every traced
        # facet keeps the bare 6/12 default, and there was no way to tell that
        # from the outside — the pitch simply looked measured when it was not.
        "solar_configured": bool(settings.GOOGLE_SOLAR_API_KEY),
        "tavily_configured": bool(settings.TAVILY_API_KEY),
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
