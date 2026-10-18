"""Heavy work hands memory back (app/core/memory.py) — Render restarts the
service at its memory limit, failing whatever a contractor was doing."""
import asyncio

from app.core import memory
from app.services import report_queue


def test_release_never_raises_and_reports_rss():
    memory.release()
    assert memory.rss_mb() >= 0


def test_a_report_build_releases_memory_when_its_slot_frees(monkeypatch):
    calls = []
    monkeypatch.setattr(memory, "release", lambda: calls.append(1))

    async def build():
        async with report_queue.slot("q-mem"):
            pass
    asyncio.run(build())
    assert calls == [1]
