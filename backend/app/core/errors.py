"""Somewhere for failures to be seen.

There was no error monitoring at all: an unhandled exception was logged to
Render's console and nothing else. In practice that means a contractor hits a
500 at 7am and you find out when they tell you — or when they quietly stop
using it.

This is deliberately small. It keeps the last N failures in memory with enough
context to act on (path, method, user, the exception, a trimmed traceback) and
exposes them behind auth. In-memory means they do NOT survive a restart, which
is fine for "what is breaking right now" and useless for trend analysis — so
the module also forwards to Sentry when SENTRY_DSN is configured, with no code
change needed to turn that on.

Never let recording an error raise. A monitoring layer that can fail the
request it is monitoring is worse than none.
"""
from __future__ import annotations

import logging
import traceback
from collections import deque
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Small on purpose. This is a window on the recent past, not a database.
_MAX = 200
_recent: deque[dict] = deque(maxlen=_MAX)

_sentry: Any = None
_sentry_tried = False


def _sentry_client():
    """Load Sentry only if a DSN is configured and the SDK is installed."""
    global _sentry, _sentry_tried
    if _sentry_tried:
        return _sentry
    _sentry_tried = True
    try:
        from app.core.config import settings
        dsn = getattr(settings, "SENTRY_DSN", "")
        if not dsn:
            return None
        import sentry_sdk
        sentry_sdk.init(dsn=dsn, traces_sample_rate=0.0, send_default_pii=False)
        _sentry = sentry_sdk
        logger.info("Sentry initialised for error reporting")
    except Exception as e:
        logger.info("Sentry not enabled (%s)", e)
        _sentry = None
    return _sentry


def record(
    exc: BaseException,
    *,
    path: str = "",
    method: str = "",
    user_id: Optional[str] = None,
    context: Optional[dict] = None,
) -> None:
    """Capture one failure. Swallows everything — never raises."""
    try:
        tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        entry = {
            "at": datetime.now(timezone.utc).isoformat(),
            "type": type(exc).__name__,
            "message": str(exc)[:500],
            "path": path,
            "method": method,
            "user_id": user_id,
            "context": context or {},
            # Tail, not head: the frames nearest the failure are the useful ones.
            "traceback": tb[-2500:],
        }
        _recent.appendleft(entry)

        sdk = _sentry_client()
        if sdk is not None:
            with sdk.push_scope() as scope:
                scope.set_tag("path", path)
                scope.set_tag("method", method)
                if user_id:
                    scope.set_user({"id": user_id})
                for k, v in (context or {}).items():
                    scope.set_extra(k, v)
                sdk.capture_exception(exc)
    except Exception:
        logger.warning("error recorder failed", exc_info=True)


def recent(limit: int = 50) -> list[dict]:
    return list(_recent)[:limit]


def summary() -> dict:
    """Counts by type and path — enough to see a pattern at a glance."""
    by_type: dict[str, int] = {}
    by_path: dict[str, int] = {}
    for e in _recent:
        by_type[e["type"]] = by_type.get(e["type"], 0) + 1
        if e.get("path"):
            by_path[e["path"]] = by_path.get(e["path"], 0) + 1
    return {
        "captured": len(_recent),
        "window": _MAX,
        "sentry_enabled": _sentry_client() is not None,
        "by_type": dict(sorted(by_type.items(), key=lambda kv: -kv[1])),
        "by_path": dict(sorted(by_path.items(), key=lambda kv: -kv[1])[:15]),
        "most_recent": _recent[0]["at"] if _recent else None,
    }
