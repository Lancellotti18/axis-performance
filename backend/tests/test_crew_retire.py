"""Retiring a crew must only be blocked by work that still needs it.

The reported bug: "won't let me delete crews, says it has a job scheduled but
no job is scheduled". The board loads one week at a time, while the old guard
refused on ANY sched_assignment row ever written for the crew — so a job
finished last month, or booked for next month, blocked the delete with a
message the dispatcher could see no evidence for.
"""
from app.services.scheduling.capacity import split_crew_work

TODAY = "2026-08-16"


def _appt(start, status="SCHEDULED", id_="a"):
    return {"id": id_, "scheduled_start": f"{start}T08:00:00", "status": status}


def test_no_work_at_all_is_clear():
    assert split_crew_work([], TODAY) == ([], 0)


def test_past_job_does_not_block():
    # The reported case: finished work in a week the board isn't showing.
    upcoming, finished = split_crew_work([_appt("2026-07-02", "DONE")], TODAY)
    assert upcoming == []
    assert finished == 1


def test_past_job_still_marked_scheduled_does_not_block():
    # Nobody closes out every job. A stale SCHEDULED in the past is history.
    upcoming, finished = split_crew_work([_appt("2026-07-02", "SCHEDULED")], TODAY)
    assert upcoming == []
    assert finished == 1


def test_canceled_and_unassigned_do_not_block():
    upcoming, finished = split_crew_work(
        [_appt("2026-09-01", "CANCELED"), _appt("2026-09-02", "UNASSIGNED")], TODAY)
    assert upcoming == []
    assert finished == 2


def test_future_job_blocks():
    upcoming, finished = split_crew_work([_appt("2026-09-01")], TODAY)
    assert len(upcoming) == 1
    assert finished == 0


def test_job_today_blocks():
    # Today's work is live work — the crew is on a roof right now.
    upcoming, _ = split_crew_work([_appt(TODAY, "WORKING")], TODAY)
    assert len(upcoming) == 1


def test_blocking_job_reported_is_the_soonest():
    # The 409 names this date, so it has to be the one to go looking for.
    upcoming, _ = split_crew_work(
        [_appt("2026-10-05", id_="late"), _appt("2026-08-20", id_="soon"),
         _appt("2026-09-01", id_="mid")], TODAY)
    assert [r["id"] for r in upcoming] == ["soon", "mid", "late"]


def test_mixed_history_and_future_blocks_and_counts():
    upcoming, finished = split_crew_work(
        [_appt("2026-07-01", "DONE"), _appt("2026-07-15", "DONE"), _appt("2026-08-30")], TODAY)
    assert len(upcoming) == 1
    assert finished == 2


def test_missing_start_is_treated_as_live():
    # No date means we can't prove it's behind us — refuse rather than silently
    # retire a crew that might still be on the hook.
    upcoming, finished = split_crew_work([{"id": "x", "status": "SCHEDULED"}], TODAY)
    assert len(upcoming) == 1
    assert finished == 0
