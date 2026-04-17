"""
Procore-style daily log.

Groups a project's photos by captured date, then asks the LLM to write a
one-paragraph site summary for each day using whatever signal we have:
photo count by phase, user-entered notes, manual tags, AI auto-tags, and
location. No photo content re-analysis happens here — we rely on the
auto-tag results the photo pipeline already persisted.

The output drops into the Reports page as a timeline and into the
/reports/{id}/pdf export as its own section. Days with no notes, tags,
or AI signal still get a terse "N photos uploaded — no notes" line so
contractors can see activity at a glance without the LLM hallucinating.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime
from typing import Any, Iterable, Optional

from app.services.llm import llm_text

logger = logging.getLogger(__name__)


def _day_key(photo: dict) -> Optional[str]:
    """Return YYYY-MM-DD for a photo, preferring captured_at over created_at."""
    for key in ("captured_at", "created_at"):
        v = photo.get(key)
        if not v:
            continue
        if isinstance(v, datetime):
            return v.date().isoformat()
        if isinstance(v, str):
            # Accept 'YYYY-MM-DD...' or ISO-8601 with time/zone
            return v[:10]
    return None


def group_photos_by_day(photos: Iterable[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for p in photos:
        k = _day_key(p)
        if not k:
            continue
        grouped[k].append(p)
    return dict(sorted(grouped.items(), reverse=True))


def _collect_signal(day_photos: list[dict]) -> dict:
    """Extract the facts we'll pass to the LLM (or use directly for the fallback)."""
    phases: dict[str, int] = defaultdict(int)
    all_notes: list[str] = []
    all_tags: set[str] = set()
    all_auto: set[str] = set()
    damage_flags: list[str] = []
    safety_flags: list[str] = []
    areas: set[str] = set()

    for p in day_photos:
        phase = (p.get("phase") or "unspecified").lower()
        phases[phase] += 1

        if p.get("notes"):
            all_notes.append(str(p["notes"]).strip())

        tags = p.get("tags") or []
        if isinstance(tags, list):
            for t in tags:
                if t:
                    all_tags.add(str(t).strip())

        auto = p.get("auto_tags") or {}
        if isinstance(auto, dict):
            area = auto.get("area")
            if area:
                areas.add(str(area).strip().lower())
            for t in (auto.get("materials") or []):
                if t:
                    all_auto.add(str(t).strip().lower())
            for d in (auto.get("damage") or []):
                if d:
                    damage_flags.append(str(d).strip().lower())
            for s in (auto.get("safety") or []):
                if s:
                    safety_flags.append(str(s).strip().lower())

    return {
        "photo_count": len(day_photos),
        "phases": dict(phases),
        "notes": all_notes,
        "manual_tags": sorted(all_tags),
        "auto_tags": sorted(all_auto),
        "areas": sorted(areas),
        "damage": damage_flags,
        "safety": safety_flags,
    }


def _fallback_summary(signal: dict) -> str:
    """Deterministic one-liner when we don't call the LLM (no notes, no tags)."""
    parts: list[str] = [f"{signal['photo_count']} photo{'s' if signal['photo_count'] != 1 else ''} uploaded"]
    phase_bits = []
    for p in ("before", "during", "after"):
        c = signal["phases"].get(p, 0)
        if c:
            phase_bits.append(f"{c} {p}")
    if phase_bits:
        parts.append(f"({', '.join(phase_bits)})")
    if signal["areas"]:
        parts.append(f"covering {', '.join(signal['areas'][:3])}")
    if not signal["notes"] and not signal["manual_tags"] and not signal["auto_tags"]:
        parts.append("— no site notes recorded")
    return " ".join(parts).strip()


async def _summarize_day(date: str, signal: dict) -> str:
    """Ask the LLM for a one-paragraph site log. Falls back to a terse string on failure."""
    # If we have literally no narrative signal, skip the LLM call — it has nothing
    # to synthesize from and we don't want it inventing activity.
    if not signal["notes"] and not signal["manual_tags"] and not signal["auto_tags"] and not signal["damage"]:
        return _fallback_summary(signal)

    prompt = f"""You are writing a daily site log entry for a construction project.

Write ONE short paragraph (2–3 sentences, ~50 words) summarizing what happened on {date}. Use ONLY the signals below — do not invent crew counts, weather, or progress percentages that aren't in the data. If a signal is missing, don't mention it.

Photos uploaded: {signal['photo_count']}
Phases: {signal['phases']}
Areas captured: {', '.join(signal['areas']) or 'not specified'}
Manual tags: {', '.join(signal['manual_tags']) or 'none'}
AI-detected materials: {', '.join(signal['auto_tags']) or 'none'}
Damage observations: {', '.join(signal['damage']) or 'none'}
Safety observations: {', '.join(signal['safety']) or 'none'}
Site notes from the crew:
{chr(10).join(f'- {n}' for n in signal['notes']) if signal['notes'] else '(no notes)'}

Write in past tense, plain language. Lead with the most important concrete fact (damage found, milestone hit, or scope of work documented). Do NOT use markdown, bullet points, or headings — just one paragraph."""

    try:
        text = await llm_text(prompt, max_tokens=180)
        text = (text or "").strip().strip('"').strip()
        # Strip a leading "Daily log:" / "Summary:" the LLM sometimes adds
        for prefix in ("Daily log:", "Summary:", "Daily Log Entry:", "Site log:"):
            if text.lower().startswith(prefix.lower()):
                text = text[len(prefix):].strip()
        if not text:
            return _fallback_summary(signal)
        return text
    except Exception as e:
        logger.warning("daily_log: LLM summary failed for %s — %s", date, e)
        return _fallback_summary(signal)


async def build_daily_logs(photos: list[dict]) -> list[dict]:
    """
    Returns a list of daily-log entries, newest first:
      [{date, photo_count, phases, areas, summary, photos: [{id, url, phase, thumbnail_url?}], tags, damage, safety}]
    """
    grouped = group_photos_by_day(photos)
    logs: list[dict] = []
    for date, day_photos in grouped.items():
        signal = _collect_signal(day_photos)
        summary = await _summarize_day(date, signal)
        logs.append({
            "date": date,
            "photo_count": signal["photo_count"],
            "phases": signal["phases"],
            "areas": signal["areas"],
            "summary": summary,
            "manual_tags": signal["manual_tags"],
            "auto_tags": signal["auto_tags"],
            "damage": signal["damage"],
            "safety": signal["safety"],
            "photos": [
                {
                    "id": p.get("id"),
                    "url": p.get("url"),
                    "phase": p.get("phase"),
                    "notes": p.get("notes"),
                }
                for p in day_photos
                if p.get("url")
            ],
        })
    return logs


async def build_daily_logs_for_project(project_id: str) -> list[dict]:
    """Convenience wrapper: pull photos from Supabase and build the log."""
    from app.core.supabase import get_supabase
    db = get_supabase()
    try:
        result = (
            db.table("project_photos")
            .select("id, url, phase, notes, tags, auto_tags, captured_at, created_at")
            .eq("project_id", project_id)
            .order("created_at")
            .execute()
        )
        photos = result.data or []
    except Exception:
        logger.exception("daily_log: failed to fetch project_photos for %s", project_id)
        raise
    return await build_daily_logs(photos)
