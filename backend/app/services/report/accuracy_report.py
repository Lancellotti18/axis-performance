"""
APIR Phase 6 — accuracy diagnostic.

Computes a per-category confidence breakdown for a PropertyMeasurements
and flags specific items the contractor should verify on-site. Returned
by GET /api/v1/apir/accuracy/{report_id} and shown in the AccuracyPanel UI.

Logic is read-only — never modifies measurements, never makes AI calls.
Just inspects the confidence flags already captured during extraction.

Accuracy targets from APIR Part 8 (and our session's exact percentages):
  - Roof total area:       ±3-5%  (target 3%)
  - Individual facet area: ±4-6%  (target 5%)
  - Linear edges:          ±0.5-1% (target 6"/100ft)
  - Pitch:                 ±1/12 step on clean photos
  - Wall height:           ±5-10% (biggest single error source)
  - Soffit depth:          ±2"
  - Window/door:           ±0" after standard-snap

Overall grade (A=95-100, B=85-94, C=70-84, D=<70) is derived from a
weighted score over per-category confidences.
"""
from __future__ import annotations

import statistics
from typing import Optional

from app.schemas.apir import (
    AccuracyCategoryStat, AccuracyGrade, AccuracyItem, AccuracyReport,
    PropertyMeasurements, ScaleConfidence,
)


# ─────────────────────────────────────────────────────────────────────────
# Per-category weights → overall score
# ─────────────────────────────────────────────────────────────────────────

CATEGORY_WEIGHTS: dict[str, float] = {
    "scale":       0.30,  # touches every measurement; most critical
    "pitch":       0.15,  # affects roof area, slope-adjusted edge lengths
    "facet_area":  0.20,  # the main number a contractor cares about
    "wall_height": 0.15,  # biggest single error source on siding
    "soffit":      0.05,  # minor area contribution
    "materials":   0.05,  # categorical, doesn't shift numbers
    "window_door": 0.10,  # snapped-to-standard knocks down raw AI noise
}

CONFIDENCE_SCORES: dict[str, float] = {
    "high": 1.0,
    "medium": 0.7,
    "estimated": 0.4,
}

# APIR's stated target accuracies per category (used for display, not scoring)
TARGET_PCT_ERROR: dict[str, float] = {
    "scale":       0.5,   # ±0.5% from Web Mercator math
    "pitch":       2.0,   # ±1/12 step ≈ ±2% area swing
    "facet_area":  5.0,
    "wall_height": 7.0,
    "soffit":      30.0,  # ±2" on 6-12" → ±20-30%
    "materials":   10.0,  # classification accuracy
    "window_door": 2.0,   # ±0 after snap, ±10% if no snap
}


# ─────────────────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────────────────

