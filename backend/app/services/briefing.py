"""The owner-operator's morning briefing — pure functions, no I/O.

Written for one specific reader: a contractor who sells AND runs the crews,
reading this on a phone at 6:30am. Their question is "what do I do first, and
who do I call" — so every line here has to imply an action. Anything that is
merely informative (utilization percentages, funnel counts, win-rate trends)
belongs on the page that owns it, not here. A briefing that reports status
becomes wallpaper, and once it's wallpaper the urgent lines stop landing too.

Ordering is by how fast the opportunity decays, not by how interesting it is:

  1. accepted  — someone said yes and nobody has called them back
  2. waiting   — someone is waiting on a reply from you
  3. weather   — tomorrow's job needs moving while there's still time
  4. cold      — leads going quiet; the call list
  5. stuck     — work half-finished that's blocking money

Everything is deterministic. The LLM narrates these lines; it never invents one.
"""
from __future__ import annotations

from datetime import date
from typing import Optional

# Lower sorts first. Kept explicit so the ordering is a stated decision rather
# than an accident of dict order.
SEVERITY = {"accepted": 1, "new_client": 2, "waiting": 3, "weather": 4, "cold": 5, "stuck": 6}

# A phone-sized briefing. Past this nobody reads to the bottom, and the lines
# that matter get buried by the ones that don't.
MAX_ITEMS = 6

# Rain probability at which a roof day is worth moving rather than gambling.
# Any rain the forecast is willing to commit to. The briefing does not cancel
# anything — it tells the dispatcher, who makes the call — so the bar for
# TELLING someone is deliberately low. A 40% chance they shrug off costs them
# nothing; a 40% chance nobody mentioned costs them a crew's morning.
RAIN_MOVE_THRESHOLD = 30
# Sustained wind at which you can't safely run shingles or keep people on a
# roof. Roofers lose more days to wind than most weather widgets suggest, and a
# dry, windy day still costs the crew — so it's a first-class trigger, not a
# footnote on the rain line.
WIND_MOVE_THRESHOLD = 20


def _item(kind: str, key: str, text: str, href: Optional[str] = None) -> dict:
    return {"kind": kind, "key": key, "severity": SEVERITY.get(kind, 9), "text": text, "href": href}


def accepted_items(notifications: list[dict]) -> list[dict]:
    """Proposals the homeowner accepted that nobody has acted on yet.

    The highest-value line in the product: the sale is already made and the only
    thing between it and a scheduled job is a phone call.
    """
    out = []
    for n in notifications:
        if (n.get("type") or "") != "proposal_accepted" or n.get("read"):
            continue
        who = (n.get("title") or "A homeowner").strip()
        out.append(_item("accepted", f"accepted:{n.get('id')}",
                         f"{who} — accepted your proposal. Call to get it on the board.",
                         n.get("link") or "/notifications"))
    return out


def new_client_items(leads: list[dict], today: date) -> list[dict]:
    """Leads sitting at stage `new` — nobody has made first contact yet.

    The briefing had no section for this at all, so a client added minutes ago
    matched nothing: `accepted` needs a signed proposal, `waiting` needs the
    homeowner to have messaged first or booked a visit, `cold` needs the lead to
    have gone stale. A brand-new lead is the one thing on this list where speed
    genuinely decides whether you win the job, and it was the one thing missing.

    Oldest first — the lead that has been sitting longest is the one bleeding.
    """
    out = []
    ranked = sorted(leads, key=lambda l: l.get("created_at") or "")
    for l in ranked[:3]:
        who = (l.get("name") or "A new lead").strip()
        days = days_since(l.get("created_at"), today)
        src = (l.get("source") or "").strip()
        via = f" via {src}" if src else ""
        if days is None or days <= 0:
            when = "came in today"
        elif days == 1:
            when = "came in yesterday"
        else:
            when = f"has been waiting {days} days"
        out.append(_item("new_client", f"new_client:{l.get('id')}",
                         f"{who}{via} — {when} and nobody has made contact. Call before someone else does.",
                         "/crm"))
    return out


def waiting_items(open_threads: list[dict], unconfirmed_appointments: list[dict]) -> list[dict]:
    """People waiting on YOU: unanswered portal messages, unconfirmed inspections.

    Both decay fast — a homeowner who waits two days books someone else — and
    both are cleared in under a minute, which is exactly what belongs near the
    top of a morning list.
    """
    out = []
    for t in open_threads:
        name = (t.get("customer_name") or "A customer").strip()
        days = t.get("days_waiting")
        age = f" ({days}d)" if isinstance(days, int) and days > 0 else ""
        out.append(_item("waiting", f"msg:{t.get('project_id')}",
                         f"{name} messaged you and hasn't had a reply{age}.",
                         f"/projects/{t.get('project_id')}" if t.get("project_id") else None))
    for a in unconfirmed_appointments:
        name = (a.get("homeowner_name") or "A homeowner").strip()
        when = a.get("preferred_date") or "a requested date"
        out.append(_item("waiting", f"appt:{a.get('id')}",
                         f"{name} requested an inspection for {when} — still unconfirmed.",
                         "/schedule"))
    return out


