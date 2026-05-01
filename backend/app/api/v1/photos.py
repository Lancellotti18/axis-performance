"""
Voice-note transcription endpoint.

Originally this module hosted the full project-photo CRUD + AI tagging surface;
it was archived on 2026-05-01 and only the /transcribe endpoint remains because
the CRM voice-note dictation feature posts to it. The router is still mounted
at `/api/v1/photos` so the existing client URL keeps working.

To restore the photo feature, see:
  Obsidian → Projects → BuildAI - Photo Feature Archive (2026-05-01).md
  git tag pre-photo-tab-removal-2026-05-01
"""
import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.core.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/transcribe")
async def transcribe_voice_note(
    audio: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Convert a short voice note into text. Client-side MediaRecorder → text.

    Expects a small (<10 MB) audio blob; enforces that limit before handing
    off to the provider chain so a pathological upload can't stall us.
    """
    from app.services.audio_transcription_service import (
        TranscriptionError, transcribe_audio,
    )
    MAX_BYTES = 10 * 1024 * 1024

    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio upload")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Audio file too large (max 10 MB)")

    mime = audio.content_type or "audio/webm"
    filename = audio.filename or "note.webm"

    try:
        result = transcribe_audio(data, filename=filename, mime_type=mime)
    except TranscriptionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.exception("transcribe: unexpected failure")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    return result
