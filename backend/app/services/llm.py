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

    # Public-facing error — don't name Anthropic or hint at billing; this
    # surface is shown to the contractor, not the operator.
    raise RuntimeError(
        f"AI providers are temporarily unavailable. Please retry in a moment. "
        f"(internal: {'; '.join(errors)[:500]})"
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
        f"AI providers are temporarily unavailable. Please retry in a moment. "
        f"(internal: {'; '.join(errors)[:500]})"
    )


# ---------------------------------------------------------------------------
# Gemini implementation — uses new google-genai SDK (google.genai)
# ---------------------------------------------------------------------------

GEMINI_MODEL = "gemini-2.5-flash"
# Ordered fallbacks — each has its own free-tier quota bucket, so cycling through
# them buys us several rounds of retries on a busy day.
GEMINI_FALLBACKS = [
    "gemini-2.0-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-lite",
]
# Back-compat alias (some code paths import this directly)
GEMINI_FALLBACK_MODEL = GEMINI_FALLBACKS[0]


def _gemini_keys() -> list[str]:
    """Return every non-empty Gemini key in priority order. Multi-key lets us
    rotate across accounts when free-tier load-shedding 503s one of them —
    each account routes through different shards so key B usually serves
    when key A is throttled."""
    return [k for k in (settings.GEMINI_API_KEY,
                        settings.GEMINI_API_KEY_2,
                        settings.GEMINI_API_KEY_3) if k]


def _is_gemini_retryable(err_msg: str) -> bool:
    """Return True if the Gemini error is transient — quota exhaustion, model
    retirement, load shedding (503), or per-minute rate limit (429). We cycle
    the (key × model) matrix for any of these instead of hard-failing.

    The 429 case is the one that used to escape: Gemini's free tier throws
    429 / "Too Many Requests" for per-minute limits (distinct from daily
    RESOURCE_EXHAUSTED), and without it here the request would raise before
    ever rotating to the second key."""
    m = err_msg or ""
    ml = m.lower()
    return (
        "RESOURCE_EXHAUSTED" in m
        or "quota" in ml
        or "404" in m
        or "NOT_FOUND" in m
        or "UNAVAILABLE" in m
        or "503" in m
        or "429" in m
        or "rate limit" in ml
        or "rate_limit" in ml
        or "too many requests" in ml
        or "500" in m
        or "502" in m
        or "INTERNAL" in m
        or "DEADLINE_EXCEEDED" in m
        or "deadline" in ml
        or "overloaded" in ml
        or "high demand" in ml
        or "try again later" in ml
    )


# Hard ceiling so Groq's smallest model (8b-instant, ~6k TPM on free tier)
# doesn't get a monster prompt and 413. Roughly 4 chars ≈ 1 token.
_GROQ_PROMPT_CHAR_LIMIT = 15000


def _gemini_client():
    from google import genai
    return genai.Client(api_key=settings.GEMINI_API_KEY)