def weather_items(crew_days: list[dict], tomorrow: str) -> list[dict]:
    """Jobs worth moving because of tomorrow's forecast at the actual job site.

    Deliberately TOMORROW only. Today's weather is not a decision — the crew is
    already loading the truck — and putting it here just makes the briefing feel
    like something that reports problems instead of preventing them.

    Each row is expected to carry the WORST conditions across everywhere that
    crew is due to be that day, not the first stop only: a crew with a dry
    morning in Leland and a soaked afternoon in Hampstead still needs the call
    made. `site_count` and `location` let the line name where, which is the
    difference between a warning someone acts on and one they scroll past.
    """
    out = []
    for c in crew_days:
        if (c.get("date") or "") != tomorrow:
            continue
        jobs = c.get("job_count") or 0
        if not jobs:
            continue
        pp = c.get("precip_probability")
        wind = c.get("wind_mph")
        rainy = pp is not None and pp >= RAIN_MOVE_THRESHOLD
        windy = wind is not None and wind >= WIND_MOVE_THRESHOLD
        if not rainy and not windy:
            continue

        crew = (c.get("crew_name") or "A crew").strip()
        # Name the site when it's a single location; say how many when it isn't.
        sites = c.get("site_count") or 1
        where = c.get("location")
        at = f" at {where}" if where and sites == 1 else (f" across {sites} sites" if sites > 1 else "")

        if rainy and windy:
            cond = f"{round(pp)}% rain and {round(wind)} mph wind"
        elif rainy:
            cond = f"{round(pp)}% rain"
        else:
            cond = f"{round(wind)} mph wind"

        out.append(_item("weather", f"wx:{c.get('crew_id')}:{c.get('date')}",
                         f"{crew}: {cond} tomorrow{at} on {jobs} job{'' if jobs == 1 else 's'} — "
                         f"open the board to move {'it' if jobs == 1 else 'them'} to a dry day.",
                         # Land on the affected day with the dry-day proposals
                         # already open. The reschedule flow has always existed
                         # on the board; the briefing just never pointed at it,
                         # so the warning and the fix lived on separate screens.
                         f"/dispatch?date={c.get('date')}&reschedule=1"))
    return out


def cold_lead_items(crm_summary: dict) -> list[dict]:
    """The call list, as ONE line rather than a section.

    The CRM already ranks these; repeating the full list here would crowd out
    everything else. The count plus the worst offender is enough to decide
    whether to open the CRM.
    """
    stale = crm_summary.get("stale") or []
    if not stale:
        return []
    n = crm_summary.get("stale_count") or len(stale)
    worst = stale[0]
    tail = f" Longest: {worst.get('name')} at {worst.get('days')}d." if worst.get("name") else ""
    return [_item("cold", "cold:leads",
                  f"{n} lead{'' if n == 1 else 's'} going cold.{tail}", "/crm")]


def stuck_items(unfinalized_roofs: int, unsent_reports: int) -> list[dict]:
    """Work already paid for in effort but not yet turned into money."""
    out = []
    if unfinalized_roofs:
        out.append(_item("stuck", "stuck:roofs",
                         f"{unfinalized_roofs} roof{'' if unfinalized_roofs == 1 else 's'} traced but not finalized — "
                         f"can't be quoted until confirmed.", "/roof-v2"))
    if unsent_reports:
        out.append(_item("stuck", "stuck:reports",
                         f"{unsent_reports} finished report{'' if unsent_reports == 1 else 's'} never sent to the customer.",
                         "/reports"))
    return out


def assemble(groups: list[list[dict]], limit: int = MAX_ITEMS,
             exclude: Optional[set] = None) -> list[dict]:
    """Flatten, drop snoozed keys, order by decay speed, and cap.

    De-duplicates on `key` so the same thing can't arrive from two sources and
    appear twice — which would be the fastest way to make this look untrustworthy.

    `exclude` is applied BEFORE the cap on purpose: snoozing a line should hand
    its slot to the next real item, not leave a five-line card with a hole in it.
    """
    exclude = exclude or set()
    seen: set = set()
    flat: list[dict] = []
    for g in groups:
        for item in g:
            k = item.get("key")
            if k in seen or k in exclude:
                continue
            seen.add(k)
            flat.append(item)
    flat.sort(key=lambda i: (i.get("severity", 9), i.get("key") or ""))
    return flat[:limit]


def days_since(value, today: date) -> Optional[int]:
    """Whole days between an ISO-ish timestamp and today. None if unparseable."""
    if not value:
        return None
    try:
        d = date.fromisoformat(str(value)[:10])
    except ValueError:
        return None
    return max(0, (today - d).days)
