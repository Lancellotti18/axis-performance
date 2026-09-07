"""The Gemini retry matrix is 2 passes x 3 keys x 4 models = 24 attempts, each
with its own 130 s timeout. Unbounded that is ~52 minutes for a single call, on an
endpoint whose browser client gives up after 120 s. These tests pin the bound."""
import asyncio
import time

import pytest

from app.services import llm


@pytest.mark.asyncio
async def test_real_retry_matrix_is_bounded_by_the_budget(monkeypatch):
    """Exercise the ACTUAL loop in _gemini_vision. Every attempt hangs, so without
    a deadline this walks 24 attempts x 130 s. asyncio.to_thread is patched so the
    real deadline arithmetic runs against a call that never returns."""
    attempts = {"n": 0}

    async def never_returns(fn, *a, **k):
        attempts["n"] += 1
        await asyncio.sleep(3600)

    monkeypatch.setattr(llm.asyncio, "to_thread", never_returns)
    monkeypatch.setattr(llm, "_gemini_keys", lambda: ["k1", "k2", "k3"])
    monkeypatch.setattr(llm, "GEMINI_FALLBACKS", ["m2", "m3", "m4"])
    monkeypatch.setattr(llm.settings, "GEMINI_API_KEY", "k1")

    started = time.monotonic()
    with pytest.raises(Exception):
        await llm._gemini_vision(b"x", "image/png", "p", None, 100,
                                 deadline=time.monotonic() + 2.0)
    elapsed = time.monotonic() - started

    # 24 unbounded attempts would be ~52 minutes. The budget must cut it at ~2 s.
    assert elapsed < 8, f"deadline ignored — took {elapsed:.1f}s"
    assert attempts["n"] < 24, "should stop early, not walk the whole matrix"


@pytest.mark.asyncio
async def test_budget_is_optional(monkeypatch):
    """Callers with no user waiting (batch work) keep the old unbounded behaviour."""
    async def ok(*a, **k):
        return "fine"
    monkeypatch.setattr(llm.settings, "GEMINI_API_KEY", "k1")
    monkeypatch.setattr(llm, "_gemini_vision", ok)
    assert await llm.llm_vision(b"x", "image/png", "p") == "fine"


def test_edge_label_budget_is_inside_the_client_timeout():
    """The browser aborts suggest-labels at 120 s. Two passes must fit inside that
    with room to spare, or the user gets a network error while the server grinds."""
    from app.api.v1.roofing_v2 import _EDGE_VISION_BUDGET_S
    assert _EDGE_VISION_BUDGET_S * 2 < 120, "two vision passes can outlive the client"