async def _gemini_text(prompt: str, system: Optional[str], max_tokens: int) -> str:
    from google import genai
    from google.genai import types

    full_prompt = f"{system}\n\n{prompt}" if system else prompt

    def _run(api_key: str, model: str):
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model=model,
            contents=full_prompt,
            config=types.GenerateContentConfig(max_output_tokens=max_tokens),
        )
        return response.text

    # (key × model) matrix. For each key, walk the model chain; on
    # retryable errors (quota / 404 / 503) rotate to the next model,
    # then the next key. Two passes total so a transient Google
    # overload window is survived end-to-end.
    keys = _gemini_keys()
    models = [GEMINI_MODEL, *GEMINI_FALLBACKS]
    last_err: Exception = RuntimeError("no Gemini keys configured")
    for pass_idx in range(2):
        for key in keys:
            for model in models:
                try:
                    return await asyncio.wait_for(asyncio.to_thread(_run, key, model), timeout=130)
                except Exception as e:
                    last_err = e
                    if _is_gemini_retryable(str(e)):
                        await asyncio.sleep(0.6 if pass_idx == 0 else 2.0)
                        continue
                    raise
        if pass_idx == 0 and keys:
            await asyncio.sleep(1.5)
    raise last_err


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

    def _run(api_key: str, model: str):
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model=model,
            contents=[
                types.Part.from_bytes(data=image_bytes, mime_type=media_type),
                full_prompt,
            ],
            config=types.GenerateContentConfig(max_output_tokens=max_tokens),
        )
        return response.text

    keys = _gemini_keys()
    models = [GEMINI_MODEL, *GEMINI_FALLBACKS]
    last_err: Exception = RuntimeError("no Gemini keys configured")
    for pass_idx in range(2):
        for key in keys:
            for model in models:
                try:
                    return await asyncio.wait_for(asyncio.to_thread(_run, key, model), timeout=130)
                except Exception as e:
                    last_err = e
                    if _is_gemini_retryable(str(e)):
                        await asyncio.sleep(0.6 if pass_idx == 0 else 2.0)
                        continue
                    raise
        if pass_idx == 0 and keys:
            await asyncio.sleep(1.5)
    raise last_err


# ---------------------------------------------------------------------------
# Groq implementation
# ---------------------------------------------------------------------------

def _truncate_for_groq(prompt: str, system: Optional[str], char_limit: int) -> str:
    """
    Groq's free-tier 8b-instant has a hard ~6k TPM cap. Anything over ~15k
    chars of user content will 413. When the prompt is over budget, keep the
    first 60% and last 40% (task intro + JSON schema / tail instructions) and
    drop the middle — typically the research dump, which we'd rather sacrifice
    than lose the task definition or output contract.
    """
    system_len = len(system) if system else 0
    budget = max(2000, char_limit - system_len - 500)  # 500 chars for marker
    if len(prompt) <= budget:
        return prompt
    head = int(budget * 0.6)
    tail = budget - head
    marker = "\n\n…[research truncated to fit fallback model]…\n\n"
    return prompt[:head] + marker + prompt[-tail:]


