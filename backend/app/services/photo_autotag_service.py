"""
Single-photo auto-tagging via the vision LLM chain.

CompanyCam-style metadata: one photo → structured tags the UI can render as
chips without the user having to hand-type them. Returns a normalized dict:

    {
        "phase": "before"|"during"|"after"|None,
        "area": "roof"|"kitchen"|"bathroom"|"exterior"|... ,
        "materials": ["asphalt shingles", ...],
        "damage": ["missing shingles", ...],
        "safety": ["scaffolding present", ...],
        "summary": "short human caption",
        "confidence": 0.0-1.0,
        "model_raw": "<truncated model response for debugging>"
    }

This is advisory metadata — never a substitute for user judgment. If the
vision chain is unavailable or returns garbage, we surface nulls rather than
hallucinating tags.
"""
import json
import logging
import re
from typing import Any, Optional

import httpx

from app.services.llm import llm_vision_sync

logger = logging.getLogger(__name__)

_PROMPT = """You are a contractor's field assistant. Look at this job-site photo and extract structured metadata.

Return ONLY valid JSON with this exact shape:
{
  "phase": "before" | "during" | "after" | null,
  "area": "roof" | "kitchen" | "bathroom" | "exterior" | "interior" | "foundation" | "framing" | "landscaping" | "other" | null,
  "materials": [string, ...],       // visible materials, lowercase, max 6
  "damage": [string, ...],           // visible damage/defects, lowercase, max 6
  "safety": [string, ...],           // safety concerns or PPE visible, max 4
  "summary": string,                 // 1 short sentence, <=120 chars
  "confidence": number               // 0.0-1.0 overall confidence
}

Rules:
- If you cannot tell a field, use null (for scalars) or [] (for arrays). Do NOT guess.
- `phase` clues: bare framing / demo debris / empty room = before; active work, tools, partial install = during; finished surfaces, clean site = after.
- `materials` must be things you can clearly see, not things you assume. No invented brand names.
- `damage` is only for visible problems (missing shingles, rotted wood, cracks, leaks). Do not list general wear.
- `summary` must describe what's in the photo, not what you guess about the project.
- Output raw JSON only — no markdown fences, no prose before/after.
"""


def _extract_json(text: str) -> Optional[dict]:
    """Pull the first JSON object out of a model response, tolerating code fences."""
    if not text:
        return None
    # Strip code fences if present.
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    # Find first balanced object.
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def _normalize(raw: dict) -> dict:
    """Coerce a model response into our tag schema; drop anything unexpected."""
    allowed_phases = {"before", "during", "after"}
    allowed_areas = {"roof", "kitchen", "bathroom", "exterior", "interior",
                     "foundation", "framing", "landscaping", "other"}

    phase = raw.get("phase")
    if isinstance(phase, str):
        phase = phase.strip().lower()
        if phase not in allowed_phases:
            phase = None
    else:
        phase = None

    area = raw.get("area")
    if isinstance(area, str):
        area = area.strip().lower()
        if area not in allowed_areas:
            area = None
    else:
        area = None

    def _str_list(v: Any, cap: int) -> list[str]:
        if not isinstance(v, list):
            return []
        out: list[str] = []
        for item in v:
            if isinstance(item, str):
                s = item.strip().lower()
                if s and s not in out:
                    out.append(s)
            if len(out) >= cap:
                break
        return out

    summary = raw.get("summary")
    if isinstance(summary, str):
        summary = summary.strip()[:240]
    else:
        summary = None

    conf = raw.get("confidence")
    try:
        conf_f = float(conf) if conf is not None else 0.0
    except (TypeError, ValueError):
        conf_f = 0.0
    conf_f = max(0.0, min(1.0, conf_f))

    return {
        "phase": phase,
        "area": area,
        "materials": _str_list(raw.get("materials"), 6),
        "damage": _str_list(raw.get("damage"), 6),
        "safety": _str_list(raw.get("safety"), 4),
        "summary": summary,
        "confidence": conf_f,
    }


def _fetch_image(url: str, timeout: float = 15.0) -> Optional[tuple[bytes, str]]:
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
    except Exception as e:
        logger.warning("autotag: failed to fetch %s: %s", url, e)
        return None

    media = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
    if not media.startswith("image/"):
        logger.warning("autotag: non-image content-type for %s: %s", url, media)
        return None
    return resp.content, media


def autotag_photo(url: str) -> dict:
    """Analyze a single photo URL and return CompanyCam-style tag metadata.

    Returns a normalized tag dict. If vision fails or the model refuses,
    returns a dict with `confidence=0.0` and empty tag arrays — never fake data.
    """
    empty = {
        "phase": None, "area": None, "materials": [], "damage": [],
        "safety": [], "summary": None, "confidence": 0.0,
        "autotag_unverified": True,
    }

    fetched = _fetch_image(url)
    if fetched is None:
        return {**empty, "error": "fetch_failed"}
    image_bytes, media_type = fetched

    try:
        raw_text = llm_vision_sync(
            image_bytes=image_bytes,
            media_type=media_type,
            prompt=_PROMPT,
            max_tokens=600,
        )
    except Exception as e:
        logger.warning("autotag: vision call failed: %s", e)
        return {**empty, "error": "vision_failed"}

    parsed = _extract_json(raw_text or "")
    if parsed is None:
        logger.warning("autotag: could not parse JSON from model output: %r", (raw_text or "")[:200])
        return {**empty, "error": "parse_failed"}

    normalized = _normalize(parsed)
    # If everything came back empty/null, treat as unverified.
    if (normalized["confidence"] < 0.2
            and not normalized["materials"]
            and not normalized["damage"]
            and normalized["phase"] is None
            and normalized["area"] is None):
        normalized["autotag_unverified"] = True
    return normalized
