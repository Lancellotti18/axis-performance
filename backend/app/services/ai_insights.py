from __future__ import annotations
"""
ai_insights.py — AXIS PERFORMANCE Module 9
===========================================
Generates 5 AI-powered insights via Claude API.
Results are cached by content hash to avoid redundant API calls.

Runs outside Blender as a standard Python module.

Inputs:  quantities dict, cost_report dict, schedule dict
Outputs: insights dict + /output/data/insights.json
"""

import hashlib
import json
import os


def _cache_key(data: dict) -> str:
    raw = json.dumps(data, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _load_cache(cache_file: str) -> dict:
    if os.path.exists(cache_file):
        try:
            with open(cache_file) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_cache(cache: dict, cache_file: str) -> None:
    with open(cache_file, "w") as f:
        json.dump(cache, f, indent=2)


def _call_claude(prompt: str) -> str:
    from app.services.llm import llm_text_sync
    return llm_text_sync(prompt, max_tokens=600)


def _generate(
    prompt: str,
    cache_key: str,
    cache: dict,
    fallback: str,
) -> str:
    if cache_key in cache:
        return cache[cache_key]
    try:
        result = _call_claude(prompt)
    except Exception as e:
        print(f"[AXIS AI] Claude API error: {e} — using fallback text")
        result = fallback
    cache[cache_key] = result
    return result


def generate_insights(
    quantities: dict,
    cost_report: dict,
    schedule: dict,
    project_name: str = "Project",
    output_dir: str = "output",
) -> dict:
    """Generate all 5 AI insights. Returns insights dict."""

    cache_file = os.path.join(output_dir, "data", "insights_cache.json")
    os.makedirs(os.path.dirname(cache_file), exist_ok=True)
    cache = _load_cache(cache_file)

    meta      = quantities.get("meta", {})
    q_roof    = quantities["roofing"]
    q_wall    = quantities["walls"]
    cost_sum  = cost_report.get("summary", {})
    sched_sum = {
        "calendar_days": schedule.get("total_calendar_days", 0),
        "working_days":  schedule.get("total_working_days", 0),
        "labor_hours":   schedule.get("total_labor_hours", 0),
        "milestones":    schedule.get("milestones", []),
    }

    area      = meta.get("area_sqft", 0)
    perim     = meta.get("perimeter_lf", 0)
    rooms     = meta.get("room_count", 0)
    walls     = meta.get("wall_count", 0)
    pitch     = meta.get("pitch_angle_deg", 35)
    std_total = cost_sum.get("standard_total", 0)
    std_psf   = cost_sum.get("standard_per_sqft", 0)
    eco_total = cost_sum.get("economy_total", 0)
    prm_total = cost_sum.get("premium_total", 0)

    data_fingerprint = {
        "area": round(area, 0),
        "std_total": round(std_total, -2),
        "cal_days": sched_sum["calendar_days"],
    }

    # ── 1. Project Summary ────────────────────────────────────────────────────
    key1 = "summary_" + _cache_key(data_fingerprint)
    prompt1 = f"""You are writing a client-facing project overview for a construction contractor.

Project: {project_name}
Floor area: {area:,.0f} sqft | Perimeter: {perim:,.0f} lf | Rooms: {rooms} | Walls: {walls}
Roof pitch: {pitch}° | Roofing area: {q_roof['roof_area_sqft']:,.0f} sqft
Cost range: ${eco_total:,.0f} (economy) – ${prm_total:,.0f} (premium)
Standard estimate: ${std_total:,.0f} (${std_psf:.0f}/sqft)
Timeline: {sched_sum['calendar_days']} calendar days ({sched_sum['working_days']} working days)

Write exactly 3 short paragraphs (3–5 sentences each):
1. What this project is and its key characteristics
2. Cost summary and what drives value at each tier
3. Timeline overview and what to expect at key milestones
Use clear, professional language suitable for a homeowner or property developer."""

    fallback1 = (
        f"This {area:,.0f} sqft project features {rooms} rooms and {walls} walls "
        f"with a {pitch}° roof pitch.\n\n"
        f"Cost estimates range from ${eco_total:,.0f} (economy) to ${prm_total:,.0f} (premium), "
        f"with a standard build at ${std_total:,.0f} (${std_psf:.0f}/sqft).\n\n"
        f"The project is scheduled for {sched_sum['calendar_days']} calendar days "
        f"with substantial completion at the {sched_sum['milestones'][-1]['date'] if sched_sum['milestones'] else 'project end'}."
    )

    # ── 2. Cost Analysis ──────────────────────────────────────────────────────
    cr_std = cost_report.get("standard", {})
    phases = cr_std.get("phases", {})
    top_phases = sorted(
        [(k, v.get("total", 0)) for k, v in phases.items() if k != "phase7_overhead"],
        key=lambda x: x[1], reverse=True
    )[:3]

    key2 = "cost_" + _cache_key(data_fingerprint)
    prompt2 = f"""You are a construction cost analyst writing a report section.

Project area: {area:,.0f} sqft
Standard total: ${std_total:,.0f} (${std_psf:.0f}/sqft)
Top 3 cost drivers: {', '.join(f'{p[0].replace("_", " ")}: ${p[1]:,.0f}' for p in top_phases)}
Economy vs Premium delta: ${prm_total - eco_total:,.0f}

Write a concise cost analysis (150–200 words) covering:
- The top 3 cost drivers and why they're significant
- 2 concrete opportunities to reduce cost without major quality loss
- 1 key financial risk to flag for the client
Use bullet points where appropriate. Be specific with numbers."""

    fallback2 = (
        f"Top cost drivers: {', '.join(p[0].replace('_', ' ') for p in top_phases)}.\n"
        f"• Consider economy-tier roofing to save ~${(std_total - eco_total) * 0.3:,.0f}\n"
        f"• Phased interior finishes can reduce upfront outlay\n"
        f"Risk: Material price escalation — lock in quotes within 30 days."
    )

    # ── 3. Material Recommendations ───────────────────────────────────────────
    shingle_sq = q_roof["shingle_squares"]
    key3 = "materials_" + _cache_key({"sq": round(shingle_sq, 0), "pitch": pitch})
    prompt3 = f"""You are a roofing specialist advising a construction contractor.

Roof: {q_roof['roof_area_sqft']:,.0f} sqft | {shingle_sq:.1f} squares | {pitch}° pitch | {q_roof['ridge_cap_lf']:.0f} lf ridge
Wall area: {q_wall['net_wall_sqft']:,.0f} sqft net exterior

Recommend the optimal roofing material for this roof profile (150–180 words):
- State your top recommendation with specific product type
- Explain why it suits this pitch and size
- Compare briefly to 2 alternatives
- Note any special installation considerations for this roof geometry
Be specific, technical, and contractor-grade in your language."""

    fallback3 = (
        f"For a {pitch}° pitch with {shingle_sq:.1f} squares, architectural asphalt shingles "
        f"offer the best value. Class 4 impact-resistant variants provide longevity at 3–4× "
        f"the cost of 3-tab. Metal standing seam is ideal if budget allows, especially for "
        f"long-term ROI on this roof size."
    )

    # ── 4. Schedule Risks ─────────────────────────────────────────────────────
    tasks_summary = [
        f"{t['label']}: {t['duration_days']} days"
        for t in schedule.get("tasks", [])
    ]
    key4 = "schedule_" + _cache_key({"days": sched_sum["calendar_days"], "labor": round(sched_sum["labor_hours"], -1)})
    prompt4 = f"""You are a construction project manager writing a risk assessment.

Schedule: {sched_sum['calendar_days']} calendar days, {sched_sum['labor_hours']:,.0f} labor hours
Phases: {' | '.join(tasks_summary)}

Write a schedule risk assessment (150–180 words) covering:
- Which phase is on the critical path and why
- The single highest-risk phase (weather, labor, materials) and mitigation
- One concrete opportunity to compress the schedule by 10–15%
Use contractor-level language. Be specific about which phases and why."""

    fallback4 = (
        f"Critical path: Foundation → Framing → Roofing. "
        f"Highest risk: Roofing ({schedule.get('tasks', [{}])[2].get('duration_days', '?')} days) — weather dependent. "
        f"Compression opportunity: overlap siding and window rough-in to save 3–5 days."
    )

    # ── 5. Quality Checklist ──────────────────────────────────────────────────
    key5 = "checklist_" + _cache_key({"area": round(area, -2), "rooms": rooms})
    prompt5 = f"""You are a building inspector writing a pre-construction quality checklist.

Project: {area:,.0f} sqft, {rooms} rooms, {walls} walls, {pitch}° roof pitch.

Generate exactly 10 checklist items for pre-construction quality assurance.
Format: numbered list, each item one clear sentence.
Cover: permits, engineering stamps, material approvals, site conditions, subcontractor qualifications, inspections schedule.
Be specific to the project scale and roof type."""

    fallback5 = "\n".join([
        "1. Obtain all required building permits before breaking ground.",
        "2. Verify engineer-stamped structural drawings are on site.",
        "3. Confirm material delivery schedule with suppliers.",
        "4. Inspect site drainage and grading before foundation pour.",
        "5. Verify subcontractor license and insurance certificates.",
        "6. Schedule foundation inspection before framing begins.",
        "7. Confirm roofing material specifications match approved plans.",
        "8. Schedule framing inspection before sheathing.",
        "9. Confirm window and door unit lead times.",
        "10. Schedule final inspection walkthrough 5 days before completion.",
    ])

    # ── run all prompts ───────────────────────────────────────────────────────
    print("[AXIS AI] Generating project summary...")
    ins_summary = _generate(prompt1, key1, cache, fallback1)
    print("[AXIS AI] Generating cost analysis...")
    ins_cost    = _generate(prompt2, key2, cache, fallback2)
    print("[AXIS AI] Generating material recommendations...")
    ins_mats    = _generate(prompt3, key3, cache, fallback3)
    print("[AXIS AI] Generating schedule risks...")
    ins_sched   = _generate(prompt4, key4, cache, fallback4)
    print("[AXIS AI] Generating quality checklist...")
    ins_check   = _generate(prompt5, key5, cache, fallback5)

    _save_cache(cache, cache_file)

    insights = {
        "project_summary":          ins_summary,
        "cost_analysis":            ins_cost,
        "material_recommendations": ins_mats,
        "schedule_risks":           ins_sched,
        "quality_checklist":        ins_check,
        "meta": {
            "project_name": project_name,
            "area_sqft":    round(area, 1),
            "cached_keys":  [key1, key2, key3, key4, key5],
        },
    }

    return insights


def run_ai_insights(
    quantities:   dict,
    cost_report:  dict,
    schedule:     dict,
    output_dir:   str,
    project_name: str = "Project",
) -> dict:
    """Generate insights and save to /output/data/insights.json."""
    insights = generate_insights(
        quantities, cost_report, schedule,
        project_name=project_name,
        output_dir=output_dir,
    )

    data_dir = os.path.join(output_dir, "data")
    os.makedirs(data_dir, exist_ok=True)
    out_path = os.path.join(data_dir, "insights.json")
    with open(out_path, "w") as f:
        json.dump(insights, f, indent=2)

    print(f"[AXIS AI] Insights saved → {out_path}")
    return insights


if __name__ == "__main__":
    import sys
    out_dir  = sys.argv[1] if len(sys.argv) > 1 else "output"
    proj     = sys.argv[2] if len(sys.argv) > 2 else "Project"

    def _load(name):
        with open(os.path.join(out_dir, "data", name)) as f:
            return json.load(f)

    ins = run_ai_insights(
        _load("quantities.json"),
        _load("cost_report.json"),
        _load("schedule.json"),
        out_dir,
        project_name=proj,
    )
    print("Summary preview:", ins["project_summary"][:200])
