"""CRM signal feeding the dashboard morning briefing.

The briefing only earns its place at the top of the dashboard if its numbers are
right and it stays quiet when there's nothing to say.
"""
from datetime import date

from app.services.crm_pulse import (
    days_untouched, is_stale, pulse_lines, summarize_leads,
)

TODAY = date(2026, 8, 16)


def _lead(stage="new", updated="2026-08-16", value=0, name="Lead", id_="1"):
    return {"id": id_, "name": name, "stage": stage,
            "updated_at": f"{updated}T09:00:00Z", "created_at": "2026-01-01T09:00:00Z",
            "estimated_value": value}


# ── staleness ────────────────────────────────────────────────────────────────

def test_fresh_lead_is_not_stale():
    assert not is_stale(_lead("new", "2026-08-16"), TODAY)


def test_new_lead_goes_stale_after_two_days():
    assert is_stale(_lead("new", "2026-08-14"), TODAY)


def test_estimate_sent_has_the_shortest_fuse():
    # 4 days on a sent estimate is stale; the same age in 'contacted' is not.
    assert is_stale(_lead("estimate_sent", "2026-08-12"), TODAY)
    assert not is_stale(_lead("contacted", "2026-08-12"), TODAY)


def test_won_and_lost_are_never_stale():
    for stage in ("won", "lost"):
        assert not is_stale(_lead(stage, "2020-01-01"), TODAY)


def test_missing_timestamps_do_not_crash_or_flag():
    assert days_untouched({"stage": "new"}, TODAY) is None
    assert not is_stale({"stage": "new"}, TODAY)


def test_falls_back_to_created_at_when_never_updated():
    lead = {"stage": "new", "created_at": "2026-08-01T09:00:00Z"}
    assert days_untouched(lead, TODAY) == 15
    assert is_stale(lead, TODAY)


# ── summary ──────────────────────────────────────────────────────────────────

def test_empty_pipeline_is_all_zeros_not_an_error():
    s = summarize_leads([], TODAY)
    assert s["total"] == 0
    assert s["open_value"] == 0
    assert s["win_rate_pct"] is None
    assert pulse_lines(s) == []


def test_open_value_excludes_won_and_lost():
    # A "pipeline" number that includes closed deals is one nobody can act on.
    s = summarize_leads([
        _lead("contacted", value=10_000, id_="a"),
        _lead("won", value=50_000, id_="b"),
        _lead("lost", value=99_000, id_="c"),
    ], TODAY)
    assert s["open_value"] == 10_000
    assert s["won_value"] == 50_000
    assert s["open_count"] == 1


def test_win_rate_counts_only_decided_leads():
    s = summarize_leads([
        _lead("won", id_="a"), _lead("won", id_="b"),
        _lead("lost", id_="c"), _lead("new", id_="d"),
    ], TODAY)
    assert s["win_rate_pct"] == 67


def test_stale_sorted_longest_neglected_first():
    s = summarize_leads([
        _lead("new", "2026-08-10", name="Recent", id_="a"),
        _lead("new", "2026-07-01", name="Ancient", id_="b"),
    ], TODAY)
    assert [r["name"] for r in s["stale"]] == ["Ancient", "Recent"]


def test_stale_list_is_capped_but_count_is_not():
    leads = [_lead("new", "2026-06-01", name=f"L{i}", id_=str(i)) for i in range(10)]
    s = summarize_leads(leads, TODAY)
    assert s["stale_count"] == 10
    assert len(s["stale"]) == 6


def test_unknown_stage_is_counted_not_dropped():
    s = summarize_leads([_lead("nurturing", id_="a")], TODAY)
    assert s["total"] == 1
    assert s["by_stage"]["nurturing"] == 1


def test_bad_value_does_not_break_totals():
    s = summarize_leads([
        _lead("contacted", value=None, id_="a"),
        _lead("contacted", value="not a number", id_="b"),
        _lead("contacted", value=-5, id_="c"),
        _lead("contacted", value="2500", id_="d"),
    ], TODAY)
    assert s["open_value"] == 2500


# ── narration ────────────────────────────────────────────────────────────────

def test_pulse_leads_with_the_chase_not_the_vanity_metric():
    s = summarize_leads([_lead("estimate_sent", "2026-07-20", value=8000, name="Ortiz", id_="a")], TODAY)
    lines = pulse_lines(s)
    assert "Ortiz" in lines[0]
    assert "chasing" in lines[0]


def test_pulse_stays_quiet_when_everything_is_fresh():
    s = summarize_leads([_lead("new", "2026-08-16", id_="a")], TODAY)
    # No stale work, no estimates out, no value — nothing worth saying.
    assert pulse_lines(s) == []