def compute_accuracy_report(
    measurements: PropertyMeasurements,
    *,
    report_id: str,
) -> AccuracyReport:
    """
    Inspect every confidence flag captured during extraction and emit a
    full diagnostic. Pure function — no I/O, no AI calls.
    """
    flagged: list[AccuracyItem] = []
    categories: list[AccuracyCategoryStat] = []

    # 1. SCALE -------------------------------------------------------------
    scale_stat, scale_flags = _check_scale(measurements)
    categories.append(scale_stat)
    flagged.extend(scale_flags)

    # 2. PITCH (each per-elevation reading) -------------------------------
    pitch_stat, pitch_flags = _check_pitch(measurements)
    categories.append(pitch_stat)
    flagged.extend(pitch_flags)

    # 3. FACET AREA — relies on scale + pitch correction ------------------
    facet_stat, facet_flags = _check_facet_areas(measurements)
    categories.append(facet_stat)
    flagged.extend(facet_flags)

    # 4. WALL HEIGHT (per siding elevation) -------------------------------
    wall_stat, wall_flags = _check_wall_heights(measurements)
    categories.append(wall_stat)
    flagged.extend(wall_flags)

    # 5. SOFFIT -----------------------------------------------------------
    soffit_stat, soffit_flags = _check_soffit(measurements)
    categories.append(soffit_stat)
    flagged.extend(soffit_flags)

    # 6. MATERIALS --------------------------------------------------------
    mat_stat, mat_flags = _check_materials(measurements)
    categories.append(mat_stat)
    flagged.extend(mat_flags)

    # 7. WINDOWS + DOORS --------------------------------------------------
    wd_stat, wd_flags = _check_openings(measurements)
    categories.append(wd_stat)
    flagged.extend(wd_flags)

    # ── Overall grade ────────────────────────────────────────────────────
    overall_score = _weighted_overall_score(categories)
    overall_grade = _score_to_grade(overall_score)
    overall_conf = _score_to_confidence(overall_score)

    summary = _build_summary(overall_grade, len(flagged), measurements)
    on_site_checks = _build_on_site_checks(flagged, measurements)

    return AccuracyReport(
        report_id=report_id,
        version=measurements.job.report_version,
        overall_grade=overall_grade,
        overall_confidence=overall_conf,
        overall_score=round(overall_score, 3),
        categories=categories,
        flagged_items=flagged,
        summary=summary,
        on_site_checks=on_site_checks,
    )


# ─────────────────────────────────────────────────────────────────────────
# Per-category checkers
# ─────────────────────────────────────────────────────────────────────────

def _check_scale(m: PropertyMeasurements):
    conf = m.job.scale_confidence
    item_flags: list[AccuracyItem] = []
    if conf == "estimated":
        item_flags.append(AccuracyItem(
            category="scale",
            label="Pixels-per-foot scale is estimated",
            confidence=conf,
            value=f"{m.job.pixels_per_foot:.2f} px/ft",
            recommendation=(
                "Re-fetch satellite imagery with known tile zoom/lat (web_mercator) "
                "or upload a drone photo with GSD metadata to lock the scale."
            ),
            estimated_error_pct=10.0,
        ))
    elif conf == "medium":
        item_flags.append(AccuracyItem(
            category="scale",
            label="Scale derived from AI-detected reference object",
            confidence=conf,
            value=m.job.scale_reference_description,
            recommendation=(
                "Measure one wall on-site; if it disagrees with the report by "
                "more than 2%, regenerate after correcting the scale."
            ),
            estimated_error_pct=3.0,
        ))
    stat = AccuracyCategoryStat(
        category="scale",
        confidence=conf,
        sample_count=1,
        high_count=1 if conf == "high" else 0,
        medium_count=1 if conf == "medium" else 0,
        estimated_count=1 if conf == "estimated" else 0,
        target_pct_error=TARGET_PCT_ERROR["scale"],
        note=f"method: {m.job.scale_method}",
    )
    return stat, item_flags


def _check_pitch(m: PropertyMeasurements):
    readings = m.extraction_metadata.pitch_readings
    flags: list[AccuracyItem] = []
    counts = {"high": 0, "medium": 0, "estimated": 0}
    for r in readings:
        counts[r.confidence] = counts.get(r.confidence, 0) + 1
        if r.confidence == "estimated":
            flags.append(AccuracyItem(
                category="pitch",
                target_id=r.elevation,
                label=f"Pitch from {r.elevation} elevation is estimated",
                confidence=r.confidence,
                value=r.pitch,
                recommendation=(
                    f"Measure pitch on-site from the {r.elevation} gable end. "
                    "Each 1/12 step changes roof area by ~0.4%."
                ),
                estimated_error_pct=4.0,
            ))
    if not readings:
        flags.append(AccuracyItem(
            category="pitch",
            label="No pitch readings captured (no elevation photos)",
            confidence="estimated",
            value=m.roof.predominant_pitch,
            recommendation=(
                "Upload at least one ground photo showing a gable end so the "
                "AI can estimate pitch directly instead of defaulting to 4/12."
            ),
            estimated_error_pct=10.0,
        ))
        # Default pitch_confidence comes from extraction; surface it anyway.
        conf: ScaleConfidence = m.roof.pitch_confidence
        return (
            AccuracyCategoryStat(
                category="pitch",
                confidence=conf,
                sample_count=0,
                target_pct_error=TARGET_PCT_ERROR["pitch"],
                note="no per-elevation readings",
            ),
            flags,
        )
    # Lowest confidence across readings = aggregate confidence
    order = {"high": 2, "medium": 1, "estimated": 0}
    agg = min((r.confidence for r in readings), key=lambda v: order.get(v, 0))
    stat = AccuracyCategoryStat(
        category="pitch",
        confidence=agg,
        sample_count=len(readings),
        high_count=counts["high"],
        medium_count=counts["medium"],
        estimated_count=counts["estimated"],
        target_pct_error=TARGET_PCT_ERROR["pitch"],
        note=f"{counts['high']}H / {counts['medium']}M / {counts['estimated']}E",
    )
    return stat, flags


