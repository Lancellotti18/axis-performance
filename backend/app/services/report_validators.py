"""Phase 0 / §4.4 + DEFECT-06: physical-plausibility validators that gate report
generation.

The rule from the build spec is absolute: a report must never be generated from
geometry that is physically impossible, and a zero must never be a *silent*
default. These validators run just before the PDF is built. Anything with
severity "block" aborts generation (the API returns 422 with the specific
failures); "warn" items are allowed through but surfaced so the number is never
presented as if it were reviewed when it wasn't.

Pure functions over the aggregates dict — no I/O, no models. Every check is a
statement about the geometry that must hold for any real roof.
"""
from __future__ import annotations

from dataclasses import dataclass

# Fractional slack for edge-length comparisons (measurement/rounding noise).
_TOL = 0.02


@dataclass(frozen=True)
class ValidationIssue:
    code: str
    message: str
    severity: str   # "block" | "warn"


def _f(aggregates: dict, key: str) -> float:
    try:
        return float(aggregates.get(key) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def validate_report_inputs(
    aggregates: dict,
    *,
    confirmed_penetration_count: int,
) -> list[ValidationIssue]:
    """Return all validation issues for a run's aggregates. Callers must abort
    generation if any issue has severity == 'block'."""
    issues: list[ValidationIssue] = []

    total_sqft = _f(aggregates, "total_roof_sqft")
    squares = _f(aggregates, "squares")
    eaves = _f(aggregates, "eaves_ft")
    rakes = _f(aggregates, "rakes_ft")
    ridges = _f(aggregates, "ridges_ft")
    hips = _f(aggregates, "hips_ft")
    valleys = _f(aggregates, "valleys_ft")
    perimeter = eaves + rakes

    # 1. There must be roof area.
    if total_sqft <= 0:
        issues.append(ValidationIssue(
            "empty_geometry",
            "Roof has no computed area. Add and confirm facets, then recompute before generating a report.",
            "block",
        ))
        # Everything below assumes area exists; stop here to avoid noise.
        return issues

    # 2. Squares must be consistent with area (1 square = 100 sf). A mismatch means
    #    two code paths computed the same quantity differently — forbidden.
    if squares > 0 and abs(squares * 100.0 - total_sqft) / total_sqft > _TOL:
        issues.append(ValidationIssue(
            "squares_area_mismatch",
            f"Squares ({squares:.1f}) and roof area ({total_sqft:.0f} sf) disagree by more than 2%.",
            "block",
        ))

    # 3. No negative lengths — a sign error, never physical.
    for name, val in (("eaves", eaves), ("rakes", rakes), ("ridges", ridges),
                      ("hips", hips), ("valleys", valleys)):
        if val < 0:
            issues.append(ValidationIssue(
                "negative_length", f"{name} length is negative ({val:.1f} ft).", "block"))

    # 4. Every sloped roof has at least one eave. Zero eaves means the outline
    #    never closed — the report would understate drip edge, gutter, and ice&water.
    if eaves <= 0:
        issues.append(ValidationIssue(
            "no_eaves",
            "Roof has no eaves — the outline is incomplete. Confirm the perimeter edges before generating.",
            "block",
        ))

    # 5. THE invariant (DEFECT-02/03): ridge + hip run along the top of the roof and
    #    can never exceed the ground perimeter. If they do, shared edges were double
    #    counted. This is a hard runtime guard behind the dedup fix.
    if perimeter > 0 and (ridges + hips) > perimeter * (1.0 + _TOL):
        issues.append(ValidationIssue(
            "ridge_exceeds_perimeter",
            f"Ridge+hip ({ridges + hips:.1f} ft) exceeds the roof perimeter "
            f"({perimeter:.1f} ft) — shared edges were double counted. Re-confirm edge labels.",
            "block",
        ))

    # 6. Pitch must be known — every downstream slope/material number depends on it.
    if not (aggregates.get("predominant_pitch") or "").strip():
        issues.append(ValidationIssue(
            "missing_pitch",
            "Predominant pitch is not set. Confirm at least one facet's pitch before generating.",
            "block",
        ))

    # 7. DEFECT-06: penetrations must be an explicit decision, not a silent zero. If
    #    none were confirmed we allow the report but flag it, so "0 penetrations"
    #    never reads as reviewed fact.
    if confirmed_penetration_count <= 0:
        issues.append(ValidationIssue(
            "penetrations_unreviewed",
            "No penetrations were confirmed. Review vents, pipes, and chimneys — "
            "flashing quantities assume zero until you do.",
            "warn",
        ))

    return issues


def blocking(issues: list[ValidationIssue]) -> list[ValidationIssue]:
    return [i for i in issues if i.severity == "block"]
