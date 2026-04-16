import logging

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1 import router as api_router
from app.core.auth import require_user
from app.core.config import settings

logger = logging.getLogger(__name__)

app = FastAPI(
    title="BuildAI API",
    description="AI-powered blueprint analysis and construction estimating",
    version="0.1.0",
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


@app.get("/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}


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
