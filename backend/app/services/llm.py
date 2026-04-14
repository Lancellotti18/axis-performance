"""
Unified LLM client.

Priority:
  1. Google Gemini (free — AI Studio key, 1.5M tokens/day)
  2. Groq (free — very fast, good for simple tasks)
  3. Anthropic Claude (paid — fallback if no free keys set)

Usage:
    from app.services.llm import llm_text, llm_vision

    result = await llm_text("Your prompt here")
    result = await llm_vision(image_bytes, "image/jpeg", "Analyze this blueprint")
"""
import asyncio
import base64
import json
import os
import re
from typing import Optional

from app.core.config import settings


# ---------------------------------------------------------------------------
# Provider detection
# ---------------------------------------------------------------------------

def _provider() -> str:
    if settings.GEMINI_API_KEY:
        try:
            from google import genai  # noqa: F401
            return "gemini"
        except ImportError:
            pass  # package not installed yet, try next
    if settings.GROQ_API_KEY:
        try:
            import groq  # noqa: F401
            return "groq"
        except ImportError:
            pass
    if settings.ANTHROPIC_API_KEY:
        return "anthropic"
    raise RuntimeError(
        "No LLM API key configured. Set GEMINI_API_KEY (free at aistudio.google.com) in your Render environment."
    )


# ---------------------------------------------------------------------------
# Text-only completions
# ---------------------------------------------------------------------------

async def llm_text(
    prompt: str,
    system: Optional[str] = None,
    max_tokens: int = 8192,
    json_mode: bool = False,
) -> str:
    """
    Run a text prompt. Tries providers in priority order with automatic fallback.
    Gemini → Groq → Claude. Raises only if ALL configured providers fail.
    """
    errors = []

    if settings.GEMINI_API_KEY:
        try:
            from google import genai  # noqa: F401
            return await _gemini_text(prompt, system, max_tokens)
        except Exception as e:
            errors.append(f"Gemini: {e}")

    if settings.GROQ_API_KEY:
        try:
            import groq  # noqa: F401
            return await _groq_text(prompt, system, max_tokens)
        except Exception as e:
            errors.append(f"Groq: {e}")

    if settings.ANTHROPIC_API_KEY:
        try:
            return await _anthropic_text(prompt, system, max_tokens)
        except Exception as e:
            errors.append(f"Anthropic: {e}")

    raise RuntimeError(
        f"All LLM providers failed. Set GEMINI_API_KEY (free at aistudio.google.com). "
        f"Errors: {'; '.join(errors)}"
    )


# ---------------------------------------------------------------------------
# Vision (image + text)
# ---------------------------------------------------------------------------

async def llm_vision(
    image_bytes: bytes,
    media_type: str,
    prompt: str,
    system: Optional[str] = None,
    max_tokens: int = 8192,
) -> str:
    """
    Analyze an image with a text prompt. Tries providers in priority order with automatic fallback.
    Gemini → Groq (vision) → Claude. Raises only if ALL configured providers fail.
    """
    errors = []

    if settings.GEMINI_API_KEY:
        try:
            from google import genai  # noqa: F401
            return await _gemini_vision(image_bytes, media_type, prompt, system, max_tokens)
        except Exception as e:
            errors.append(f"Gemini: {e}")

    if settings.GROQ_API_KEY:
        try:
            import groq  # noqa: F401
            return await _groq_vision(image_bytes, media_type, prompt, system, max_tokens)
        except Exception as e:
            errors.append(f"Groq: {e}")

    if settings.ANTHROPIC_API_KEY:
        try:
            return await _anthropic_vision(image_bytes, media_type, prompt, system, max_tokens)
        except Exception as e:
            errors.append(f"Anthropic: {e}")

    raise RuntimeError(
        f"All LLM providers failed. Set GEMINI_API_KEY (free at aistudio.google.com). "
        f"Errors: {'; '.join(errors)}"
    )


# ---------------------------------------------------------------------------
# Gemini implementation — uses new google-genai SDK (google.genai)
# ---------------------------------------------------------------------------

GEMINI_MODEL = "gemini-2.0-flash"
GEMINI_FALLBACK_MODEL = "gemini-1.5-flash"  # separate quota, used when 2.0-flash daily limit hit


def _gemini_client():
    from google import genai
    return genai.Client(api_key=settings.GEMINI_API_KEY)