def _check_facet_areas(m: PropertyMeasurements):
    """
    Facet areas inherit scale + pitch confidence. The actionable signal
    is small facets — they amplify per-pixel tracing error.
    """
    flags: list[AccuracyItem] = []
    SMALL_FACET_THRESHOLD_SQFT = 80.0
    for f in m.roof.facets:
        if f.actual_area_sqft < SMALL_FACET_THRESHOLD_SQFT:
            flags.append(AccuracyItem(
                category="facet_area",
                target_id=f.id,
                label=f"{f.id} is small ({int(f.actual_area_sqft)} ft²) — vertex precision matters",
                confidence="medium",
                value=f"{int(f.actual_area_sqft)} ft²",
                recommendation=(
                    "Zoom in on the satellite imagery and verify the polygon "
                    "tracing — small facets are 2× more sensitive to per-pixel error."
                ),
                estimated_error_pct=6.0,
            ))
    # Inherited confidence: take the LOWER of scale and pitch
    order = {"high": 2, "medium": 1, "estimated": 0}
    inherited = min(
        m.job.scale_confidence,
        m.roof.pitch_confidence,
        key=lambda v: order.get(v, 0),
    )
    stat = AccuracyCategoryStat(
        category="facet_area",
        confidence=inherited,
        sample_count=len(m.roof.facets),
        target_pct_error=TARGET_PCT_ERROR["facet_area"],
        note=f"inherits scale+pitch confidence; {len(flags)} small facet(s) flagged",
    )
    return stat, flags


def _check_wall_heights(m: PropertyMeasurements):
    flags: list[AccuracyItem] = []
    counts = {"high": 0, "medium": 0, "estimated": 0}
    for elev in m.siding.elevations:
        counts[elev.wall_height_confidence] = (
            counts.get(elev.wall_height_confidence, 0) + 1
        )
        if elev.wall_height_confidence == "estimated":
            flags.append(AccuracyItem(
                category="wall_height",
                target_id=elev.id,
                label=f"{elev.elevation} wall height is estimated",
                confidence="estimated",
                value=f"{elev.wall_height_ft} ft",
                recommendation=(
                    f"Tape-measure the {elev.elevation} wall on-site — height is "
                    "the single largest error source for siding sqft."
                ),
                estimated_error_pct=10.0,
            ))
    if not m.siding.elevations:
        return (
            AccuracyCategoryStat(
                category="wall_height",
                confidence="estimated",
                sample_count=0,
                target_pct_error=TARGET_PCT_ERROR["wall_height"],
                note="no siding elevations detected",
            ),
            flags,
        )
    order = {"high": 2, "medium": 1, "estimated": 0}
    agg = min(
        (e.wall_height_confidence for e in m.siding.elevations),
        key=lambda v: order.get(v, 0),
    )
    stat = AccuracyCategoryStat(
        category="wall_height",
        confidence=agg,
        sample_count=len(m.siding.elevations),
        high_count=counts["high"],
        medium_count=counts["medium"],
        estimated_count=counts["estimated"],
        target_pct_error=TARGET_PCT_ERROR["wall_height"],
        note=f"{counts['high']}H / {counts['medium']}M / {counts['estimated']}E",
    )
    return stat, flags


