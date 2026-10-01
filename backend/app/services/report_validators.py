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


# ── Coverage against an outside reference ────────────────────────────────────
#
# The signals above only catch a trace that contradicts ITSELF. The failure
# that actually shipped was a clean, self-consistent outline of 71% of a roof
# (339 Buch Ave, run e420330e): perimeter fine, ridges fine, every edge
# labelled — and 33% short, stamped High (97%). Nothing inside a trace can
# reveal that the other 29% exists. Only an outside view of the building can.
#
# Google Solar supplies one: its footprint area for the building. Traced plan
# area over that footprint is how much of the building was traced, with no
# pitch assumption in it at all.
#
# Solar is a reference, not ground truth — it can pick the wrong building,
# include a porch, or miss a low section. So it only CAPS confidence and says
# why; it never changes a measured number, never blocks a report, and is
# ignored entirely when it may be describing a different building.

# Solar's building centre must be this close to the house the contractor
# tapped, or the reference may be a neighbour's roof and is not used.
COVERAGE_TRUST_RADIUS_M = 30.0
# Below this, Solar has likely found a shed or a fragment, not the house.
COVERAGE_MIN_REFERENCE_SQFT = 300.0
# Ratio bands (traced / reference). Provisional until tuned on real runs.
COVERAGE_LOW = 0.80          # under: most likely a partial trace
COVERAGE_MODERATE = 0.92     # under: possibly a missed section
COVERAGE_OVER = 1.35         # over: traced beyond this building
# Caps sit inside the report's own bands: Low < 55%, Moderate 55-79%.
CAP_LOW = 0.45
CAP_MODERATE = 0.70


@dataclass(frozen=True)
class Coverage:
    ratio: float
    traced_sqft: float
    reference_sqft: float
    basis: str               # "footprint" | "roof area"
    cap: float | None        # None = no cap: the trace matches the building
    signal: str | None       # the sentence shown to the contractor


def trace_coverage(aggregates: dict, reference: dict | None, *,
                   partial: bool = False) -> Coverage | None:
    """How much of the building the trace covers, per Google Solar.

    `reference` is what was recorded when Solar was queried for this run:
    {"ground_sqft", "roof_sqft", "distance_m"}. Returns None — no opinion —
    whenever the comparison would not be fair: the contractor declared a
    partial trace on purpose, there is no reference, Solar's building is not
    the tapped house, or the reference is too small to be the whole house.
    """
    if partial or not reference:
        return None
    dist = reference.get("distance_m")
    if dist is None or float(dist) > COVERAGE_TRUST_RADIUS_M:
        return None

    ground = float(reference.get("ground_sqft") or 0.0)
    roof = float(reference.get("roof_sqft") or 0.0)
    if ground >= COVERAGE_MIN_REFERENCE_SQFT:
        # Footprint against footprint: no pitch in either number.
        basis, ref, traced = "footprint", ground, _f(aggregates, "total_plan_sqft")
    elif roof >= COVERAGE_MIN_REFERENCE_SQFT:
        basis, ref, traced = "roof area", roof, _f(aggregates, "total_roof_sqft")
    else:
        return None
    if traced <= 0:
        return None

    ratio = traced / ref
    cap: float | None = None
    signal: str | None = None
    if ratio < COVERAGE_LOW:
        cap = CAP_LOW
    elif ratio < COVERAGE_MODERATE:
        cap = CAP_MODERATE
    elif ratio > COVERAGE_OVER:
        cap = CAP_MODERATE
        signal = (
            f"The trace ({traced:,.0f} sq ft) is {ratio:.0%} of the {ref:,.0f} sq ft "
            f"{basis} Google measures for this building — it may include a "
            "neighbouring structure or run outside the roof edge.")
    if cap is not None and signal is None:
        signal = (
            f"Google measures about {ref:,.0f} sq ft of {basis} for this building; "
            f"the trace covers {traced:,.0f} sq ft ({ratio:.0%}). Part of the roof may "
            "not be traced yet — check the outline before ordering, or mark the "
            "measurement as partial if that is intended.")
    return Coverage(round(ratio, 3), round(traced, 1), round(ref, 1), basis, cap, signal)


# ── Imagery resolution ───────────────────────────────────────────────────────
#
# The tile's health score asks whether the picture is usable (not blank, not
# cloud). It never asked how FINE the picture is. The Buch Ave tile came back at
# zoom 19 — about 0.75 ft per pixel, twice as coarse as zoom 20 — and the
# contractor could not see the facets, yet the report said imagery health
# 100/100. Resolution is a separate question and is answered separately here,
# so provider selection (which runs off the health score) is untouched.

# Coarser than this, a pixel is wider than a typical shingle course is tall and
# ridge/valley lines blur into the surrounding plane. Zoom 20 at US latitudes
# is ~0.33-0.40; zoom 19 is ~0.66-0.80.
COARSE_FT_PER_PX = 0.55


@dataclass(frozen=True)
class Resolution:
    ft_per_px: float
    zoom: int
    coarse: bool
    signal: str | None


def imagery_resolution(lat: float | None, zoom: int | None) -> Resolution | None:
    """Ground resolution of the run's tile, and whether it is too coarse to
    place edges confidently. None when the run has no tile coordinates."""
    if lat is None or zoom is None:
        return None
    from app.services.geometry_service import feet_per_pixel
    ftpp = feet_per_pixel(float(lat), int(zoom))
    coarse = ftpp > COARSE_FT_PER_PX
    signal = None
    if coarse:
        signal = (
            f"The satellite image here is coarse ({ftpp:.2f} ft per pixel, zoom {int(zoom)}), "
            "so roof edges and facet lines are harder to place precisely. Verify key "
            "dimensions on site before ordering.")
    return Resolution(round(ftpp, 3), int(zoom), coarse, signal)


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
