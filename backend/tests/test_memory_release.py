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


def test_memory_health_warns_before_render_restarts_the_service(monkeypatch):
    monkeypatch.setattr(memory, "limit_mb", lambda: 2048)
    monkeypatch.setattr(memory, "rss_mb", lambda: 400)
    check, problem = memory.health()
    assert check["used_pct"] == 20 and problem is None

    monkeypatch.setattr(memory, "rss_mb", lambda: 1500)          # 73%
    _, problem = memory.health()
    assert problem.startswith("WARN")

    monkeypatch.setattr(memory, "rss_mb", lambda: 1800)          # 88%
    _, problem = memory.health()
    assert problem.startswith("HIGH")


def test_unknown_limit_never_alarms(monkeypatch):
    monkeypatch.setattr(memory, "limit_mb", lambda: 0)
    assert memory.health()[1] is None
