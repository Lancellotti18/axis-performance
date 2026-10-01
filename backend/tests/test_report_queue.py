"""Reports build two at a time, in arrival order, without freezing the server.

Before this, every report built at once on a small single-process backend that
has already been killed for running out of memory, and most of the build ran
on the event loop, so every other request waited behind it."""
import asyncio
import time

import pytest

from app.api.v1 import roofing_v2 as rv
from app.services import report_queue as rq


@pytest.fixture(autouse=True)
def fresh_queue(monkeypatch):
    # The semaphore binds to the event loop it is first used on, and each test
    # gets a new loop. Production has exactly one loop for the process.
    monkeypatch.setattr(rq, "_sem", None)
    monkeypatch.setattr(rq, "LIMIT", 2)
    rq._waiting.clear(); rq._building.clear(); rq._by_qid.clear(); rq._durations.clear()
    yield


@pytest.mark.asyncio
async def test_no_more_than_the_limit_build_at_once():
    live, peak = 0, 0

    async def job():
        nonlocal live, peak
        async with rq.slot():
            live += 1
            peak = max(peak, live)
            await asyncio.sleep(0.05)
            live -= 1

    await asyncio.gather(*(job() for _ in range(6)))
    assert peak == 2


@pytest.mark.asyncio
async def test_the_line_is_first_come_first_served_and_reports_position():
    release = asyncio.Event()
    order = []

    async def job(name):
        async with rq.slot(name):
            order.append(name)
            await release.wait()

    tasks = [asyncio.create_task(job(f"queue-id-{i}")) for i in range(5)]
    await asyncio.sleep(0.05)

    assert rq.status("queue-id-0")["state"] == "building"
    assert rq.status("queue-id-1")["state"] == "building"
    third = rq.status("queue-id-2")
    assert third["state"] == "waiting" and third["ahead"] == 0 and third["building"] == 2
    last = rq.status("queue-id-4")
    assert last["state"] == "waiting" and last["ahead"] == 2 and last["waiting"] == 3

    release.set()
    await asyncio.gather(*tasks)
    assert order == [f"queue-id-{i}" for i in range(5)]
    assert rq.status("queue-id-4")["state"] == "unknown"   # done, forgotten
    assert rq.typical_seconds() is not None


@pytest.mark.asyncio
async def test_a_request_cancelled_while_waiting_leaves_the_line():
    hold = asyncio.Event()

    async def job(name):
        async with rq.slot(name):
            await hold.wait()

    a = asyncio.create_task(job("queue-id-a"))
    b = asyncio.create_task(job("queue-id-b"))
    c = asyncio.create_task(job("queue-id-c"))       # waits
    await asyncio.sleep(0.05)
    assert rq.status("queue-id-c")["state"] == "waiting"
    c.cancel()                                        # browser gave up
    await asyncio.sleep(0.01)
    assert rq.status("queue-id-c")["state"] == "unknown"
    assert rq.status()["waiting"] == 0
    hold.set()
    await asyncio.gather(a, b)
    # Both slots came back: a fresh job gets in straight away.
    await asyncio.wait_for(job("queue-id-d"), timeout=1)


@pytest.mark.asyncio
async def test_the_server_keeps_answering_while_reports_build(monkeypatch):
    """The build is blocking work. Run through _build_and_store_report it must
    happen off the event loop, so other requests keep being served."""
    def slow_build(run_id, user_id=None):
        time.sleep(0.4)                               # blocking, like the real one
        return b"%PDF-fake", "f.pdf", None
    monkeypatch.setattr(rv, "_build_and_store_report_sync", slow_build)

    ticks = 0

    async def other_requests():
        nonlocal ticks
        end = time.monotonic() + 0.35
        while time.monotonic() < end:
            await asyncio.sleep(0.01)
            ticks += 1

    out, _ = await asyncio.gather(rv._build_and_store_report("run-1"), other_requests())
    assert out[0] == b"%PDF-fake"
    # A blocked loop would manage ~1 tick; a free one manages ~30.
    assert ticks > 10, ticks
