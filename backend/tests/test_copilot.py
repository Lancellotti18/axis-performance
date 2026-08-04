"""Tests for the Copilot's deterministic core (M5.5).

The contract that matters (per docs guardrail A6): the throughput flywheel only
suggests a capacity change past a real evidence threshold — enough samples, a
meaningful delta, and a stable rate. A single fast or slow job must never move a
crew's number. These tests pin those boundaries.
"""
from app.services.scheduling.copilot import (
    MIN_SAMPLES, ThroughputSample, analyze_crew_throughput, assemble_brief,
    BriefInputs, templated_prose, parse_plan_json,
)


def _samples(rates, days=1.0):
    return [ThroughputSample(f"a{i}", r * days, days) for i, r in enumerate(rates)]


def test_no_samples_no_recommendation():
    v = analyze_crew_throughput("c1", "Kevin's Crew", 28.0, [])
    assert v.recommend is False
    assert v.sample_size == 0
    assert v.suggested_sqpd is None


def test_single_fast_job_never_moves_capacity():
    # One blowout day at 40 sq/day against a configured 28 — must not recommend.
    v = analyze_crew_throughput("c1", "Kevin's Crew", 28.0, _samples([40.0]))
    assert v.sample_size == 1
    assert v.recommend is False
    assert v.suggested_sqpd is None


def test_insufficient_samples_below_threshold():
    v = analyze_crew_throughput("c1", "Kevin's Crew", 28.0, _samples([31, 32, 31, 30, 31]))  # 5 < MIN_SAMPLES
    assert v.sample_size == 5
    assert v.sample_size < MIN_SAMPLES
    assert v.recommend is False
    assert "not enough evidence" in v.rationale.lower()


def test_strong_stable_delta_recommends():
    # 8 jobs steadily around 31 vs configured 28 → ~11% faster, stable → recommend.
    v = analyze_crew_throughput("c1", "Kevin's Crew", 28.0, _samples([31, 31, 30, 32, 31, 30, 31, 32]))
    assert v.sample_size == 8
    assert v.recommend is True
    assert v.suggested_sqpd == 31.0
    assert v.delta_pct > 8.0
    assert v.stable is True


def test_high_variance_blocks_recommendation():
    # Enough samples, big average delta, but wildly variable → not trustworthy.
    v = analyze_crew_throughput("c1", "Kevin's Crew", 28.0, _samples([18, 45, 20, 44, 19, 46, 21, 43]))
    assert v.sample_size == 8
    assert v.stable is False
    assert v.recommend is False
    assert "variable" in v.rationale.lower()


def test_small_delta_no_change_needed():
    # 8 stable jobs but essentially at configured (within 8%) → no change.
    v = analyze_crew_throughput("c1", "Kevin's Crew", 28.0, _samples([28, 29, 28, 27, 28, 29, 28, 28]))
    assert v.sample_size == 8
    assert v.recommend is False
    assert "no change needed" in v.rationale.lower()


def test_slower_crew_recommends_downward():
    # A crew configured too high — 8 steady jobs at ~23 vs 28 → recommend down.
    v = analyze_crew_throughput("c1", "Gutter Crew", 28.0, _samples([23, 22, 23, 24, 23, 22, 23, 24]))
    assert v.recommend is True
    assert v.suggested_sqpd is not None
    assert v.suggested_sqpd < 28.0
    assert v.delta_pct < 0


def test_crew_days_normalizes_multiday():
    # A 3-crew-day job that laid 90 squares is 30 sq/day, not 90.
    v = analyze_crew_throughput("c1", "Install", 28.0, [ThroughputSample("a", 90.0, 3.0)] * 8)
    assert abs(v.observed_sqpd - 30.0) < 0.01


def test_brief_assembly_ranks_and_counts():
    inp = BriefInputs(
        date="2026-08-04",
        overbooked=[{"crew_id": "c1", "crew_name": "Kevin's Crew", "date": "2026-08-04", "utilization_pct": 118.0}],
        idle=[{"crew_id": "c2", "crew_name": "Service Crew", "date": "2026-08-05"}],
        gaps=[{"job_id": "j1", "job_number": 101, "label": "Reroof", "best": {"crew_name": "Install", "date": "2026-08-06", "action": {"type": "create", "job_id": "j1", "crew_id": "c3", "date": "2026-08-06"}}}],
        weather_risks=[{"date": "2026-08-06", "precip": 80.0, "count": 3, "resolvable": 3}],
        series_risks=[],
        deadline_risks=[{"job_id": "j9", "job_number": 99, "text": "#99 misses its Friday deadline."}],
    )
    b = assemble_brief(inp)
    assert b["counts"] == {"load": 2, "gaps": 1, "risk": 2}
    # Overbooked outranks idle in the load list.
    assert b["load"][0]["kind"] == "LOAD_OVER"
    # A gap with a best fit carries a one-tap action.
    assert b["gaps"][0]["action"]["type"] == "create"
    # Prose fallback mentions the standout facts and never crashes.
    prose = templated_prose(b)
    assert "overbooked" in prose.lower()
    assert prose


def test_brief_prose_handles_clean_board():
    b = assemble_brief(BriefInputs("2026-08-04", [], [], [], [], [], []))
    assert b["counts"] == {"load": 0, "gaps": 0, "risk": 0}
    assert "clean" in templated_prose(b).lower()


# --- ⌘K plan parser: a malformed model reply must yield {} (nothing to apply) ---

def test_plan_parser_extracts_clean_json():
    p = parse_plan_json('{"op": "REASSIGN", "ids": ["a1"], "payload": {"crew_id": "c1"}}')
    assert p["op"] == "REASSIGN"
    assert p["ids"] == ["a1"]


def test_plan_parser_strips_code_fences_and_prose():
    raw = 'Sure! Here is the plan:\n```json\n{"op": "MOVE_TO_DATE", "ids": ["a2"], "payload": {"date": "2026-08-07"}}\n```\nHope that helps.'
    p = parse_plan_json(raw)
    assert p["op"] == "MOVE_TO_DATE"
    assert p["payload"]["date"] == "2026-08-07"


def test_plan_parser_rejects_garbage():
    for junk in ["", "not json at all", "{broken", "```\nnope\n```", "[1,2,3]", "null"]:
        assert parse_plan_json(junk) == {}, junk