async def _groq_text(prompt: str, system: Optional[str], max_tokens: int) -> str:
    from groq import Groq
    client = Groq(api_key=settings.GROQ_API_KEY)

    def _call(model: str, user_prompt: str) -> str:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user_prompt})
        return client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=min(max_tokens, 8000),
        ).choices[0].message.content

    # Try 70b first. On 413, switch to 8b-instant WITH an aggressively
    # truncated prompt — 8b's free-tier TPM cap is so small that a real
    # research-heavy prompt always 413s at full size.
    try:
        return await asyncio.to_thread(_call, "llama-3.3-70b-versatile", prompt)
    except Exception as e:
        msg = str(e)
        too_big = ("413" in msg or "too large" in msg.lower() or "rate_limit_exceeded" in msg)
        if not too_big:
            raise
    short = _truncate_for_groq(prompt, system, _GROQ_PROMPT_CHAR_LIMIT)
    try:
        return await asyncio.to_thread(_call, "llama-3.1-8b-instant", short)
    except Exception as e:
        msg = str(e)
        if "413" in msg or "rate_limit_exceeded" in msg:
            # One more aggressive trim — halve the budget and retry.
            shorter = _truncate_for_groq(prompt, system, _GROQ_PROMPT_CHAR_LIMIT // 2)
            return await asyncio.to_thread(_call, "llama-3.1-8b-instant", shorter)
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

    kwargs = {"model": "claude-sonnet-4-6", "max_tokens": max_tokens,
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
    kwargs = {"model": "claude-sonnet-4-6", "max_tokens": max_tokens,
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

    if _gemini_keys():
        try:
            from google import genai
            from google.genai import types
            import time as _time
            full_prompt = f"{system}\n\n{prompt}" if system else prompt
            keys = _gemini_keys()
            models = [GEMINI_MODEL, *GEMINI_FALLBACKS]
            last_me: Exception = RuntimeError("no Gemini attempt made")
            for pass_idx in range(2):
                for key in keys:
                    client = genai.Client(api_key=key)
                    for model in models:
                        try:
                            response = client.models.generate_content(
                                model=model,
                                contents=full_prompt,
                                config=types.GenerateContentConfig(max_output_tokens=max_tokens),
                            )
                            return response.text
                        except Exception as me:
                            last_me = me
                            if _is_gemini_retryable(str(me)):
                                _time.sleep(0.6 if pass_idx == 0 else 2.0)
                                continue
                            raise
                if pass_idx == 0:
                    _time.sleep(1.5)
            raise last_me
        except Exception as e:
            errors.append(f"Gemini: {e}")

    if settings.GROQ_API_KEY:
        try:
            from groq import Groq
            client = Groq(api_key=settings.GROQ_API_KEY)

            def _groq_call(model: str, user_prompt: str) -> str:
                msgs = []
                if system:
                    msgs.append({"role": "system", "content": system})
                msgs.append({"role": "user", "content": user_prompt})
                return client.chat.completions.create(
                    model=model,
                    messages=msgs,
                    max_tokens=min(max_tokens, 8000),
                ).choices[0].message.content

            try:
                return _groq_call("llama-3.3-70b-versatile", prompt)
            except Exception as me:
                m = str(me)
                if not ("413" in m or "too large" in m.lower() or "rate_limit_exceeded" in m):
                    raise
            short = _truncate_for_groq(prompt, system, _GROQ_PROMPT_CHAR_LIMIT)
            try:
                return _groq_call("llama-3.1-8b-instant", short)
            except Exception as me:
                m = str(me)
                if "413" in m or "rate_limit_exceeded" in m:
                    shorter = _truncate_for_groq(prompt, system, _GROQ_PROMPT_CHAR_LIMIT // 2)
                    return _groq_call("llama-3.1-8b-instant", shorter)
                raise
        except Exception as e:
            errors.append(f"Groq: {e}")

    if settings.ANTHROPIC_API_KEY:
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
            kwargs = {"model": "claude-sonnet-4-6", "max_tokens": max_tokens,
                      "messages": [{"role": "user", "content": prompt}]}
            if system:
                kwargs["system"] = system
            return client.messages.create(**kwargs).content[0].text
        except Exception as e:
            errors.append(f"Anthropic: {e}")

    raise RuntimeError(
        f"AI providers are temporarily unavailable. Please retry in a moment. "
        f"(internal: {'; '.join(errors)[:500]})"
    )


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

    if _gemini_keys():
        try:
            from google import genai
            from google.genai import types
            import time as _time
            full_prompt = f"{system}\n\n{prompt}" if system else prompt
            keys = _gemini_keys()
            models = [GEMINI_MODEL, *GEMINI_FALLBACKS]
            last_me: Exception = RuntimeError("no Gemini vision attempt made")
            for pass_idx in range(2):
                for key in keys:
                    client = genai.Client(api_key=key)
                    for model in models:
                        try:
                            response = client.models.generate_content(
                                model=model,
                                contents=[
                                    types.Part.from_bytes(data=image_bytes, mime_type=media_type),
                                    full_prompt,
                                ],
                                config=types.GenerateContentConfig(max_output_tokens=max_tokens),
                            )
                            return response.text
                        except Exception as me:
                            last_me = me
                            if _is_gemini_retryable(str(me)):
                                _time.sleep(0.6 if pass_idx == 0 else 2.0)
                                continue
                            raise
                if pass_idx == 0:
                    _time.sleep(1.5)
            raise last_me
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
            kwargs = {"model": "claude-sonnet-4-6", "max_tokens": max_tokens,
                      "messages": [{"role": "user", "content": content}]}
            if system:
                kwargs["system"] = system
            return client.messages.create(**kwargs).content[0].text
        except Exception as e:
            errors.append(f"Anthropic: {e}")

    raise RuntimeError(
        f"AI vision providers are temporarily unavailable. Please retry in a moment. "
        f"(internal: {'; '.join(errors)[:500]})"
    )