def _check_soffit(m: PropertyMeasurements):
    flags: list[AccuracyItem] = []
    counts = {"high": 0, "medium": 0, "estimated": 0}
    for s in m.soffit.breakdown:
        counts[s.depth_confidence] = counts.get(s.depth_confidence, 0) + 1
    if not m.soffit.breakdown:
        return (
            AccuracyCategoryStat(
                category="soffit",
                confidence="estimated",
                sample_count=0,
                target_pct_error=TARGET_PCT_ERROR["soffit"],
                note="no soffit segments",
            ),
            flags,
        )
    order = {"high": 2, "medium": 1, "estimated": 0}
    agg = min(
        (s.depth_confidence for s in m.soffit.breakdown),
        key=lambda v: order.get(v, 0),
    )
    if agg == "estimated":
        # One umbrella flag — too noisy to flag every segment
        flags.append(AccuracyItem(
            category="soffit",
            label="All soffit depths are estimated (no eave photos analyzed)",
            confidence="estimated",
            value=f"median {statistics.median(s.depth_in for s in m.soffit.breakdown):.0f}\"",
            recommendation=(
                "Upload a single photo showing the eave from below or at an "
                "angle so the AI can measure overhang depth directly."
            ),
            estimated_error_pct=30.0,
        ))
    return (
        AccuracyCategoryStat(
            category="soffit",
            confidence=agg,
            sample_count=len(m.soffit.breakdown),
            high_count=counts["high"],
            medium_count=counts["medium"],
            estimated_count=counts["estimated"],
            target_pct_error=TARGET_PCT_ERROR["soffit"],
            note=f"{counts['high']}H / {counts['medium']}M / {counts['estimated']}E",
        ),
        flags,
    )


def _check_materials(m: PropertyMeasurements):
    flags: list[AccuracyItem] = []
    unknown_count = 0
    if m.roof.material == "unknown":
        unknown_count += 1
        flags.append(AccuracyItem(
            category="materials",
            label="Roof material not identified",
            confidence="estimated",
            value="unknown",
            recommendation="Upload a closer roof photo for accurate material classification.",
            estimated_error_pct=100.0,
        ))
    if m.siding.material == "unknown":
        unknown_count += 1
        flags.append(AccuracyItem(
            category="materials",
            label="Siding material not identified",
            confidence="estimated",
            value="unknown",
            recommendation="Upload a closer wall photo for accurate material classification.",
            estimated_error_pct=100.0,
        ))
    conf: ScaleConfidence = "high" if unknown_count == 0 else "estimated"
    return (
        AccuracyCategoryStat(
            category="materials",
            confidence=conf,
            sample_count=2,
            high_count=2 - unknown_count,
            estimated_count=unknown_count,
            target_pct_error=TARGET_PCT_ERROR["materials"],
            note=f"{2 - unknown_count}/2 identified",
        ),
        flags,
    )


