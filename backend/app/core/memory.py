"""Hand memory back to the operating system after heavy work.

Render restarts the service the moment it crosses its memory limit, failing
whatever was in flight (2026-10-14: an "exceeded memory limit" email while the
first founding contractors were trying the app). Measured locally, no single
job comes close: the app idles near 130 MB, a report build peaks near 180 MB,
an auto-measure adds about 140 MB. What fills the gap over hours is glibc
keeping memory Python has already freed — worse with worker threads, which the
report builds use — so the process creeps up until one busy moment tips it over.

release() collects garbage and asks glibc to return free pages (malloc_trim).
It is cheap, never raises, and is a no-op where glibc is absent (macOS dev).
MALLOC_ARENA_MAX=2 in the Dockerfile caps the per-thread arenas that cause the
hoarding in the first place; this covers the case where that is not applied.
"""
from __future__ import annotations

import ctypes
import gc
import logging

logger = logging.getLogger(__name__)

try:
    _libc = ctypes.CDLL("libc.so.6")
except OSError:
    _libc = None


def rss_mb() -> int:
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return 0


def release() -> None:
    try:
        gc.collect()
        if _libc is not None:
            _libc.malloc_trim(0)
    except Exception as e:                      # never let housekeeping fail a request
        logger.debug("memory release skipped: %s", e)


def limit_mb() -> int:
    """The container's memory limit in MB (cgroup v2, then v1), or 0 if unknown.
    Read from the system rather than configured, so it follows a plan change."""
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            raw = open(path).read().strip()
        except OSError:
            continue
        if raw.isdigit():
            mb = int(raw) // (1024 * 1024)
            if 0 < mb < 1_000_000:          # "no limit" reads as a huge number
                return mb
    return 0


def health() -> tuple[dict, str | None]:
    """(check, problem) for the deep health check: warn well before Render's
    limit restarts the service, rather than finding out from a failed report."""
    used, limit = rss_mb(), limit_mb()
    check = {"rss_mb": used, "limit_mb": limit or None}
    if not limit or not used:
        return check, None
    pct = round(100 * used / limit)
    check["used_pct"] = pct
    if pct >= 85:
        return check, (f"HIGH: the server is using {used} MB of its {limit} MB memory ({pct}%). "
                       "Render restarts it at 100%, failing whatever is in progress.")
    if pct >= 70:
        return check, (f"WARN: the server is using {used} MB of its {limit} MB memory ({pct}%) "
                       "and is getting close to Render's limit.")
    return check, None
