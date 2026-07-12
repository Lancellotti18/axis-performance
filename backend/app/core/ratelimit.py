"""Best-effort in-memory rate limiter (per process, sliding hourly window).

Good enough as an abuse guard on a single Render instance; resets on restart.
If the backend ever scales past one instance, swap the dict for Redis
(REDIS_URL is already in config) — the call sites won't change.
"""
import time

_BUCKETS: dict[str, list[float]] = {}


def rate_ok(key: str, max_per_hour: int = 30) -> bool:
    """True if `key` is under its hourly budget; records the hit if so."""
    now = time.time()
    hits = [t for t in _BUCKETS.get(key, []) if now - t < 3600]
    if len(hits) >= max_per_hour:
        _BUCKETS[key] = hits
        return False
    hits.append(now)
    _BUCKETS[key] = hits
    return True
