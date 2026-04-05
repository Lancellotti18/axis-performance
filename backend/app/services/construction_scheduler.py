from __future__ import annotations
"""
construction_scheduler.py — AXIS PERFORMANCE Module 8
======================================================
Builds a construction schedule from quantities →
  • schedule.json     (full task list + dates + Blender frame data)
  • gantt_data.csv    (importable to Excel / Google Sheets)
  • timeline_summary.json (milestones, total duration, labor hours)

Also emits Blender object-visibility keyframe data for phased animation.

Runs outside Blender as a standard Python module.
"""

import csv
import json
import math
import os
from datetime import date, timedelta


# ── phase definitions ──────────────────────────────────────────────────────────

PHASES = [
    {
        "id":    "foundation",
        "label": "Site Prep & Foundation",
        "color": "#6B7280",
        "blender_objects": ["Floor_Main"],
        "crew_size": 4,
        "labor_hours_per_day": 8,
    },
    {
        "id":    "framing",
        "label": "Framing & Structure",
        "color": "#D97706",
        "blender_objects": [],          # populated from "Wall_*" objects at runtime
        "crew_size": 6,
        "labor_hours_per_day": 8,
    },
    {
        "id":    "roofing",
        "label": "Roofing",
        "color": "#DC2626",
        "blender_objects": [],          # "Roof_*" objects
        "crew_size": 4,
        "labor_hours_per_day": 8,
    },
    {
        "id":    "siding",
        "label": "Exterior Siding & Wrap",
        "color": "#92400E",
        "blender_objects": [],          # same "Wall_*" objects — material change event
        "crew_size": 3,
        "labor_hours_per_day": 8,
    },
    {
        "id":    "openings",
        "label": "Windows & Doors",
        "color": "#2563EB",
        "blender_objects": [],          # "Window_*" + "Door_*" objects
        "crew_size": 2,
        "labor_hours_per_day": 8,
    },
    {
        "id":    "insulation",
        "label": "Insulation & Subfloor",
        "color": "#7C3AED",
        "blender_objects": [],
        "crew_size": 3,
        "labor_hours_per_day": 8,
    },
    {
        "id":    "interior",
        "label": "Interior Finishes",
        "color": "#059669",
        "blender_objects": ["Floor_Main"],
        "crew_size": 4,
        "labor_hours_per_day": 8,
    },
]


def _round_half(val: float, min_val: float = 1.0) -> float:
    """Round to nearest 0.5, minimum min_val."""
    return max(min_val, round(val * 2) / 2)


def calculate_durations(quantities: dict) -> dict:
    """Return raw (unrounded) duration in days per phase."""
    q_roof = quantities["roofing"]
    q_wall = quantities["walls"]
    q_strc = quantities["structure"]
    q_flr  = quantities["floors"]
    q_fnd  = quantities["foundation"]
    q_opn  = quantities["openings"]

    WEATHER_PHASES = {"foundation", "framing", "roofing", "siding"}
    WEATHER_BUFFER = 1.15

    raw = {
        "foundation":  max(3.0, min(15.0, q_fnd["concrete_cubic_yards"] * 0.5)),
        "framing":     q_strc["studs_count"] / 150.0,
        "roofing":     q_roof["shingle_squares"] / 12.0,
        "siding":      q_wall["siding_sqft"] / 500.0,
        "openings":    (q_opn["window_count"] + q_opn["door_count"]) * 0.5,
        "insulation":  q_flr["floor_area_sqft"] / 800.0,
        "interior":    q_flr["floor_area_sqft"] / 300.0,
    }

    durations = {}
    for phase_id, days in raw.items():
        if phase_id in WEATHER_PHASES:
            days = days * WEATHER_BUFFER
        durations[phase_id] = _round_half(days)

    return durations