def _check_openings(m: PropertyMeasurements):
    """
    Snap-to-standard windows/doors are accurate to within 0 inches.
    Unsnapped ones rely on raw AI estimation (±10%). The interesting
    signal is the snap rate — high snap rate = high confidence.
    """
    windows = m.siding.openings.windows
    doors = m.siding.openings.doors
    total = len(windows) + len(doors)
    if total == 0:
        return (
            AccuracyCategoryStat(
                category="window_door",
                confidence="estimated",
                sample_count=0,
                target_pct_error=TARGET_PCT_ERROR["window_door"],
                note="no openings detected",
            ),
            [],
        )
    snapped = sum(1 for w in windows if w.snapped_to_standard) + sum(
        1 for d in doors if d.snapped_to_standard
    )
    snap_rate = snapped / total
    flags: list[AccuracyItem] = []
    if snap_rate < 0.7:
        flags.append(AccuracyItem(
            category="window_door",
            label=f"Only {int(snap_rate * 100)}% of openings snapped to standard sizes",
            confidence="medium",
            value=f"{snapped}/{total} snapped",
            recommendation=(
                "Many openings have non-standard dimensions. Confirm on-site "
                "with a tape measure — raw AI estimates carry ±10% error."
            ),
            estimated_error_pct=10.0,
        ))
    conf: ScaleConfidence = (
        "high" if snap_rate >= 0.8
        else "medium" if snap_rate >= 0.5
        else "estimated"
    )
    return (
        AccuracyCategoryStat(
            category="window_door",
            confidence=conf,
            sample_count=total,
            high_count=snapped,
            medium_count=total - snapped,
            target_pct_error=TARGET_PCT_ERROR["window_door"],
            note=f"{snapped}/{total} snapped to standard",
        ),
        flags,
    )


# ─────────────────────────────────────────────────────────────────────────
# Scoring helpers
# ─────────────────────────────────────────────────────────────────────────

def _weighted_overall_score(categories: list[AccuracyCategoryStat]) -> float:
    total_weight = 0.0
    total_score = 0.0
    for cat in categories:
        w = CATEGORY_WEIGHTS.get(cat.category, 0.0)
        s = CONFIDENCE_SCORES.get(cat.confidence, 0.0)
        total_weight += w
        total_score += w * s
    return total_score / total_weight if total_weight > 0 else 0.0


def _score_to_grade(score: float) -> AccuracyGrade:
    if score >= 0.95:
        return "A"
    if score >= 0.85:
        return "B"
    if score >= 0.70:
        return "C"
    return "D"


def _score_to_confidence(score: float) -> ScaleConfidence:
    if score >= 0.85:
        return "high"
    if score >= 0.65:
        return "medium"
    return "estimated"


def _build_summary(
    grade: AccuracyGrade, flag_count: int, m: PropertyMeasurements,
) -> str:
    grade_phrase = {
        "A": "Report quality is excellent",
        "B": "Report quality is good",
        "C": "Report quality is fair — verify key measurements on-site",
        "D": "Report quality is low — do not bid without on-site verification",
    }[grade]
    flag_phrase = (
        f"{flag_count} item{'s' if flag_count != 1 else ''} flagged for review"
        if flag_count else "no items flagged for review"
    )
    return (
        f"{grade_phrase}. Scale calibrated via {m.job.scale_method} "
        f"({m.job.scale_confidence}); {flag_phrase}."
    )


def _build_on_site_checks(
    flags: list[AccuracyItem], m: PropertyMeasurements,
) -> list[str]:
    """Distill flags into a contractor-friendly checklist."""
    checks: list[str] = []
    # Always include scale verification on anything below high confidence
    if m.job.scale_confidence != "high":
        checks.append("Measure one known wall length on-site to confirm scale")
    # Per-category bullet (one line per category that has flags)
    cats_with_flags: set[str] = {f.category for f in flags}
    if "pitch" in cats_with_flags:
        checks.append("Check roof pitch from a clear gable end view")
    if "wall_height" in cats_with_flags:
        checks.append("Tape-measure wall heights on any elevation flagged ESTIMATED")
    if "soffit" in cats_with_flags:
        checks.append("Photograph the eave from below to fix soffit depth")
    if "materials" in cats_with_flags:
        checks.append("Confirm roof/siding materials with close-up photos")
    if "window_door" in cats_with_flags:
        checks.append("Re-measure non-standard windows/doors with a tape")
    if "facet_area" in cats_with_flags:
        checks.append("Re-trace small facets in the editor at higher zoom")
    if not checks:
        checks.append("No verification needed — measurements are high-confidence")
    return checks
