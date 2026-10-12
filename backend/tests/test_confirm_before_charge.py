"""A report is used when the contractor CONFIRMS the roof, not when the
measurements panel first loads (Ryan, 2026-10-12).

Picking the wrong house and backing out must cost nothing — and must not be a
free way to read the numbers either, so they are withheld until confirmation."""
import asyncio

import pytest
from fastapi import HTTPException

from app.api.v1 import roofing_v2 as r

USER = {"id": "u1"}
AGG = {"total_roof_sqft": 2400.0, "squares": 24.0, "eaves_ft": 140.0,
       "blocking_issues": [], "partial_signals": ["valleys estimated"]}


@pytest.fixture
def wired(monkeypatch):
    state = {"billed": False, "charges": 0}
    monkeypatch.setattr(r, "get_supabase", lambda: object())
    monkeypatch.setattr(r, "require_owned_run", lambda db, rid, u: {"id": rid})
    monkeypatch.setattr(r, "_aggregate_run", lambda rid: dict(AGG))
    monkeypatch.setattr(r, "_would_newly_bill", lambda db, rid, agg: not state["billed"])

    def charge(db, rid, uid, agg):
        # Like the real one: a no-op on a run that is already billed.
        if not state["billed"]:
            state["charges"] += 1
            state["billed"] = True
    monkeypatch.setattr(r, "_gate_and_mark_billable", charge)
    return state


def _recompute(confirm=False):
    return asyncio.run(r.recompute_run("run1", confirm=confirm, user=USER))


def test_loading_the_measurements_does_not_use_a_report(wired):
    out = _recompute()
    assert out["needs_confirmation"] is True
    assert wired["charges"] == 0


def test_an_unconfirmed_roof_reveals_no_numbers(wired):
    out = _recompute()
    for k in ("total_roof_sqft", "squares", "eaves_ft"):
        assert k not in out
    # It can still say what is wrong with the trace.
    assert out["partial_signals"] == ["valleys estimated"]


def test_confirming_uses_one_report_and_shows_the_numbers(wired):
    out = _recompute(confirm=True)
    assert wired["charges"] == 1
    assert out["squares"] == 24.0


def test_a_confirmed_roof_is_never_charged_again(wired):
    _recompute(confirm=True)
    again = _recompute()
    assert again["squares"] == 24.0
    _recompute(confirm=True)
    assert wired["charges"] == 1 and "needs_confirmation" not in again


def test_materials_wait_for_confirmation(wired):
    with pytest.raises(HTTPException) as e:
        r._require_confirmed(object(), "run1")
    assert e.value.status_code == 409
    assert e.value.detail["error"] == "confirmation_required"
    wired["billed"] = True
    r._require_confirmed(object(), "run1")      # no raise once confirmed
