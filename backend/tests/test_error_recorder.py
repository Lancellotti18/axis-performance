"""Failures have to be visible somewhere, and recording one must never break
the request it is recording.

Before this there was no error monitoring at all: an unhandled exception hit
Render's console and nothing else. A contractor's 500 at 7am was invisible
until they mentioned it.
"""
from __future__ import annotations

from app.core import errors


def _clear():
    errors._recent.clear()


def test_records_a_failure_with_context():
    _clear()
    try:
        raise ValueError("roof went sideways")
    except ValueError as e:
        errors.record(e, path="/api/v1/roofing/v2/runs", method="POST", user_id="u1")
    got = errors.recent()
    assert len(got) == 1
    e = got[0]
    assert e["type"] == "ValueError"
    assert "roof went sideways" in e["message"]
    assert e["path"] == "/api/v1/roofing/v2/runs" and e["method"] == "POST"
    assert e["user_id"] == "u1"
    assert "ValueError" in e["traceback"]


def test_newest_first():
    _clear()
    for i in range(3):
        try:
            raise RuntimeError(f"boom {i}")
        except RuntimeError as e:
            errors.record(e, path=f"/p{i}")
    assert [e["path"] for e in errors.recent()] == ["/p2", "/p1", "/p0"]


def test_the_window_is_bounded():
    """It is a window on the recent past, not a leak."""
    _clear()
    for i in range(errors._MAX + 25):
        try:
            raise KeyError(i)
        except KeyError as e:
            errors.record(e, path="/x")
    assert len(errors._recent) == errors._MAX


def test_recording_never_raises():
    """A monitoring layer that can fail the request it monitors is worse than
    none — so a hostile context must not propagate."""
    _clear()

    class Nasty:
        def __repr__(self): raise RuntimeError("cannot repr")
        def __str__(self): raise RuntimeError("cannot str")

    try:
        raise ValueError("ok")
    except ValueError as e:
        errors.record(e, path="/x", context={"bad": Nasty()})   # must not raise


def test_summary_groups_by_type_and_path():
    _clear()
    for path, exc in (("/a", ValueError), ("/a", ValueError), ("/b", KeyError)):
        try:
            raise exc("x")
        except Exception as e:
            errors.record(e, path=path)
    s = errors.summary()
    assert s["captured"] == 3
    assert s["by_type"]["ValueError"] == 2
    assert s["by_path"]["/a"] == 2
    assert s["most_recent"] is not None


def test_empty_summary_is_safe():
    _clear()
    s = errors.summary()
    assert s["captured"] == 0 and s["most_recent"] is None
