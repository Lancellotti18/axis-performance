"""POST /appointments/book/{token}: booking the same day twice from the same
report (a double-click, or coming back to the page) must not create a second
inspection, ping the bell again, or text the contractor again. A different day
is a real second request and still books."""
import asyncio
from datetime import date, timedelta

import pytest

from app.api.v1 import appointments as ap


class _Q:
    def __init__(self, db, table):
        self.db, self.table, self.filters, self.op, self.payload = db, table, [], "select", None
    def select(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def eq(self, col, val): self.filters.append((col, lambda v, x=val: v == x)); return self
    def in_(self, col, vals): self.filters.append((col, lambda v, xs=tuple(vals): v in xs)); return self
    def insert(self, row): self.op, self.payload = "insert", dict(row, id=f"r{len(self.db.rows.get(self.table, []))}"); return self
    def execute(self):
        if self.op == "insert":
            self.db.rows.setdefault(self.table, []).append(self.payload)
            return type("R", (), {"data": [self.payload]})()
        rows = [r for r in self.db.rows.get(self.table, []) if all(f(r.get(c)) for c, f in self.filters)]
        return type("R", (), {"data": rows})()


class _DB:
    def __init__(self, rows): self.rows = rows
    def table(self, name): return _Q(self, name)


class _Req:
    client = type("C", (), {"host": "1.2.3.4"})()


@pytest.fixture
def db(monkeypatch):
    d = _DB({"widget_leads": [{"id": "w1", "user_id": "u1", "report_token": "tok", "name": "Pat", "phone": None}]})
    monkeypatch.setattr(ap, "get_supabase", lambda: d)
    monkeypatch.setattr(ap, "rate_ok", lambda *a, **k: True)
    return d


def _book(day, window="morning"):
    body = ap.BookRequest(preferred_date=day.isoformat(), time_window=window)
    return asyncio.run(ap.book_inspection("tok", body, _Req()))


def test_same_day_twice_books_once(db):
    day = date.today() + timedelta(days=3)
    first, second = _book(day), _book(day, "afternoon")
    assert first["ok"] and second["ok"] and second.get("duplicate")
    assert second["time_window"] == "morning"          # reports the booking that exists
    assert len(db.rows["inspection_appointments"]) == 1


def test_a_different_day_is_a_new_request(db):
    day = date.today() + timedelta(days=3)
    _book(day); _book(day + timedelta(days=1))
    assert len(db.rows["inspection_appointments"]) == 2


def test_a_cancelled_booking_does_not_block_rebooking(db):
    day = date.today() + timedelta(days=3)
    _book(day)
    db.rows["inspection_appointments"][0]["status"] = "cancelled"
    _book(day)
    assert len(db.rows["inspection_appointments"]) == 2
