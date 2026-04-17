"""
Voice-note transcription.

Accepts raw audio bytes (webm/ogg/mp3/wav from the browser's MediaRecorder)
and returns plain text. Uses Groq's Whisper endpoint — fastest real-time
transcription option among our existing providers. Falls back to Gemini
audio understanding if Groq is unavailable or returns nothing usable.

This is deliberately boundary code: the frontend hits /photos/transcribe
with an audio blob, gets back `{ text, language? }`, and pipes the text
into the note textarea. No persistence happens here — the note is saved
via the existing PATCH /photos/{id} once the user confirms.
"""
from __future__ import annotations

import io
import logging
from typing import Optional

from app.core.config import settings

logger = logging.getLogger(__name__)


class TranscriptionError(RuntimeError):
    """Raised when every configured provider fails."""


def _groq_transcribe(audio_bytes: bytes, filename: str) -> Optional[dict]:
    if not settings.GROQ_API_KEY:
        return None
    try:
        from groq import Groq
    except Exception as e:
        logger.warning("transcribe: groq import failed: %s", e)
        return None

    try:
        client = Groq(api_key=settings.GROQ_API_KEY)
        result = client.audio.transcriptions.create(
            file=(filename, io.BytesIO(audio_bytes)),
            model="whisper-large-v3",
            response_format="verbose_json",
            temperature=0.0,
        )
        text = getattr(result, "text", None) or (result.get("text") if isinstance(result, dict) else None)
        lang = getattr(result, "language", None) or (result.get("language") if isinstance(result, dict) else None)
        if not text:
            return None
        return {"text": text.strip(), "language": lang, "provider": "groq/whisper-large-v3"}
    except Exception as e:
        logger.warning("transcribe: groq whisper failed: %s", e)
        return None


def _gemini_transcribe(audio_bytes: bytes, mime_type: str) -> Optional[dict]:
    if not settings.GEMINI_API_KEY:
        return None
    try:
        from google import genai
        from google.genai import types
    except Exception as e:
        logger.warning("transcribe: gemini import failed: %s", e)
        return None

    try:
        client = genai.Client(api_key=settings.GEMINI_API_KEY)
        prompt = (
            "Transcribe this audio note exactly. Return only the transcript — "
            "no commentary, no headers, no markdown. If the audio is silent or "
            "unintelligible, return an empty string."
        )
        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[
                types.Part.from_bytes(data=audio_bytes, mime_type=mime_type),
                prompt,
            ],
            config=types.GenerateContentConfig(max_output_tokens=2048),
        )
        text = (response.text or "").strip()
        if not text:
            return None
        return {"text": text, "language": None, "provider": "gemini-2.0-flash"}
    except Exception as e:
        logger.warning("transcribe: gemini failed: %s", e)
        return None


def transcribe_audio(audio_bytes: bytes, *, filename: str = "note.webm", mime_type: str = "audio/webm") -> dict:
    """Transcribe a voice note. Tries Groq Whisper first, then Gemini.

    Returns `{text, language, provider}`. Raises TranscriptionError if
    every provider fails or every provider returns empty text.
    """
    if not audio_bytes:
        raise TranscriptionError("No audio bytes provided")

    result = _groq_transcribe(audio_bytes, filename)
    if result and result.get("text"):
        return result

    result = _gemini_transcribe(audio_bytes, mime_type)
    if result and result.get("text"):
        return result

    raise TranscriptionError("No configured transcription provider produced text")