def build_schedule(
    quantities: dict,
    scene_data:  dict | None = None,
    start_date:  str | None  = None,
) -> dict:
    """
    Build full schedule dict.
    start_date: ISO-format string (YYYY-MM-DD). Defaults to today.
    """
    start = date.fromisoformat(start_date) if start_date else date.today()
    durations = calculate_durations(quantities)

    # Skip weekends: advance date by the given number of working days
    def add_work_days(d: date, n: float) -> date:
        days_added = 0
        total = math.ceil(n)
        while days_added < total:
            d += timedelta(days=1)
            if d.weekday() < 5:  # Mon–Fri
                days_added += 1
        return d

    # ── build ordered phase list ───────────────────────────────────────────────
    tasks       = []
    cursor      = start
    total_labor = 0.0
    blender_fps = 30
    blender_frames_per_day = 3  # 1 construction day = 3 Blender frames
    blender_frame_cursor = 1

    for phase in PHASES:
        pid      = phase["id"]
        dur_days = durations.get(pid, 1.0)
        end_date = add_work_days(cursor, dur_days)

        crew_size   = phase["crew_size"]
        hours_pd    = phase["labor_hours_per_day"]
        labor_hours = round(dur_days * crew_size * hours_pd, 1)
        total_labor += labor_hours

        start_frame = blender_frame_cursor
        end_frame   = blender_frame_cursor + int(dur_days * blender_frames_per_day)

        task = {
            "phase_id":       pid,
            "label":          phase["label"],
            "color":          phase["color"],
            "start_date":     cursor.isoformat(),
            "end_date":       end_date.isoformat(),
            "duration_days":  dur_days,
            "crew_size":      crew_size,
            "labor_hours":    labor_hours,
            "blender": {
                "start_frame": start_frame,
                "end_frame":   end_frame,
                "objects":     phase["blender_objects"],
            },
        }
        tasks.append(task)

        # Dependency chain: each phase starts after previous ends
        cursor = end_date + timedelta(days=1)
        # Ensure cursor is a weekday
        while cursor.weekday() >= 5:
            cursor += timedelta(days=1)

        blender_frame_cursor = end_frame + 1

    total_calendar_days = (cursor - start).days
    total_working_days  = sum(t["duration_days"] for t in tasks)

    # ── milestones ────────────────────────────────────────────────────────────
    milestones = [
        {"label": "Foundation Complete",    "date": tasks[0]["end_date"]},
        {"label": "Structure Topped Out",   "date": tasks[1]["end_date"]},
        {"label": "Roofing Complete",       "date": tasks[2]["end_date"]},
        {"label": "Dried In / Weathertight","date": tasks[4]["end_date"]},
        {"label": "Substantial Completion", "date": tasks[-1]["end_date"]},
    ]

    # ── cumulative cost by day (S-curve data) ─────────────────────────────────
    # Placeholder: distribute each phase's cost linearly
    s_curve = []
    for t in tasks:
        s_curve.append({
            "date":  t["start_date"],
            "phase": t["label"],
        })

    # ── Blender animation keyframe map ────────────────────────────────────────
    # Objects to show/hide per phase (consumer adds actual object lists)
    blender_animation = {
        t["phase_id"]: {
            "start_frame": t["blender"]["start_frame"],
            "end_frame":   t["blender"]["end_frame"],
            "objects":     t["blender"]["objects"],
        }
        for t in tasks
    }

    schedule = {
        "project_start":         start.isoformat(),
        "project_end":           tasks[-1]["end_date"],
        "total_calendar_days":   total_calendar_days,
        "total_working_days":    round(total_working_days, 1),
        "total_labor_hours":     round(total_labor, 1),
        "tasks":                 tasks,
        "milestones":            milestones,
        "blender_animation":     blender_animation,
        "blender_total_frames":  blender_frame_cursor,
    }

    return schedule


def _write_gantt_csv(schedule: dict, path: str) -> None:
    """Write Gantt-ready CSV importable to Excel / Google Sheets."""
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Phase", "Start Date", "End Date", "Duration (Days)",
                    "Crew Size", "Labor Hours", "Color"])
        for t in schedule["tasks"]:
            w.writerow([
                t["label"],
                t["start_date"],
                t["end_date"],
                t["duration_days"],
                t["crew_size"],
                t["labor_hours"],
                t["color"],
            ])


def run_scheduler(
    quantities:  dict,
    output_dir:  str,
    scene_data:  dict | None = None,
    start_date:  str | None  = None,
) -> dict:
    """Build schedule and save all outputs."""
    schedule = build_schedule(quantities, scene_data=scene_data, start_date=start_date)

    data_dir = os.path.join(output_dir, "data")
    os.makedirs(data_dir, exist_ok=True)

    # schedule.json
    sched_path = os.path.join(data_dir, "schedule.json")
    with open(sched_path, "w") as f:
        json.dump(schedule, f, indent=2)

    # gantt_data.csv
    csv_path = os.path.join(data_dir, "gantt_data.csv")
    _write_gantt_csv(schedule, csv_path)

    # timeline_summary.json
    summary = {
        "project_start":       schedule["project_start"],
        "project_end":         schedule["project_end"],
        "total_calendar_days": schedule["total_calendar_days"],
        "total_working_days":  schedule["total_working_days"],
        "total_labor_hours":   schedule["total_labor_hours"],
        "milestones":          schedule["milestones"],
    }
    summ_path = os.path.join(data_dir, "timeline_summary.json")
    with open(summ_path, "w") as f:
        json.dump(summary, f, indent=2)

    print(f"[AXIS 5D] Schedule saved → {sched_path}")
    print(f"[AXIS 5D] Gantt CSV   → {csv_path}")
    print(f"[AXIS 5D] Duration: {schedule['total_calendar_days']} calendar days "
          f"({schedule['total_working_days']} working) | "
          f"{schedule['total_labor_hours']} labor hrs")

    return schedule


if __name__ == "__main__":
    import sys
    qty_json = sys.argv[1] if len(sys.argv) > 1 else "output/data/quantities.json"
    out_dir  = sys.argv[2] if len(sys.argv) > 2 else "output"
    start    = sys.argv[3] if len(sys.argv) > 3 else None
    with open(qty_json) as f:
        qty = json.load(f)
    sched = run_scheduler(qty, out_dir, start_date=start)
    print(f"Project: {sched['project_start']} → {sched['project_end']}")
