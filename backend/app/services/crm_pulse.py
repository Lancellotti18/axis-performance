"""CRM signal for the morning briefing — pure functions, no I/O.

The briefing used to speak only for the dispatch board: crews, capacity, weather.
That's half a contractor's morning. The other half is money that hasn't been
chased — a quote sent nine days ago that nobody followed up, a pipeline whose
value is sitting in "contacted" and not moving.

Everything here is deterministic and tested. As with the dispatch brief, the LLM
only narrates these numbers; it never invents them.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Optional

# The pipeline, in order. 'won'/'lost' are terminal and never "stale".
PIPELINE_STAGES = ["new", "contacted", "site_visit", "estimate_sent"]
TERMINAL_STAGES = {"won", "lost"}

# How long a lead can sit untouched in a stage before it's worth a nudge. An
# estimate going cold costs the most, so it gets the shortest fuse.
STALE_AFTER_DAYS: dict[str, int] = {
    "new": 2,
    "contacted": 5,
    "site_visit": 5,
    "estimate_sent": 4,
}
_DEFAULT_STALE_DAYS = 7


def _as_date(v) -> Optional[date]:
    """Parse the assorted timestamp shapes Supabase hands back."""
    if not v:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip()
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def _money(v) -> float:
    try:
        n = float(v)
        return n if n > 0 else 0.0
    except (TypeError, ValueError):
        return 0.0


def days_untouched(lead: dict, today: date) -> Optional[int]:
    """Days since the lead last moved. Prefers updated_at, falls back to created_at."""
    when = _as_date(lead.get("updated_at")) or _as_date(lead.get("created_at"))
    if not when:
        return None
    return max(0, (today - when).days)


def is_stale(lead: dict, today: date) -> bool:
    stage = (lead.get("stage") or "new").lower()
    if stage in TERMINAL_STAGES:
        return False
    d = days_untouched(lead, today)
    if d is None:
        return False
    return d >= STALE_AFTER_DAYS.get(stage, _DEFAULT_STALE_DAYS)


def summarize_leads(leads: list[dict], today: date) -> dict:
    """Deterministic CRM facts for the dashboard briefing.

    `open_value` deliberately counts only live pipeline stages — rolling won and
    lost into a "pipeline" figure is how CRMs end up quoting a number nobody can
    act on.
    """
    by_stage: dict[str, int] = {s: 0 for s in PIPELINE_STAGES}
    by_stage.update({"won": 0, "lost": 0})
    open_value = 0.0
    won_value = 0.0
    stale: list[dict] = []

    for lead in leads:
        stage = (lead.get("stage") or "new").lower()
        if stage not in by_stage:
            by_stage[stage] = 0
        by_stage[stage] += 1
        value = _money(lead.get("estimated_value"))
        if stage == "won":
            won_value += value
        elif stage not in TERMINAL_STAGES:
            open_value += value
            if is_stale(lead, today):
                stale.append({
                    "id": lead.get("id"),
                    "name": lead.get("name") or "Unnamed lead",
                    "stage": stage,
                    "days": days_untouched(lead, today) or 0,
                    "value": value,
                })

    # Longest-neglected first — that's the call to make before the others.
    stale.sort(key=lambda r: (-r["days"], -r["value"]))

    open_count = sum(by_stage.get(s, 0) for s in PIPELINE_STAGES)
    decided = by_stage.get("won", 0) + by_stage.get("lost", 0)
    win_rate = round(by_stage.get("won", 0) / decided * 100) if decided else None

    return {
        "total": len(leads),
        "by_stage": by_stage,
        "open_count": open_count,
        "open_value": round(open_value, 2),
        "won_value": round(won_value, 2),
        "win_rate_pct": win_rate,
        "stale_count": len(stale),
        "stale": stale[:6],
        "awaiting_estimate_response": by_stage.get("estimate_sent", 0),
    }


def pulse_lines(summary: dict) -> list[str]:
    """One-line facts for the briefing, most actionable first.

    Empty when there's genuinely nothing to say — a briefing that manufactures
    filler stops getting read.
    """
    lines: list[str] = []
    stale = summary.get("stale") or []
    if stale:
        worst = stale[0]
        lines.append(
            f"{summary['stale_count']} lead{'' if summary['stale_count'] == 1 else 's'} "
            f"need chasing — longest is {worst['name']} at {worst['days']} days in "
            f"{worst['stage'].replace('_', ' ')}."
        )
    awaiting = summary.get("awaiting_estimate_response", 0)
    if awaiting:
        lines.append(f"{awaiting} estimate{'' if awaiting == 1 else 's'} sent and awaiting an answer.")
    if summary.get("open_value"):
        lines.append(
            f"${summary['open_value']:,.0f} in open pipeline across "
            f"{summary['open_count']} lead{'' if summary['open_count'] == 1 else 's'}."
        )
    if summary.get("win_rate_pct") is not None:
        lines.append(f"Win rate {summary['win_rate_pct']}% on closed leads.")
    return lines