async def _gemini_text(prompt: str, system: Optional[str], max_tokens: int) -> str:
    from google import genai
    from google.genai import types

    full_prompt = f"{system}\n\n{prompt}" if system else prompt

    def _run(model: str):
        client = genai.Client(api_key=settings.GEMINI_API_KEY)
        response = client.models.generate_content(
            model=model,
            contents=full_prompt,
            config=types.GenerateContentConfig(max_output_tokens=max_tokens),
        )
        return response.text

    # Try primary model first; if daily quota exhausted (RESOURCE_EXHAUSTED), fall back
    try:
        return await asyncio.wait_for(asyncio.to_thread(_run, GEMINI_MODEL), timeout=130)
    except Exception as e:
        if "RESOURCE_EXHAUSTED" in str(e) or "quota" in str(e).lower():
            return await asyncio.wait_for(asyncio.to_thread(_run, GEMINI_FALLBACK_MODEL), timeout=130)
        raise


async def _gemini_vision(
    image_bytes: bytes,
    media_type: str,
    prompt: str,
    system: Optional[str],
    max_tokens: int,
) -> str:
    from google import genai
    from google.genai import types

    full_prompt = f"{system}\n\n{prompt}" if system else prompt

    def _run():
        client = genai.Client(api_key=settings.GEMINI_API_KEY)
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                types.Part.from_bytes(data=image_bytes, mime_type=media_type),
                full_prompt,
            ],
            config=types.GenerateContentConfig(max_output_tokens=max_tokens),
        )
        return response.text

    return await asyncio.wait_for(asyncio.to_thread(_run), timeout=130)


# ---------------------------------------------------------------------------
# Groq implementation
# ---------------------------------------------------------------------------

async def _groq_text(prompt: str, system: Optional[str], max_tokens: int) -> str:
    from groq import Groq
    client = Groq(api_key=settings.GROQ_API_KEY)

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    def _run(model: str):
        return client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=min(max_tokens, 8000),
        ).choices[0].message.content

    # Primary: 70b versatile. On 413 (prompt too large), fall back to 8b-instant (20k TPM limit)
    try:
        return await asyncio.to_thread(_run, "llama-3.3-70b-versatile")
    except Exception as e:
        if "413" in str(e) or "too large" in str(e).lower() or "rate_limit_exceeded" in str(e):
            return await asyncio.to_thread(_run, "llama-3.1-8b-instant")
        raise


async def _groq_vision(
    image_bytes: bytes,
    media_type: str,
    prompt: str,
    system: Optional[str],
    max_tokens: int,
) -> str:
    from groq import Groq
    client = Groq(api_key=settings.GROQ_API_KEY)
    b64 = base64.standard_b64encode(image_bytes).decode()

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{b64}"}},
            {"type": "text", "text": prompt},
        ],
    })

    def _run():
        return client.chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=messages,
            max_tokens=min(max_tokens, 8000),
        ).choices[0].message.content

    return await asyncio.to_thread(_run)


# ---------------------------------------------------------------------------
# Anthropic (Claude) implementation — kept as fallback
# ---------------------------------------------------------------------------

async def _anthropic_text(prompt: str, system: Optional[str], max_tokens: int) -> str:
    import anthropic
    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

    kwargs = {"model": "claude-opus-4-6", "max_tokens": max_tokens,
              "messages": [{"role": "user", "content": prompt}]}
    if system:
        kwargs["system"] = system

    def _run():
        return client.messages.create(**kwargs).content[0].text

    return await asyncio.to_thread(_run)


