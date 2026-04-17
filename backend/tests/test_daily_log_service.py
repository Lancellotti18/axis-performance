"""
Tests for the Procore-style daily log service.

LLM text calls are stubbed — these tests verify grouping, signal extraction,
fallback behavior (zero-hallucination rule), and overall log shape.
"""
from __future__ import annotations

import pytest

from app.services import daily_log_service as dls


def _photo(**kw) -> dict:
    base = {
        "id": "p-1",
        "url": "https://x.com/p.jpg",
        "created_at": "2026-04-15T10:00:00Z",
        "captured_at": None,
        "phase": "during",
        "notes": None,
        "tags": [],
        "auto_tags": {},
    }
    base.update(kw)
    return base


def test_day_key_prefers_captured_over_created():
    p = _photo(captured_at="2026-04-10T08:00:00Z", created_at="2026-04-12T08:00:00Z")
    assert dls._day_key(p) == "2026-04-10"


def test_day_key_falls_back_to_created():
    p = _photo(captured_at=None, created_at="2026-04-12T08:00:00Z")
    assert dls._day_key(p) == "2026-04-12"


def test_day_key_none_when_neither_set():
    assert dls._day_key({"id": "x"}) is None


def test_group_photos_newest_first():
    photos = [
        _photo(id="a", created_at="2026-04-10"),
        _photo(id="b", created_at="2026-04-12"),
        _photo(id="c", created_at="2026-04-11"),
    ]
    grouped = dls.group_photos_by_day(photos)
    assert list(grouped.keys()) == ["2026-04-12", "2026-04-11", "2026-04-10"]


def test_collect_signal_aggregates_tags_and_flags():
    photos = [
        _photo(
            notes="framing inspection passed",
            tags=["inspection"],
            auto_tags={"area": "kitchen", "materials": ["drywall", "studs"], "damage": [], "safety": []},
            phase="during",
        ),
        _photo(
            id="p-2",
            notes=None,
            tags=["demo"],
            auto_tags={"area": "kitchen", "materials": ["drywall"], "damage": ["water damage"], "safety": ["missing handrail"]},
            phase="before",
        ),
    ]
    sig = dls._collect_signal(photos)
    assert sig["photo_count"] == 2
    assert sig["phases"] == {"during": 1, "before": 1}
    assert "drywall" in sig["auto_tags"]
    assert "studs" in sig["auto_tags"]
    assert "kitchen" in sig["areas"]
    assert sig["damage"] == ["water damage"]
    assert sig["safety"] == ["missing handrail"]
    assert sorted(sig["manual_tags"]) == ["demo", "inspection"]


def test_fallback_summary_singular_plural():
    one = dls._fallback_summary({"photo_count": 1, "phases": {}, "areas": [], "notes": [], "manual_tags": [], "auto_tags": []})
    assert one.startswith("1 photo uploaded")

    many = dls._fallback_summary({"photo_count": 3, "phases": {"during": 3}, "areas": ["roof"], "notes": [], "manual_tags": [], "auto_tags": []})
    assert "3 photos" in many
    assert "during" in many
    assert "roof" in many


def test_fallback_summary_notes_presence_suppresses_placeholder():
    sig = {"photo_count": 2, "phases": {}, "areas": [], "notes": ["something"], "manual_tags": [], "auto_tags": []}
    out = dls._fallback_summary(sig)
    # the "— no site notes recorded" tail should only appear when there's truly no signal
    assert "no site notes recorded" not in out


@pytest.mark.asyncio
async def test_summarize_day_skips_llm_when_no_signal(monkeypatch):
    """Zero-hallucination rule: with no notes/tags/auto_tags/damage, never call the LLM."""
    called = {"n": 0}

    async def fake_llm(*args, **kwargs):
        called["n"] += 1
        return "invented activity"

    monkeypatch.setattr(dls, "llm_text", fake_llm)
    sig = {"photo_count": 2, "phases": {"during": 2}, "areas": [], "notes": [], "manual_tags": [], "auto_tags": [], "damage": [], "safety": []}
    out = await dls._summarize_day("2026-04-10", sig)
    assert called["n"] == 0
    assert "2 photos uploaded" in out


@pytest.mark.asyncio
async def test_summarize_day_calls_llm_when_signal_present(monkeypatch):
    async def fake_llm(prompt, **kwargs):  # noqa: ARG001
        return "Crew documented kitchen demo and tagged water damage."

    monkeypatch.setattr(dls, "llm_text", fake_llm)
    sig = {"photo_count": 3, "phases": {"during": 3}, "areas": ["kitchen"], "notes": ["demo done"], "manual_tags": [], "auto_tags": [], "damage": ["water"], "safety": []}
    out = await dls._summarize_day("2026-04-10", sig)
    assert "kitchen" in out.lower()


@pytest.mark.asyncio
async def test_summarize_day_strips_prefixes(monkeypatch):
    async def fake_llm(prompt, **kwargs):  # noqa: ARG001
        return "Daily log: Crew finished drywall in the kitchen."

    monkeypatch.setattr(dls, "llm_text", fake_llm)
    sig = {"photo_count": 1, "phases": {}, "areas": [], "notes": ["x"], "manual_tags": [], "auto_tags": [], "damage": [], "safety": []}
    out = await dls._summarize_day("2026-04-10", sig)
    assert not out.lower().startswith("daily log:")
    assert "drywall" in out.lower()


@pytest.mark.asyncio
async def test_summarize_day_llm_failure_falls_back(monkeypatch):
    async def fake_llm(*args, **kwargs):
        raise RuntimeError("LLM down")

    monkeypatch.setattr(dls, "llm_text", fake_llm)
    sig = {"photo_count": 2, "phases": {"during": 2}, "areas": ["roof"], "notes": ["did stuff"], "manual_tags": [], "auto_tags": [], "damage": [], "safety": []}
    out = await dls._summarize_day("2026-04-10", sig)
    assert "2 photos uploaded" in out  # fallback kicked in


@pytest.mark.asyncio
async def test_build_daily_logs_shape(monkeypatch):
    async def fake_llm(*args, **kwargs):
        return "Summary."

    monkeypatch.setattr(dls, "llm_text", fake_llm)
    photos = [
        _photo(id="a", created_at="2026-04-10T08:00:00Z", notes="note-a"),
        _photo(id="b", created_at="2026-04-12T09:00:00Z", notes="note-b"),
    ]
    logs = await dls.build_daily_logs(photos)
    assert len(logs) == 2
    assert logs[0]["date"] == "2026-04-12"  # newest first
    assert logs[1]["date"] == "2026-04-10"
    for entry in logs:
        assert set(entry.keys()) >= {"date", "photo_count", "phases", "summary", "photos"}
