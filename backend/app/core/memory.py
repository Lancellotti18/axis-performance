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
