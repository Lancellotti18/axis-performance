from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.core.config import settings
from app.api.v1 import router as api_router

app = FastAPI(
    title="BuildAI API",
    description="AI-powered blueprint analysis and construction estimating",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Catch all unhandled exceptions so they pass through CORSMiddleware
# (unhandled exceptions bypass CORSMiddleware and return 500 with no CORS headers,
# causing browsers to throw TypeError: Failed to fetch instead of seeing the error)
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # @app.exception_handler(Exception) runs inside ServerErrorMiddleware, which is
    # OUTSIDE CORSMiddleware in the Starlette stack — so CORS headers are never added
    # automatically. We must set them explicitly here.
    origin = request.headers.get("origin", "*")
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
        headers={
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "false",
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
        },
    )

app.include_router(api_router, prefix="/api/v1")


@app.get("/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}

@app.get("/debug/keys")
async def debug_keys():
    import os
    return {
        "HUGGINGFACE_API_KEY": "set" if os.environ.get("HUGGINGFACE_API_KEY") else "NOT SET",
        "HUGGINGFACE_API_KEY_starts_with": os.environ.get("HUGGINGFACE_API_KEY","")[:6] or "empty",
        "GEMINI_API_KEY": "set" if os.environ.get("GEMINI_API_KEY") else "NOT SET",
        "settings_hf": "set" if settings.HUGGINGFACE_API_KEY else "NOT SET",
        "settings_hf_starts_with": settings.HUGGINGFACE_API_KEY[:6] if settings.HUGGINGFACE_API_KEY else "empty",
    }

@app.post("/debug/test-hf")
async def debug_test_hf():
    import os, httpx
    key = os.environ.get("HUGGINGFACE_API_KEY") or settings.HUGGINGFACE_API_KEY or ""
    if not key:
        return {"error": "no key found"}
    # Ping HF API with a tiny payload
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                "https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={"inputs": "a house", "parameters": {"num_inference_steps": 1}},
            )
            return {"status": r.status_code, "body": r.text[:300], "key_prefix": key[:8]}
    except Exception as e:
        return {"error": str(e), "key_prefix": key[:8]}