async def _anthropic_vision(
    image_bytes: bytes,
    media_type: str,
    prompt: str,
    system: Optional[str],
    max_tokens: int,
) -> str:
    import anthropic
    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
    b64 = base64.standard_b64encode(image_bytes).decode()

    content = [
        {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
        {"type": "text", "text": prompt},
    ]
    kwargs = {"model": "claude-opus-4-6", "max_tokens": max_tokens,
              "messages": [{"role": "user", "content": content}]}
    if system:
        kwargs["system"] = system

    def _run():
        return client.messages.create(**kwargs).content[0].text

    return await asyncio.to_thread(_run)


# ---------------------------------------------------------------------------
# Sync wrappers — called from background threads, NO asyncio involved at all.
# Call each provider's SDK directly and synchronously.
# ---------------------------------------------------------------------------

def llm_text_sync(
    prompt: str,
    system: Optional[str] = None,
    max_tokens: int = 8192,
) -> str:
    """Synchronous LLM text call. Safe from any thread — no event loop needed."""
    errors = []

    if settings.GEMINI_API_KEY:
        try:
            from google import genai
            from google.genai import types
            full_prompt = f"{system}\n\n{prompt}" if system else prompt
            client = genai.Client(api_key=settings.GEMINI_API_KEY)
            for model in [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]:
                try:
                    response = client.models.generate_content(
                        model=model,
                        contents=full_prompt,
                        config=types.GenerateContentConfig(max_output_tokens=max_tokens),
                    )
                    return response.text
                except Exception as me:
                    if "RESOURCE_EXHAUSTED" in str(me) or "quota" in str(me).lower():
                        continue
                    raise
            raise RuntimeError("All Gemini models exhausted quota")
        except Exception as e:
            errors.append(f"Gemini: {e}")

    if settings.GROQ_API_KEY:
        try:
            from groq import Groq
            client = Groq(api_key=settings.GROQ_API_KEY)
            messages = []
            if system:
                messages.append({"role": "system", "content": system})
            messages.append({"role": "user", "content": prompt})
            for model in ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]:
                try:
                    return client.chat.completions.create(
                        model=model,
                        messages=messages,
                        max_tokens=min(max_tokens, 8000),
                    ).choices[0].message.content
                except Exception as me:
                    if "413" in str(me) or "too large" in str(me).lower() or "rate_limit_exceeded" in str(me):
                        continue
                    raise
            raise RuntimeError("All Groq models failed token limit")
        except Exception as e:
            errors.append(f"Groq: {e}")

    if settings.ANTHROPIC_API_KEY:
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
            kwargs = {"model": "claude-opus-4-6", "max_tokens": max_tokens,
                      "messages": [{"role": "user", "content": prompt}]}
            if system:
                kwargs["system"] = system
            return client.messages.create(**kwargs).content[0].text
        except Exception as e:
            errors.append(f"Anthropic: {e}")

    raise RuntimeError(f"All LLM providers failed: {'; '.join(errors)}")


def llm_vision_sync(
    image_bytes: bytes,
    media_type: str,
    prompt: str,
    system: Optional[str] = None,
    max_tokens: int = 8192,
) -> str:
    """Synchronous LLM vision call. Safe from any thread — no event loop needed."""
    import io
    errors = []

    if settings.GEMINI_API_KEY:
        try:
            from google import genai
            from google.genai import types
            full_prompt = f"{system}\n\n{prompt}" if system else prompt
            client = genai.Client(api_key=settings.GEMINI_API_KEY)
            response = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=[
                    types.Part.from_bytes(data=image_bytes, mime_type=media_type),
                    full_prompt,
                ],
                config=types.GenerateContentConfig(max_output_tokens=max_tokens),
            )
            return response.text
        except Exception as e:
            errors.append(f"Gemini: {e}")

    if settings.GROQ_API_KEY:
        try:
            import base64
            from groq import Groq
            client = Groq(api_key=settings.GROQ_API_KEY)
            b64 = base64.standard_b64encode(image_bytes).decode()
            messages = []
            if system:
                messages.append({"role": "system", "content": system})
            messages.append({"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{b64}"}},
                {"type": "text", "text": prompt},
            ]})
            return client.chat.completions.create(
                model="meta-llama/llama-4-scout-17b-16e-instruct",
                messages=messages,
                max_tokens=min(max_tokens, 8000),
            ).choices[0].message.content
        except Exception as e:
            errors.append(f"Groq: {e}")

    if settings.ANTHROPIC_API_KEY:
        try:
            import base64
            import anthropic
            client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
            b64 = base64.standard_b64encode(image_bytes).decode()
            content = [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                {"type": "text", "text": prompt},
            ]
            kwargs = {"model": "claude-opus-4-6", "max_tokens": max_tokens,
                      "messages": [{"role": "user", "content": content}]}
            if system:
                kwargs["system"] = system
            return client.messages.create(**kwargs).content[0].text
        except Exception as e:
            errors.append(f"Anthropic: {e}")

    raise RuntimeError(f"All LLM vision providers failed: {'; '.join(errors)}")
