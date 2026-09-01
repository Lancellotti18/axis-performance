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


# ── Partial outlines ─────────────────────────────────────────────────────────
#
# Not every roof gets fully outlined, and that is a legitimate way to work — a
# contractor may trace only the section being replaced. The system had no
# concept of it, so a partial trace either passed silently (reporting a part as
# though it were the whole roof) or hard-blocked with a message about double
# counting that had nothing to do with the real cause.
#
# These signals do not prove a trace is partial. They say it looks that way, so
# the contractor can confirm or dismiss it — the person who traced the roof
# knows, and asking beats guessing.

def partial_outline_signals(aggregates: dict) -> list[str]:
    """Human-readable reasons this trace looks like part of a roof, not all of one."""
    eaves = _f(aggregates, "eaves_ft")
    rakes = _f(aggregates, "rakes_ft")
    ridges = _f(aggregates, "ridges_ft")
    hips = _f(aggregates, "hips_ft")
    area = _f(aggregates, "total_roof_sqft")
    perimeter = _f(aggregates, "perimeter_ft") or (eaves + rakes)

    out: list[str] = []

    # Ridge lines with no perimeter to belong to: the classic signature of
    # tracing the interior planes and stopping before the outer edge.
    if perimeter > 0 and (ridges + hips) > perimeter * (1.0 + _TOL):
        out.append(
            f"Ridge and hip ({ridges + hips:.0f} ft) run longer than the traced perimeter "
            f"({perimeter:.0f} ft) — the outer edge of the roof may not be traced yet."
        )

    # No eaves at all — every complete sloped roof has at least one.
    if eaves <= 0 and area > 0:
        out.append("No eaves are labelled, so the roof outline has not been closed.")

    # A closed shape of area A cannot have a perimeter much under 4·sqrt(A) —
    # that is the square, the most efficient case. Real roofs are far less
    # efficient, so materially under it means edges are missing rather than
    # that the building is unusually compact.
    if area > 0 and perimeter > 0:
        minimum_possible = 4.0 * (area ** 0.5)
        if perimeter < minimum_possible * 0.62:
            out.append(
                f"The traced perimeter ({perimeter:.0f} ft) is short for {area:.0f} sq ft of roof — "
                "some edges are probably not labelled."
            )
    return out


def validate_report_inputs(
    aggregates: dict,
    *,
    confirmed_penetration_count: int,
    partial: bool = False,
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
    if eaves <= 0 and partial:
        # A section of roof traced away from the building edge legitimately has
        # no eave. Say what is therefore missing rather than refusing.
        issues.append(ValidationIssue(
            "partial_no_eaves",
            "No eaves in the traced section, so drip edge, gutter and ice-and-water "
            "are not included in these quantities.",
            "warn",
        ))
    elif eaves <= 0:
        issues.append(ValidationIssue(
            "no_eaves",
            "Roof has no eaves — the outline is incomplete. Confirm the perimeter edges before generating.",
            "block",
        ))

    # 5. THE invariant (DEFECT-02/03): ridge + hip run along the top of the roof
    #    and cannot exceed the ground perimeter — UNLESS the contractor has said
    #    this is a partial measurement, where tracing the interior planes and
    #    stopping before the outer edge produces exactly this contradiction.
    #    Blocking someone for telling us the truth is the wrong response, so a
    #    declared partial drops to a warning the report then carries visibly.
    if partial and perimeter > 0 and (ridges + hips) > perimeter * (1.0 + _TOL):
        issues.append(ValidationIssue(
            "partial_outline_ridge",
            f"Ridge and hip ({ridges + hips:.0f} ft) exceed the traced perimeter "
            f"({perimeter:.0f} ft), as expected for a partial measurement. These totals "
            "cover only the traced section.",
            "warn",
        ))
    elif perimeter > 0 and (ridges + hips) > perimeter * (1.0 + _TOL):
        # The message used to assert double counting as THE cause. It is only
        # one of three, and on a real run that tripped this the dedup had
        # already removed every duplicate — the actual fault was 27 edges
        # labelled "ridge" on a 12-facet roof. Naming one cause sends the
        # contractor to fix the wrong thing, so state the contradiction and
        # list what actually produces it.
        issues.append(ValidationIssue(
            "ridge_exceeds_perimeter",
            f"Ridge+hip ({ridges + hips:.1f} ft) exceeds the roof perimeter "
            f"({perimeter:.1f} ft), which no roof can do. Usual causes, in order: "
            "edges mislabelled as ridge that are really rakes or valleys; a partial "
            "outline where interior lines were traced but the perimeter eaves were "
            "not; or a shared line counted from both facets. Check the ridge labels "
            "first, then that the outer edge of the roof is fully traced.",
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
