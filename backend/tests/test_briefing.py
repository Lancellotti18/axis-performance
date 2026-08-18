"""Owner-operator morning briefing.

The briefing only works if it stays short and ordered by how fast the
opportunity decays. These tests pin both, plus the quiet-when-nothing's-wrong
behaviour — a briefing that manufactures filler stops being read.
"""
from datetime import date

from app.services.briefing import (
    MAX_ITEMS, accepted_items, assemble, cold_lead_items, days_since,
    stuck_items, waiting_items, weather_items,
)

TODAY = date(2026, 8, 18)
TOMORROW = "2026-08-19"


# ── accepted ─────────────────────────────────────────────────────────────────

def test_unread_accepted_proposal_surfaces():
    items = accepted_items([{"id": "n1", "type": "proposal_accepted", "title": "Ortiz", "read": False}])
    assert len(items) == 1
    assert "Ortiz" in items[0]["text"]
    assert items[0]["kind"] == "accepted"


def test_already_read_acceptance_is_not_repeated():
    assert accepted_items([{"id": "n1", "type": "proposal_accepted", "title": "Ortiz", "read": True}]) == []


def test_other_notification_types_are_ignored():
    assert accepted_items([{"id": "n2", "type": "system", "title": "Deploy", "read": False}]) == []


# ── waiting ──────────────────────────────────────────────────────────────────

def test_unanswered_message_and_unconfirmed_inspection_both_surface():
    items = waiting_items(
        [{"project_id": "p1", "customer_name": "Reed", "days_waiting": 2}],
        [{"id": "a1", "homeowner_name": "Blake", "preferred_date": "2026-08-22"}],
    )
    assert len(items) == 2
    assert "Reed" in items[0]["text"] and "(2d)" in items[0]["text"]
    assert "Blake" in items[1]["text"]


def test_waiting_handles_missing_names_without_crashing():
    items = waiting_items([{"project_id": "p1"}], [{"id": "a1"}])
    assert "A customer" in items[0]["text"]
    assert "A homeowner" in items[1]["text"]


# ── weather ──────────────────────────────────────────────────────────────────

def test_rainy_tomorrow_with_work_surfaces():
    items = weather_items(
        [{"crew_id": "c1", "crew_name": "Ramirez", "date": TOMORROW, "precip_probability": 78, "job_count": 2}],
        TOMORROW)
    assert len(items) == 1
    assert "Ramirez" in items[0]["text"] and "78%" in items[0]["text"]


def test_todays_weather_is_never_briefed():
    # The crew is already loading the truck — it isn't a decision any more.
    items = weather_items(
        [{"crew_id": "c1", "crew_name": "Ramirez", "date": "2026-08-18", "precip_probability": 90, "job_count": 2}],
        TOMORROW)
    assert items == []


def test_rain_below_threshold_is_not_worth_moving_a_job():
    items = weather_items(
        [{"crew_id": "c1", "crew_name": "R", "date": TOMORROW, "precip_probability": 35, "job_count": 2}], TOMORROW)
    assert items == []


def test_rain_on_a_day_with_no_work_is_not_a_briefing_line():
    items = weather_items(
        [{"crew_id": "c1", "crew_name": "R", "date": TOMORROW, "precip_probability": 95, "job_count": 0}], TOMORROW)
    assert items == []


def test_missing_forecast_does_not_crash():
    items = weather_items(
        [{"crew_id": "c1", "crew_name": "R", "date": TOMORROW, "precip_probability": None, "job_count": 2}], TOMORROW)
    assert items == []


# ── cold leads ───────────────────────────────────────────────────────────────

def test_cold_leads_collapse_to_one_line_with_the_worst_named():
    items = cold_lead_items({"stale_count": 4, "stale": [{"name": "Ortiz", "days": 12}, {"name": "Reed", "days": 9}]})
    assert len(items) == 1
    assert "4 leads going cold" in items[0]["text"]
    assert "Ortiz" in items[0]["text"]


def test_no_cold_leads_says_nothing():
    assert cold_lead_items({"stale_count": 0, "stale": []}) == []


# ── stuck work ───────────────────────────────────────────────────────────────

def test_stuck_work_lines():
    items = stuck_items(2, 1)
    assert len(items) == 2
    assert "2 roofs traced" in items[0]["text"]
    assert "1 finished report" in items[1]["text"]


def test_nothing_stuck_says_nothing():
    assert stuck_items(0, 0) == []


# ── assembly ─────────────────────────────────────────────────────────────────

def test_ordering_is_by_decay_speed_not_source_order():
    items = assemble([
        stuck_items(1, 0),
        cold_lead_items({"stale_count": 1, "stale": [{"name": "X", "days": 8}]}),
        accepted_items([{"id": "n1", "type": "proposal_accepted", "title": "Ortiz", "read": False}]),
    ])
    assert [i["kind"] for i in items] == ["accepted", "cold", "stuck"]


def test_briefing_is_capped_for_a_phone():
    many = [{"id": f"n{i}", "type": "proposal_accepted", "title": f"C{i}", "read": False} for i in range(20)]
    assert len(assemble([accepted_items(many)])) == MAX_ITEMS


def test_duplicate_keys_appear_once():
    dup = accepted_items([{"id": "n1", "type": "proposal_accepted", "title": "Ortiz", "read": False}])
    assert len(assemble([dup, dup])) == 1


def test_quiet_morning_produces_an_empty_briefing():
    # "Nothing needs you" is a valid, valuable answer — never pad it.
    assert assemble([accepted_items([]), waiting_items([], []), stuck_items(0, 0)]) == []


# ── helper ───────────────────────────────────────────────────────────────────

def test_days_since_parses_and_degrades():
    assert days_since("2026-08-11T09:00:00Z", TODAY) == 7
    assert days_since(None, TODAY) is None
    assert days_since("not a date", TODAY) is None
