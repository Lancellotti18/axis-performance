"""Project photos: the legacy table only allows before/during/after
(project_photos_phase_check). Until 20261011_project_photos_phase_check runs,
"In-progress" and "Completed" uploads must still save — under the legacy names —
and read back as the gallery's own phases. "Damage" has no legacy twin, so it
fails with a message naming the migration instead of a raw Postgres error."""
import asyncio
import io

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile

from app.api.v1 import project_photos as pp

USER = {"id": "u1", "email": ""}
LEGACY = {"before", "during", "after"}


class _Q:
    def __init__(self, db, table):
        self.db, self.table, self.filters, self.op, self.payload = db, table, [], "select", None
    def select(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def eq(self, col, val): self.filters.append((col, val)); return self
    def insert(self, row): self.op, self.payload = "insert", row; return self
    def execute(self):
        if self.op == "insert":
            if self.table == "project_photos" and self.payload["phase"] not in LEGACY:
                raise Exception('new row for relation "project_photos" violates check constraint '
                                '"project_photos_phase_check"')
            row = {**self.payload, "id": "ph1", "created_at": None}
            self.db.inserted.append(row)
            return type("R", (), {"data": [row]})()
        rows = [r for r in self.db.rows.get(self.table, []) if all(r.get(c) == v for c, v in self.filters)]
        return type("R", (), {"data": rows})()


class _Storage:
    def from_(self, _b): return self
    def upload(self, *a, **k): return {}
    def create_signed_url(self, *a, **k): return {"signedURL": "https://signed"}


class _DB:
    def __init__(self):
        self.rows = {"projects": [{"id": "p1", "name": "1 Main St", "user_id": "u1"}]}
        self.inserted = []
        self.storage = _Storage()
    def table(self, name): return _Q(self, name)


@pytest.fixture
def db(monkeypatch):
    d = _DB()
    monkeypatch.setattr(pp, "get_supabase", lambda: d)
    return d


def _upload(phase):
    f = UploadFile(file=io.BytesIO(b"\xff\xd8jpeg"), filename="a.jpg", headers={"content-type": "image/jpeg"})
    return asyncio.run(pp.upload_photo("p1", file=f, phase=phase, caption="", user=USER))


@pytest.mark.parametrize("phase,stored", [("before", "before"), ("progress", "during"), ("completed", "after")])
def test_legacy_constraint_still_saves_and_reads_back(db, phase, stored):
    out = _upload(phase)
    assert db.inserted[-1]["phase"] == stored
    assert out["phase"] == phase


def test_damage_names_the_migration(db):
    with pytest.raises(HTTPException) as e:
        _upload("damage")
    assert "20261011_project_photos_phase_check" in e.value.detail
