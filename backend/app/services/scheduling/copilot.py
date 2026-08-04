"""Axis Copilot — the deterministic core of the AI layer (M5.5).

Per docs/crew-scheduling-ai-layer.md guardrail A0.1: *every number* the Copilot
shows comes from a tested pure function here; the LLM only narrates and ranks on
top. This module has **no I/O and no model calls** — it's the ground truth the
co-pilot stands on, covered by tests/test_copilot.py.

The headline piece is the throughput flywheel (capability E): from completed jobs'
actual vs. planned squares, learn each crew's real production rate and only suggest
changing their configured capacity when the evidence is strong and stable. A single
fast or slow job must never move a crew's number — that threshold is tested.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Optional


# ── E. Throughput flywheel ───────────────────────────────────────────────────

# Evidence thresholds. A suggestion fires only when all three hold. Tuned so a
# handful of jobs or a noisy crew never moves capacity; tested at the boundaries.
MIN_SAMPLES = 6           # completed jobs with recorded actuals
MIN_DELTA_PCT = 8.0       # observed must differ from configured by at least this
MAX_CV = 0.25             # coefficient of variation ceiling (stability gate)


@dataclass
class ThroughputSample:
    """One completed appointment's observed production."""
    appointment_id: str
    actual_squares: float
    crew_days: float          # real elapsed crew-days (>= 0.5)


@dataclass
class ThroughputVerdict:
    crew_id: str
    crew_name: str
    configured_sqpd: float
    observed_sqpd: float
    sample_size: int
    delta_pct: float          # (observed - configured) / configured * 100
    cv: float                 # spread of the per-job rates
    stable: bool
    recommend: bool
    suggested_sqpd: Optional[float]
    rationale: str


def _per_job_rates(samples: list[ThroughputSample]) -> list[float]:
    return [s.actual_squares / s.crew_days for s in samples if s.crew_days > 0 and s.actual_squares > 0]


def analyze_crew_throughput(
    crew_id: str,
    crew_name: str,
    configured_sqpd: float,
    samples: list[ThroughputSample],
    *,
    min_samples: int = MIN_SAMPLES,
    min_delta_pct: float = MIN_DELTA_PCT,
    max_cv: float = MAX_CV,
) -> ThroughputVerdict:
    """Decide whether a crew's configured squares/day should change, given its
    completed-job actuals. Deterministic; the caller's LLM only rephrases the
    rationale, never the decision."""
    rates = _per_job_rates(samples)
    n = len(rates)

    if n == 0 or configured_sqpd <= 0:
        return ThroughputVerdict(crew_id, crew_name, round(configured_sqpd, 1), 0.0, n, 0.0, 0.0,
                                 False, False, None, "No completed jobs with recorded actuals yet.")

    mean = sum(rates) / n
    variance = sum((r - mean) ** 2 for r in rates) / n
    stdev = variance ** 0.5
    cv = stdev / mean if mean > 0 else 1.0
    delta_pct = (mean - configured_sqpd) / configured_sqpd * 100.0
    stable = cv <= max_cv
    enough = n >= min_samples
    meaningful = abs(delta_pct) >= min_delta_pct
    recommend = enough and meaningful and stable
    suggested = round(mean * 2) / 2 if recommend else None  # nearest half-square

    observed = round(mean, 1)
    if recommend:
        direction = "faster" if delta_pct > 0 else "slower"
        rationale = (f"{crew_name} has averaged {observed} sq/day across the last {n} completed jobs "
                     f"({abs(delta_pct):.0f}% {direction} than the configured {round(configured_sqpd, 1)}), "
                     f"and the rate is steady. Update capacity to {suggested} sq/day?")
    elif not enough:
        rationale = f"Watching {n}/{min_samples} completed jobs — not enough evidence to suggest a change yet."
    elif not meaningful:
        rationale = f"Observed {observed} sq/day is within {min_delta_pct:.0f}% of configured — no change needed."
    else:  # unstable
        rationale = (f"Observed {observed} sq/day but the per-job rate is too variable "
                     f"(±{cv * 100:.0f}%) to trust a capacity change yet.")

    return ThroughputVerdict(crew_id, crew_name, round(configured_sqpd, 1), observed, n,
                             round(delta_pct, 1), round(cv, 3), stable, recommend, suggested, rationale)


# ── A/D. Morning Brief assembly ──────────────────────────────────────────────

@dataclass
class BriefItem:
    kind: str                 # LOAD_OVER | LOAD_IDLE | GAP | RISK_WEATHER | RISK_SERIES | RISK_DEADLINE
    severity: int             # higher = more urgent; used only for ranking
    text: str
    refs: dict = field(default_factory=dict)     # ids the UI links to
    action: Optional[dict] = None                # a one-tap dry-run hint, or None


