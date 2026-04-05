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
            import google.generativeai  # noqa: F401
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
            import google.generativeai  # noqa: F401
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
            import google.generativeai  # noqa: F401
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
# Gemini implementation
# Uses google-generativeai (stable SDK). Model: gemini-1.5-flash (production)
# ---------------------------------------------------------------------------

GEMINI_MODEL = "gemini-1.5-flash"


async def _gemini_text(prompt: str, system: Optional[str], max_tokens: int) -> str:
    import google.generativeai as genai
    genai.configure(api_key=settings.GEMINI_API_KEY)

    full_prompt = f"{system}\n\n{prompt}" if system else prompt
    model = genai.GenerativeModel(
        GEMINI_MODEL,
        generation_config=genai.GenerationConfig(max_output_tokens=max_tokens),
    )

    def _run():
        response = model.generate_content(
            full_prompt,
            request_options={"timeout": 120},
        )
        return response.text

    return await asyncio.wait_for(asyncio.to_thread(_run), timeout=130)


async def _gemini_vision(
    image_bytes: bytes,
    media_type: str,
    prompt: str,
    system: Optional[str],
    max_tokens: int,
) -> str:
    import google.generativeai as genai
    import PIL.Image
    import io

    genai.configure(api_key=settings.GEMINI_API_KEY)
    image = PIL.Image.open(io.BytesIO(image_bytes))
    full_prompt = f"{system}\n\n{prompt}" if system else prompt
    model = genai.GenerativeModel(
        GEMINI_MODEL,
        generation_config=genai.GenerationConfig(max_output_tokens=max_tokens),
    )

    def _run():
        response = model.generate_content(
            [full_prompt, image],
            request_options={"timeout": 120},
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

    def _run():
        return client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=messages,
            max_tokens=min(max_tokens, 8000),
        ).choices[0].message.content

    return await asyncio.to_thread(_run)


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
            model="llama-3.2-90b-vision-preview",
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
            import google.generativeai as genai
            genai.configure(api_key=settings.GEMINI_API_KEY)
            full_prompt = f"{system}\n\n{prompt}" if system else prompt
            model = genai.GenerativeModel(
                GEMINI_MODEL,
                generation_config=genai.GenerationConfig(max_output_tokens=max_tokens),
            )
            return model.generate_content(full_prompt, request_options={"timeout": 120}).text
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
            return client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=messages,
                max_tokens=min(max_tokens, 8000),
            ).choices[0].message.content
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
            import google.generativeai as genai
            import PIL.Image
            genai.configure(api_key=settings.GEMINI_API_KEY)
            image = PIL.Image.open(io.BytesIO(image_bytes))
            full_prompt = f"{system}\n\n{prompt}" if system else prompt
            model = genai.GenerativeModel(
                GEMINI_MODEL,
                generation_config=genai.GenerationConfig(max_output_tokens=max_tokens),
            )
            return model.generate_content(
                [full_prompt, image],
                request_options={"timeout": 120},
            ).text
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
                model="llama-3.2-90b-vision-preview",
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
