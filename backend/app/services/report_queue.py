"""A line for roof-report builds.

A report is the heaviest thing this service does: a dozen database reads, a
logo download, the PDF and its diagrams drawn with ReportLab and PIL, then a
~4 MB upload. The backend is one process on a small instance that has already
been killed for running out of memory, and nothing used to stop five
contractors' reports from building at once — each holding its roof imagery in
memory — while every other request on the server waited behind them.

This caps how many build at a time (REPORT_CONCURRENCY, default 2) and keeps
everyone else in a first-come, first-served line. Each request can carry a
`queue_id` chosen by the browser, so the page can ask "where am I?" while it
waits and show "2 ahead of you" instead of a spinner that looks hung.

In-process only: correct while the backend runs as one process, which it
does today. More than one worker would need this moved into the database.
"""
from __future__ import annotations

import asyncio
import itertools
import os
import time
from contextlib import asynccontextmanager
from typing import Optional

LIMIT = max(1, int(os.getenv("REPORT_CONCURRENCY", "2") or 2))

_sem: Optional[asyncio.Semaphore] = None
_tickets = itertools.count(1)
_waiting: dict[int, Optional[str]] = {}     # ticket -> queue_id, in arrival order
_building: dict[int, Optional[str]] = {}
_by_qid: dict[str, int] = {}
# Recent build times, so the page can say roughly how long the wait is.
_durations: list[float] = []


def _semaphore() -> asyncio.Semaphore:
    # Created on first use so it binds to the running event loop.
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(LIMIT)
    return _sem


def typical_seconds() -> Optional[float]:
    if not _durations:
        return None
    s = sorted(_durations)
    return round(s[len(s) // 2], 1)


@asynccontextmanager
async def slot(queue_id: Optional[str] = None):
    """Wait for a free build slot, then hold it for the duration of the block."""
    ticket = next(_tickets)
    _waiting[ticket] = queue_id
    if queue_id:
        _by_qid[queue_id] = ticket
    try:
        await _semaphore().acquire()
    except BaseException:
        _waiting.pop(ticket, None)
        if queue_id:
            _by_qid.pop(queue_id, None)
        raise
    _waiting.pop(ticket, None)
    _building[ticket] = queue_id
    started = time.monotonic()
    try:
        yield
    finally:
        _building.pop(ticket, None)
        if queue_id:
            _by_qid.pop(queue_id, None)
        _durations.append(time.monotonic() - started)
        del _durations[:-20]
        _semaphore().release()


def status(queue_id: Optional[str] = None) -> dict:
    """Where a request stands. `ahead` is how many requests are waiting in
    line in front of it; `building` is how many are being built right now."""
    out = {"limit": LIMIT, "building": len(_building), "waiting": len(_waiting),
           "typical_seconds": typical_seconds(), "state": "unknown", "ahead": 0}
    ticket = _by_qid.get(queue_id) if queue_id else None
    if ticket is None:
        return out
    if ticket in _building:
        out["state"] = "building"
        return out
    if ticket in _waiting:
        out["state"] = "waiting"
        out["ahead"] = sum(1 for t in _waiting if t < ticket)
    return out