@dataclass
class BriefInputs:
    """Everything the brief summarizes — all already computed by tested code."""
    date: str
    overbooked: list[dict]    # [{crew_id, crew_name, date, utilization_pct}]
    idle: list[dict]          # [{crew_id, crew_name, date}]
    gaps: list[dict]          # [{job_id, appointment_id?, job_number, label, best?}]
    weather_risks: list[dict] # [{date, precip, count, resolvable}]
    series_risks: list[dict]  # [{appointment_id, job_number, text}]
    deadline_risks: list[dict]# [{job_id, job_number, text}]


def assemble_brief(inp: BriefInputs) -> dict:
    """Turn deterministic inputs into the three ranked lists (Load / Gaps / Risk).
    Pure — no prose generation here; narration is layered on separately and
    degrades to `templated_prose` below when the model is unavailable."""
    load: list[BriefItem] = []
    for o in sorted(inp.overbooked, key=lambda x: -x.get("utilization_pct", 0)):
        load.append(BriefItem("LOAD_OVER", 90, f"{o['crew_name']} is overbooked {o['utilization_pct']:.0f}% on {o['date'][5:]}.",
                              refs={"crew_id": o["crew_id"], "date": o["date"]}))
    for i in inp.idle:
        load.append(BriefItem("LOAD_IDLE", 40, f"{i['crew_name']} is idle {i['date'][5:]}.",
                              refs={"crew_id": i["crew_id"], "date": i["date"]}))

    gaps: list[BriefItem] = []
    for g in inp.gaps:
        best = g.get("best")
        txt = f"#{g['job_number']} {g['label']} is unplaced."
        if best:
            txt += f" Best fit: {best['crew_name']} {best['date'][5:]}."
        gaps.append(BriefItem("GAP", 60 if best else 50, txt,
                             refs={"job_id": g["job_id"], "appointment_id": g.get("appointment_id")},
                             action=best.get("action") if best else None))

    risk: list[BriefItem] = []
    for w in inp.weather_risks:
        risk.append(BriefItem("RISK_WEATHER", 85,
                             f"{w['count']} job{'s' if w['count'] != 1 else ''} on {w['date'][5:]}'s {w['precip']:.0f}% rain — {w['resolvable']} can move to a dry slot.",
                             refs={"date": w["date"]}, action={"type": "weather_reschedule", "date": w["date"]}))
    for s in inp.series_risks:
        risk.append(BriefItem("RISK_SERIES", 70, s["text"], refs={"appointment_id": s["appointment_id"]}))
    for d in inp.deadline_risks:
        risk.append(BriefItem("RISK_DEADLINE", 80, d["text"], refs={"job_id": d["job_id"]}))

    load.sort(key=lambda x: -x.severity)
    risk.sort(key=lambda x: -x.severity)

    def dump(items: list[BriefItem]) -> list[dict]:
        return [{"kind": it.kind, "severity": it.severity, "text": it.text, "refs": it.refs, "action": it.action} for it in items]

    return {"date": inp.date, "load": dump(load), "gaps": dump(gaps), "risk": dump(risk),
            "counts": {"load": len(load), "gaps": len(gaps), "risk": len(risk)}}


def parse_plan_json(raw: str) -> dict:
    """Safety-net layer 1 (tolerant parser) for the ⌘K command bar: strip code
    fences and extract the first balanced JSON object. Returns {} on anything
    malformed so the endpoint can reject it cleanly — a bad model response is
    discarded, never partially applied. Pure, so it's tested directly."""
    if not raw:
        return {}
    t = raw.strip()
    if t.startswith("```"):
        rest = t[3:]
        t = rest.split("```")[0] if "```" in rest else rest
        if t.lstrip().lower().startswith("json"):
            t = t.lstrip()[4:]
    depth, start = 0, None
    for i, ch in enumerate(t):
        if ch == "{":
            if start is None:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                try:
                    parsed = json.loads(t[start:i + 1])
                    return parsed if isinstance(parsed, dict) else {}
                except json.JSONDecodeError:
                    return {}
    return {}


def templated_prose(brief: dict) -> str:
    """Deterministic fallback narration (also the shape the LLM is asked to match).
    Guarantees the Brief reads as a paragraph even with no model configured."""
    parts = []
    over = [i for i in brief["load"] if i["kind"] == "LOAD_OVER"]
    idle = [i for i in brief["load"] if i["kind"] == "LOAD_IDLE"]
    if over:
        parts.append(f"{len(over)} crew-day{'s' if len(over) != 1 else ''} overbooked" + (f" (worst: {over[0]['text']})" if over else "") + ".")
    if idle:
        parts.append(f"{len(idle)} crew-day{'s' if len(idle) != 1 else ''} sitting idle.")
    if brief["gaps"]:
        parts.append(f"{len(brief['gaps'])} job{'s' if len(brief['gaps']) != 1 else ''} still need placing this week.")
    if brief["risk"]:
        parts.append(f"{len(brief['risk'])} risk{'s' if len(brief['risk']) != 1 else ''} to clear — {brief['risk'][0]['text']}")
    if not parts:
        return "Board's clean: no overbooked crews, no gaps, no risks flagged for this range."
    return " ".join(parts)
