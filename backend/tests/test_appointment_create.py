"""POST /appointments: a contractor adds their own inspection. It belongs to the
caller, starts confirmed, and refuses past dates or an entry with nowhere to go."""
import asyncio
from datetime import date, timedelta

import pytest
from fastapi import HTTPException

from app.api.v1 import appointments as ap

USER = {"id": "u1", "email": "c@example.com"}


class _Q:
    def __init__(self, db): self.db, self.payload = db, None
    def insert(self, row): self.payload = row; return self
    def execute(self):
        row = {**self.payload, "id": "a1"}
        self.db.inserted.append(row)
        return type("R", (), {"data": [row]})()


class _DB:
    def __init__(self): self.inserted = []
    def table(self, _name): return _Q(self)


@pytest.fixture
def db(monkeypatch):
    d = _DB()
    monkeypatch.setattr(ap, "get_supabase", lambda: d)
    return d


def _create(**kw):
    body = ap.CreateAppointment(**{"preferred_date": (date.today() + timedelta(days=2)).isoformat(), **kw})
    return asyncio.run(ap.create_appointment(body, user=USER))


def test_creates_confirmed_for_caller(db):
    out = _create(address="12 Oak St", time_window="morning")
    row = db.inserted[0]
    assert row["user_id"] == "u1" and row["status"] == "confirmed"
    assert row["time_window"] == "morning" and out["lead"] is None


def test_bad_window_falls_back(db):
    _create(address="12 Oak St", time_window="midnight")
    assert db.inserted[0]["time_window"] == "anytime"


@pytest.mark.parametrize("kw", [
    {"preferred_date": (date.today() - timedelta(days=1)).isoformat(), "address": "12 Oak St"},
    {"address": "  ", "homeowner_name": ""},
    {"address": "12 Oak St", "homeowner_email": "not-an-email"},
])
def test_rejects(db, kw):
    with pytest.raises(HTTPException) as e:
        _create(**kw)
    assert e.value.status_code == 422
    assert not db.inserted
