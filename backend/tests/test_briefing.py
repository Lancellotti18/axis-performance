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

def _wx(pp=None, wind=None, jobs=2, city="Hampstead", sites=1, date=TOMORROW):
    return {"crew_id": "c1", "crew_name": "Ramirez", "date": date,
            "precip_probability": pp, "wind_mph": wind, "job_count": jobs,
            "location": city, "site_count": sites}


def test_rainy_tomorrow_names_crew_condition_and_site():
    items = weather_items([_wx(pp=78)], TOMORROW)
    assert len(items) == 1
    t = items[0]["text"]
    assert "Ramirez" in t and "78% rain" in t and "at Hampstead" in t


def test_high_wind_alone_grounds_a_crew():
    # A dry, windy day still costs the crew — you can't run shingles at 30mph.
    items = weather_items([_wx(wind=32)], TOMORROW)
    assert len(items) == 1
    assert "32 mph wind" in items[0]["text"]
    assert "rain" not in items[0]["text"]


def test_rain_and_wind_report_together():
    items = weather_items([_wx(pp=70, wind=28)], TOMORROW)
    assert "70% rain and 28 mph wind" in items[0]["text"]


def test_breezy_but_dry_is_not_worth_a_line():
    assert weather_items([_wx(pp=10, wind=18)], TOMORROW) == []


def test_multi_site_day_says_how_many_rather_than_naming_one():
    # Naming one town when the crew is in three is worse than saying "3 sites".
    items = weather_items([_wx(pp=80, sites=3)], TOMORROW)
    assert "across 3 sites" in items[0]["text"]
    assert "Hampstead" not in items[0]["text"]


def test_todays_weather_is_never_briefed():
    # The crew is already loading the truck — it isn't a decision any more.
    assert weather_items([_wx(pp=90, date="2026-08-18")], TOMORROW) == []


def test_rain_below_threshold_is_not_worth_moving_a_job():
    assert weather_items([_wx(pp=35)], TOMORROW) == []


def test_rain_on_a_day_with_no_work_is_not_a_briefing_line():
    assert weather_items([_wx(pp=95, jobs=0)], TOMORROW) == []


def test_missing_forecast_does_not_crash():
    assert weather_items([_wx()], TOMORROW) == []


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


# ── snooze ───────────────────────────────────────────────────────────────────

def test_snoozed_key_is_hidden():
    accepted = accepted_items([{"id": "n1", "type": "proposal_accepted", "title": "Ortiz", "read": False}])
    assert assemble([accepted], exclude={"accepted:n1"}) == []


def test_snoozing_promotes_the_next_item_rather_than_leaving_a_gap():
    # 7 candidates, cap of 6: snoozing one must pull the 7th up, not show 5.
    many = [{"id": f"n{i}", "type": "proposal_accepted", "title": f"C{i}", "read": False} for i in range(7)]
    items = assemble([accepted_items(many)], exclude={"accepted:n0"})
    assert len(items) == MAX_ITEMS
    assert "accepted:n0" not in {i["key"] for i in items}


def test_unknown_exclusions_are_harmless():
    accepted = accepted_items([{"id": "n1", "type": "proposal_accepted", "title": "Ortiz", "read": False}])
    assert len(assemble([accepted], exclude={"nothing:matches"})) == 1
