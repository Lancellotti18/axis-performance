"""What each model call cost, and who it was for.

Every provider in llm.py returns a plain string; the token counts on the raw
response were thrown away. That left model choice to be argued from `max_tokens`
caps instead of measurement — the difference between Gemini Flash and Opus 5 at
2,000 reports/month is roughly $39 vs $486, and nothing in the system could say
which end of that range Axis was actually at.

Attribution rides a contextvar rather than a parameter. The vision calls sit
five or six frames below the request handler, through helpers that have no
business knowing about billing; threading `user_id` down to them would have
meant touching every signature in the measurement path. The API layer sets the
context once and every call underneath is attributed automatically.

Best-effort throughout: metering must never be the reason a contractor's report
fails. Every write is wrapped, and a missing table degrades to a log line.
"""
from __future__ import annotations

import contextvars
import logging
from contextlib import contextmanager
from typing import Optional

logger = logging.getLogger(__name__)

# (user_id, run_id) for whatever request is in flight on this task.
_ctx: contextvars.ContextVar[tuple[Optional[str], Optional[str]]] = contextvars.ContextVar(
    "llm_usage_ctx", default=(None, None)
)


@contextmanager
def attribute_to(user_id: Optional[str], run_id: Optional[str] = None):
    """Attribute every model call inside this block to a contractor and run.

    contextvars are task-local, so concurrent requests do not bleed into each
    other's attribution the way a module-level global would.
    """
    token = _ctx.set((user_id, run_id))
    try:
        yield
    finally:
        _ctx.reset(token)


# ── Rates, USD per 1M tokens (input, output) ───────────────────────────────
# Checked 2026-09-07. These are used to price a call at the moment it happens;
# the computed cost is stored on the row, so editing this table never rewrites
# what history says was spent.
_RATES: dict[str, tuple[float, float]] = {
    # Google — ai.google.dev/gemini-api/docs/pricing
    "gemini-2.5-flash":       (0.30, 2.50),
    "gemini-2.5-flash-lite":  (0.10, 0.40),
    "gemini-2.5-pro":         (1.25, 10.00),
    "gemini-2.0-flash":       (0.10, 0.40),   # priced as Flash-Lite; verify
    # Anthropic
    "claude-opus-5":     (5.00, 25.00),
    "claude-sonnet-5":   (2.00, 10.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-haiku-4-5":  (1.00, 5.00),
    # Groq is free/very low at current volume; recorded at zero so the token
    # counts still land and only the dollar figure is understated.
    "_groq_default":     (0.0, 0.0),
}


def _rate_for(model: str) -> tuple[float, float]:
    """Longest-prefix match, so a dated or suffixed model id still prices."""
    if model in _RATES:
        return _RATES[model]
    best = ""
    for known in _RATES:
        if model.startswith(known) and len(known) > len(best):
            best = known
    if best:
        return _RATES[best]
    if "groq" in model or "llama" in model.lower():
        return _RATES["_groq_default"]
    return (0.0, 0.0)


def price(model: str, input_tokens: int, output_tokens: int) -> float:
    inp, out = _rate_for(model)
    return round((input_tokens / 1_000_000) * inp + (output_tokens / 1_000_000) * out, 6)


def record(
    provider: str,
    model: str,
    kind: str,
    input_tokens: int,
    output_tokens: int,
) -> None:
    """Log one model call. Never raises."""
    try:
        if not input_tokens and not output_tokens:
            return  # nothing measurable — a provider that reported no usage
        user_id, run_id = _ctx.get()
        cost = price(model, input_tokens, output_tokens)
        from app.core.supabase import get_supabase
        get_supabase().table("llm_usage").insert({
            "user_id": user_id,
            "run_id": run_id,
            "provider": provider,
            "model": model,
            "kind": kind,
            "input_tokens": int(input_tokens),
            "output_tokens": int(output_tokens),
            "cost_usd": cost,
        }).execute()
    except Exception as e:
        logger.info("llm usage not recorded (%s/%s): %s", provider, model, e)


def record_report(user_id: str, run_id: str, kind: str, pdf_bytes: int) -> None:
    """Log a generated report. `kind` is 'generate' (billable) or 'rebuild'."""
    try:
        from app.core.supabase import get_supabase
        get_supabase().table("report_events").insert({
            "user_id": user_id,
            "run_id": run_id,
            "kind": kind,
            "bytes": int(pdf_bytes),
        }).execute()
    except Exception as e:
        logger.info("report event not recorded for run %s: %s", run_id, e)


def already_generated(db, run_id: str) -> bool:
    """Has this run ever produced a billable report? Drives generate/rebuild.

    Fails CLOSED — on error it reports True, so an outage under-counts rather
    than double-charging a contractor for a report they already own.
    """
    try:
        rows = (
            db.table("report_events").select("id")
            .eq("run_id", run_id).eq("kind", "generate").limit(1).execute().data
        ) or []
        return bool(rows)
    except Exception:
        return True
