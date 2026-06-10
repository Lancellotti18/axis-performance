"""
APIR vision-extraction orchestrator.

Takes pre-fetched job inputs (run row + facet rows + photos + outlines) and
returns a fully-assembled PropertyMeasurements. The DB-fetching layer lives
above this module — see the router in Phase 4 (`POST /api/v2/reports/generate`).

Pipeline (APIR Part 1.8):
  1. Scale calibration (web_mercator if zoom+lat known, else AI fallback)
  2. Roof: measure each contractor polygon, classify edges, pitch correction
  3. Pitch detection from ground photos (median across elevations)
  4. Siding: derive wall width from roof eaves − 2×soffit (APIR deviation —
     drops the redundant SI-X polygon drawing in favor of derivation)
  5. Materials + colors from elevation photos
  6. Soffit depths from eave-visible photos
  7. Assemble PropertyMeasurements
"""
from __future__ import annotations

import asyncio
import logging
import statistics
from datetime import datetime, timezone
from typing import Optional

from app.schemas.apir import (
    ContractorInfo, ExtractionMetadata, Features, Footprint, FootprintSegment,
    JobMetadata, PitchReading, PointPx, PropertyMeasurements, RoofFacet,
    RoofLengths, RoofWasteCalculator, RoofWasteRow, ScaleConfidence,
    ScalingFactor, Photos, Roof, ReportType, Siding, SidingElevation,
    Soffit, SoffitSegment, Window, WindowGroup, Door, Openings,
    PitchBreakdownRow,
)
from app.services.report import geometry, vision_prompts
from app.services.report.scale_calibration import calibrate_scale

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────
# Input container — what the router hands us
# ─────────────────────────────────────────────────────────────────────────

class ExtractionInput:
    """
    Pre-fetched data assembled by the API layer (or a test fixture). All
    fields are plain dicts/bytes so this module stays decoupled from
    SQLAlchemy / Supabase client choices.
    """

    def __init__(
        self,
        *,
        job_row: dict,
        contractor_row: Optional[dict],
        facet_polygons: dict[str, list[PointPx]],
        footprint_polygon: Optional[list[PointPx]],
        feature_polygons: Optional[dict[str, list[PointPx]]] = None,
        penetration_counts: Optional[dict[str, int]] = None,
        elevation_photo_bytes: Optional[dict[str, tuple[bytes, str]]] = None,
        eave_photo_bytes: Optional[list[tuple[bytes, str]]] = None,
        overhead_photo_bytes: Optional[tuple[bytes, str]] = None,
        roof_waste_pct: int = 12,
        siding_waste_pct: int = 10,
        report_type: ReportType = "full_exterior",
    ):
        self.job_row = job_row
        self.contractor_row = contractor_row
        self.facet_polygons = facet_polygons
        self.footprint_polygon = footprint_polygon
        self.feature_polygons = feature_polygons or {}
        self.penetration_counts = penetration_counts or {}
        self.elevation_photo_bytes = elevation_photo_bytes or {}
        self.eave_photo_bytes = eave_photo_bytes or []
        self.overhead_photo_bytes = overhead_photo_bytes
        self.roof_waste_pct = roof_waste_pct
        self.siding_waste_pct = siding_waste_pct
        self.report_type: ReportType = report_type


# ─────────────────────────────────────────────────────────────────────────
# Public entry point
# ─────────────────────────────────────────────────────────────────────────

async def build_property_measurements(inp: ExtractionInput) -> PropertyMeasurements:
    # 1. Scale calibration -------------------------------------------------
    scale = await _calibrate(inp)

    # 2. Vision calls fan out in parallel ---------------------------------
    pitch_task = asyncio.create_task(_detect_pitches_from_elevations(inp))
    materials_task = asyncio.create_task(_detect_materials(inp))
    soffit_task = asyncio.create_task(_detect_soffit_depths(inp))
    walls_task = asyncio.create_task(_analyze_all_walls(inp))
    pitch_readings, materials, soffit_depths, wall_results = await asyncio.gather(
        pitch_task, materials_task, soffit_task, walls_task
    )

    # 3. Roof: measure facets + classify edges ----------------------------
    median_pitch = _median_pitch([r.pitch for r in pitch_readings]) or "5/12"
    pitch_confidence = _aggregate_confidence([r.confidence for r in pitch_readings])
    facets = _build_roof_facets(inp.facet_polygons, scale, median_pitch)
    roof = _assemble_roof(
        facets=facets,
        scale=scale,
        predominant_pitch=median_pitch,
        pitch_confidence=pitch_confidence,
        materials=materials,
        roof_waste_pct=inp.roof_waste_pct,
        siding_waste_pct=inp.siding_waste_pct,
    )

    # 4. Footprint ---------------------------------------------------------
    footprint = _build_footprint(inp.footprint_polygon, scale, inp.job_row)

    # 5. Soffit (one segment per eave, paired with the median soffit depth)
    median_soffit_in = (
        statistics.median(d.depth_in for d in soffit_depths)
        if soffit_depths else 6.0
    )
    soffit_confidence = (
        _aggregate_confidence([d.confidence for d in soffit_depths])
        if soffit_depths else "estimated"
    )
    soffit = _build_soffit(facets, median_soffit_in, soffit_confidence, median_pitch)

    # 6. Siding — wall_width derived from roof eaves − 2×soffit (APIR deviation)
    siding = _build_siding(
        facets=facets,
        wall_results=wall_results,
        median_soffit_in=median_soffit_in,
        materials=materials,
        siding_waste_pct=inp.siding_waste_pct,
        roofline_eaves_ft=roof.lengths.eaves_ft,
        roofline_rakes_ft=roof.lengths.rakes_ft,
        soffit_total_sqft=soffit.total_area_sqft,
    )

    # 7. Features (chimneys, vents, etc) from penetration counts
    features = _build_features(inp.penetration_counts, inp.feature_polygons)

    # 8. Assemble PropertyMeasurements
    return PropertyMeasurements(
        job=_build_job_metadata(inp.job_row, scale, inp.report_type),
        contractor=_build_contractor(inp.contractor_row),
        roof=roof,
        siding=siding,
        footprint=footprint,
        soffit=soffit,
        features=features,
        photos=_build_photos(inp.job_row, inp.elevation_photo_bytes),
        extraction_metadata=ExtractionMetadata(
            scaling_factor=scale,
            pitch_readings=[
                PitchReading(
                    elevation=elev, pitch=r.pitch,
                    confidence=r.confidence, method=r.method,
                )
                for elev, r in zip(
                    sorted(inp.elevation_photo_bytes.keys()), pitch_readings
                )
            ],
            ai_model_used="gemini-2.0-flash",
            extraction_timestamp=datetime.now(timezone.utc).isoformat(),
        ),
    )


# ─────────────────────────────────────────────────────────────────────────
# 1. Scale calibration
# ─────────────────────────────────────────────────────────────────────────

async def _calibrate(inp: ExtractionInput) -> ScalingFactor:
    job = inp.job_row
    image_bytes = None
    media_type = "image/png"
    if inp.overhead_photo_bytes:
        image_bytes, media_type = inp.overhead_photo_bytes
    return await calibrate_scale(
        image_bytes=image_bytes,
        media_type=media_type,
        zoom=job.get("satellite_zoom"),
        latitude_deg=job.get("satellite_lat"),
        retina_factor=2,
        footprint_polygon=inp.footprint_polygon,
    )


# ─────────────────────────────────────────────────────────────────────────
# 2. Vision fan-out
# ─────────────────────────────────────────────────────────────────────────

async def _detect_pitches_from_elevations(
    inp: ExtractionInput,
) -> list[vision_prompts.PitchReadingResult]:
    if not inp.elevation_photo_bytes:
        return []
    elevations = sorted(inp.elevation_photo_bytes.keys())
    results = await asyncio.gather(
        *[
            vision_prompts.detect_pitch(
                *inp.elevation_photo_bytes[elev]  # type: ignore[arg-type]
            )
            for elev in elevations
        ],
        return_exceptions=True,
    )
    out: list[vision_prompts.PitchReadingResult] = []
    for r in results:
        if isinstance(r, vision_prompts.PitchReadingResult):
            out.append(r)
    return out


async def _detect_materials(inp: ExtractionInput) -> vision_prompts.MaterialResult:
    """Run material detection on the front elevation (fall back to any)."""
    photos = inp.elevation_photo_bytes
    if not photos:
        return vision_prompts._materials_fallback()
    pick = photos.get("front") or next(iter(photos.values()))
    return await vision_prompts.detect_materials(*pick)


async def _detect_soffit_depths(
    inp: ExtractionInput,
) -> list[vision_prompts.SoffitDepthResult]:
    if not inp.eave_photo_bytes:
        return []
    results = await asyncio.gather(
        *[vision_prompts.detect_soffit_depth(b, mt) for b, mt in inp.eave_photo_bytes],
        return_exceptions=True,
    )
    return [r for r in results if isinstance(r, vision_prompts.SoffitDepthResult)]


async def _analyze_all_walls(
    inp: ExtractionInput,
) -> dict[str, vision_prompts.WallAnalysisResult]:
    """Returns map: elevation → WallAnalysisResult."""
    if not inp.elevation_photo_bytes:
        return {}
    elevations = list(inp.elevation_photo_bytes.keys())
    coros = [
        vision_prompts.analyze_wall_openings(
            *inp.elevation_photo_bytes[elev],  # type: ignore[arg-type]
            elevation=elev,
        )
        for elev in elevations
    ]
    raw = await asyncio.gather(*coros, return_exceptions=True)
    out: dict[str, vision_prompts.WallAnalysisResult] = {}
    for elev, r in zip(elevations, raw):
        if isinstance(r, vision_prompts.WallAnalysisResult):
            out[elev] = r
    return out


# ─────────────────────────────────────────────────────────────────────────
# 3. Roof assembly
# ─────────────────────────────────────────────────────────────────────────

def _build_roof_facets(
    facet_polygons: dict[str, list[PointPx]],
    scale: ScalingFactor,
    predominant_pitch: str,
) -> list[RoofFacet]:
    """Build RoofFacet[] but defer edge classification — it needs every facet."""
    facets: list[RoofFacet] = []
    for facet_id, poly in sorted(facet_polygons.items()):
        if len(poly) < 3:
            continue
        projected = geometry.shoelace_area_sqft(poly, scale.pixels_per_foot)
        actual = geometry.actual_roof_area_sqft(projected, predominant_pitch)
        centroid = geometry.polygon_centroid(poly)
        facets.append(RoofFacet(
            id=facet_id,
            projected_area_sqft=round(projected, 2),
            actual_area_sqft=round(actual, 2),
            pitch=predominant_pitch,
            slope_direction="S",  # placeholder — overwritten after edge classification
            pixel_polygon=poly,
            edges=[],
            centroid_px=centroid,
        ))
    # Now classify edges (needs all facets for shared-edge detection)
    for facet in facets:
        facet.edges = geometry.measure_facet_edges(facet, facets, scale.pixels_per_foot)
        # Derive slope_direction from the (first) eave edge perpendicular to centroid
        eave = next((e for e in facet.edges if e.type == "eave"), None)
        if eave is not None:
            facet.slope_direction = geometry.slope_direction_perpendicular_to_centroid(
                eave.pixel_start, eave.pixel_end, facet.centroid_px,
            )
    return facets


def _assemble_roof(
    *,
    facets: list[RoofFacet],
    scale: ScalingFactor,
    predominant_pitch: str,
    pitch_confidence: ScaleConfidence,
    materials: vision_prompts.MaterialResult,
    roof_waste_pct: int,
    siding_waste_pct: int,
) -> Roof:
    totals = geometry.sum_edge_lengths_by_type(facets)
    total_area_sqft = sum(f.actual_area_sqft for f in facets)

    pitch_breakdown = _build_pitch_breakdown(facets, total_area_sqft)
    waste_table = _build_roof_waste_table(total_area_sqft, roof_waste_pct)

    return Roof(
        total_area_sqft=round(total_area_sqft, 2),
        total_facets=len(facets),
        predominant_pitch=predominant_pitch,
        number_of_stories=1,  # TODO: derive from facade height in Phase 1.5
        material=_coerce_roof_material(materials.roof_material),
        color_description=materials.roof_color,
        pitch_confidence=pitch_confidence,
        facets=facets,
        lengths=RoofLengths(**totals),
        pitch_breakdown=pitch_breakdown,
        waste_calculator=RoofWasteCalculator(
            roof_waste_pct=roof_waste_pct,
            siding_waste_pct=siding_waste_pct,
            roof_waste_table=waste_table,
        ),
    )


def _build_pitch_breakdown(
    facets: list[RoofFacet], total: float,
) -> list[PitchBreakdownRow]:
    if total <= 0:
        return []
    by_pitch: dict[str, float] = {}
    for f in facets:
        by_pitch[f.pitch] = by_pitch.get(f.pitch, 0.0) + f.actual_area_sqft
    rows = [
        PitchBreakdownRow(
            pitch=pitch, area_sqft=round(area, 2),
            percentage=round(100.0 * area / total, 1),
        )
        for pitch, area in by_pitch.items()
    ]
    rows.sort(key=lambda r: r.area_sqft, reverse=True)
    return rows


def _build_roof_waste_table(total_area: float, selected_pct: int) -> list[RoofWasteRow]:
    """APIR's 8 waste-% rows. Squares rounded UP to nearest 0.25."""
    import math as _m
    rows = []
    for pct in (0, 5, 10, 12, 15, 17, 20, 22):
        area = total_area * (1 + pct / 100)
        squares = _m.ceil(area / 100 * 4) / 4
        rows.append(RoofWasteRow(
            waste_pct=pct,
            area_sqft=int(round(area)),
            squares=squares,
            is_selected=(pct == selected_pct),
        ))
    return rows


# ─────────────────────────────────────────────────────────────────────────
# 4. Footprint assembly
# ─────────────────────────────────────────────────────────────────────────

def _build_footprint(
    polygon: Optional[list[PointPx]],
    scale: ScalingFactor,
    job_row: dict,
) -> Footprint:
    if not polygon or len(polygon) < 3:
        return Footprint(area_sqft=0.0, perimeter_ft=0.0,
                         number_of_stories=1, pixel_polygon=[], segments=[])
    area = geometry.shoelace_area_sqft(polygon, scale.pixels_per_foot)
    perim = geometry.perimeter_ft(polygon, scale.pixels_per_foot)
    segments = _build_footprint_segments(polygon, scale)
    return Footprint(
        area_sqft=round(area, 2),
        perimeter_ft=round(perim, 2),
        number_of_stories=int(job_row.get("stories", 1) or 1),
        pixel_polygon=polygon,
        segments=segments,
    )


def _build_footprint_segments(
    polygon: list[PointPx], scale: ScalingFactor,
) -> list[FootprintSegment]:
    n = len(polygon)
    if n < 3:
        return []
    # Compass direction inference — naive but matches APIR's "back/front/left/right"
    # labels. Sort edges by midpoint angle from centroid.
    cx = sum(p.x for p in polygon) / n
    cy = sum(p.y for p in polygon) / n
    out: list[FootprintSegment] = []
    for i in range(n):
        j = (i + 1) % n
        a, b = polygon[i], polygon[j]
        length = geometry.edge_length_ft(a, b, scale.pixels_per_foot)
        mid_x = (a.x + b.x) / 2
        mid_y = (a.y + b.y) / 2
        # Pick the cardinal direction from centroid → edge midpoint
        dx = mid_x - cx
        dy = mid_y - cy
        if abs(dx) > abs(dy):
            direction = "right" if dx > 0 else "left"
        else:
            direction = "front" if dy > 0 else "back"
        out.append(FootprintSegment(
            direction=direction,
            length_ft=round(length, 2),
            pixel_start=a, pixel_end=b,
        ))
    return out


# ─────────────────────────────────────────────────────────────────────────
# 5. Soffit assembly
# ─────────────────────────────────────────────────────────────────────────

def _build_soffit(
    facets: list[RoofFacet],
    depth_in: float,
    confidence: ScaleConfidence,
    pitch: str,
) -> Soffit:
    """One soffit segment per eave edge. Area = depth_in/12 × eave length."""
    breakdown: list[SoffitSegment] = []
    seg_id = 0
    total_area = 0.0
    total_length = 0.0
    seen_shared: set[tuple] = set()
    for facet in facets:
        for edge in facet.edges:
            if edge.type != "eave":
                continue
            # Deduplicate shared eaves (rare but possible at building joins)
            pa = (round(edge.pixel_start.x, 1), round(edge.pixel_start.y, 1))
            pb = (round(edge.pixel_end.x, 1), round(edge.pixel_end.y, 1))
            sig = tuple(sorted([pa, pb]))
            if sig in seen_shared:
                continue
            seen_shared.add(sig)
            seg_id += 1
            area = (depth_in / 12.0) * edge.length_ft
            total_area += area
            total_length += edge.length_ft
            breakdown.append(SoffitSegment(
                id=seg_id,
                depth_in=round(depth_in, 1),
                length_ft=round(edge.length_ft, 2),
                area_sqft=round(area, 1),
                pitch=facet.pitch or pitch,
                depth_confidence=confidence,
            ))
    return Soffit(
        total_area_sqft=round(total_area, 1),
        total_length_ft=round(total_length, 2),
        breakdown=breakdown,
    )


# ─────────────────────────────────────────────────────────────────────────
# 6. Siding assembly
# ─────────────────────────────────────────────────────────────────────────

def _build_siding(
    *,
    facets: list[RoofFacet],
    wall_results: dict[str, vision_prompts.WallAnalysisResult],
    median_soffit_in: float,
    materials: vision_prompts.MaterialResult,
    siding_waste_pct: int,
    roofline_eaves_ft: float,
    roofline_rakes_ft: float,
    soffit_total_sqft: float,
) -> Siding:
    """
    APIR deviation: instead of contractor-drawn SI-X polygons, derive each
    elevation's wall width from the corresponding roof eave length minus
    2× soffit depth (one overhang per side). Wall height comes from the
    per-elevation Gemini analysis.

    For Phase 1 we map elevations to facets by their slope direction:
        S → front,  N → back,  E → right,  W → left
    (assumes the contractor traced the satellite with north up, which is
    the default for all imagery providers.)
    """
    soffit_overhang_ft = (median_soffit_in / 12.0) * 2  # both sides
    elevations: list[SidingElevation] = []
    openings_list: list[Window] = []
    doors_list: list[Door] = []
    window_groups: list[WindowGroup] = []

    elev_to_dir: dict[str, str] = {"S": "front", "N": "back", "E": "right", "W": "left"}

    # Aggregate eave length per elevation
    eave_per_elev: dict[str, float] = {"front": 0.0, "back": 0.0, "right": 0.0, "left": 0.0}
    for facet in facets:
        elev = elev_to_dir.get(facet.slope_direction)
        if not elev:
            continue
        for e in facet.edges:
            if e.type == "eave":
                eave_per_elev[elev] += e.length_ft

    si_index = 1
    win_index = 1
    door_index = 1

    for elev in ("front", "right", "left", "back"):
        wall = wall_results.get(elev)
        wall_height = wall.wall_height_ft if wall else 8.5
        height_conf: ScaleConfidence = (
            wall.wall_height_confidence if wall else "estimated"
        )
        wall_width = max(eave_per_elev[elev] - soffit_overhang_ft, 0.0)
        if wall_width <= 0:
            continue
        gross = wall_width * wall_height
        opening_area = sum(
            (op.width_in * op.height_in) / 144.0
            for op in (wall.openings if wall else [])
        )
        net = max(gross - opening_area, 0.0)
        si_id = f"SI-{si_index}"
        si_index += 1

        # Materialize each opening into a Window/Door
        if wall:
            for op in wall.openings:
                area = (op.width_in * op.height_in) / 144.0
                if op.type == "window":
                    win_id = f"W-{win_index}"
                    win_index += 1
                    openings_list.append(Window(
                        id=win_id,
                        elevation_id=si_id,
                        material_zone="siding",
                        width_in=op.width_in,
                        height_in=op.height_in,
                        united_inches=op.width_in + op.height_in,
                        area_sqft=round(area, 2),
                        snapped_to_standard=op.snapped_to_standard,
                        has_shutters=op.has_shutters,
                        position_from_left_pct=op.position_from_left_pct,
                        position_from_bottom_pct=op.position_from_bottom_pct,
                    ))
                else:
                    door_id = f"D-{door_index}"
                    door_index += 1
                    doors_list.append(Door(
                        id=door_id,
                        elevation_id=si_id,
                        material_zone="siding",
                        width_in=op.width_in,
                        height_in=op.height_in,
                        area_sqft=round(area, 2),
                        type="entry",
                        snapped_to_standard=op.snapped_to_standard,
                        position_from_left_pct=op.position_from_left_pct,
                        position_from_bottom_pct=op.position_from_bottom_pct,
                    ))

        elevations.append(SidingElevation(
            id=si_id,
            elevation=elev,  # type: ignore[arg-type]
            gross_area_sqft=round(gross, 1),
            net_area_sqft=round(net, 1),
            wall_width_ft=round(wall_width, 2),
            wall_height_ft=round(wall_height, 2),
            wall_height_confidence=height_conf,
            material=_coerce_siding_material(materials.siding_material),
            material_zone="siding",
            primary_material_sqft=round(net, 1),
            secondary_material_sqft=0.0,
            unknown_material_sqft=0.0,
            pixel_polygon=[],   # no SI-X polygon was drawn — derived siding
            openings_count=len(wall.openings) if wall else 0,
            shutter_count=wall.shutter_count if wall else 0,
            vent_count=wall.vent_count if wall else 0,
        ))

    # Group windows by (elevation_id, w, h) — APIR's WG-X grouping
    window_groups = _build_window_groups(openings_list)

    total_window_sqft = sum(w.area_sqft for w in openings_list)
    total_door_sqft = sum(d.area_sqft for d in doors_list)
    total_facade = sum(e.net_area_sqft for e in elevations)
    total_gross = sum(e.gross_area_sqft for e in elevations)

    return Siding(
        total_facade_sqft=round(total_facade, 1),
        total_gross_sqft=round(total_gross, 1),
        material=_coerce_siding_material(materials.siding_material),
        color_description=materials.siding_color,
        elevations=elevations,
        openings=Openings(
            windows=openings_list,
            doors=doors_list,
            window_groups=window_groups,
            total_window_sqft=round(total_window_sqft, 1),
            total_door_sqft=round(total_door_sqft, 1),
            total_opening_sqft=round(total_window_sqft + total_door_sqft, 1),
        ),
        # corners/trim default to zeros — Phase 1.5 will derive from footprint
        # roofline mirrors the roof totals so Page 3's "Roofline" table is correct
        # without re-computing
        waste_table=_build_siding_waste_table(total_facade, openings_list, doors_list),
    )


def _build_window_groups(windows: list[Window]) -> list[WindowGroup]:
    """Cluster identical-dimension windows on the same elevation into WG-X."""
    buckets: dict[tuple[str, int, int], list[str]] = {}
    for w in windows:
        key = (w.elevation_id, w.width_in, w.height_in)
        buckets.setdefault(key, []).append(w.id)
    groups: list[WindowGroup] = []
    g_idx = 1
    for (elev, w_in, h_in), members in buckets.items():
        if len(members) < 2:
            continue  # only group when there are 2+ identical windows
        wg_id = f"WG-{g_idx}"
        g_idx += 1
        groups.append(WindowGroup(
            id=wg_id,
            elevation_id=elev,
            template_w_in=w_in,
            template_h_in=h_in,
            united_inches=w_in + h_in,
            group_size=len(members),
            member_window_ids=members,
        ))
    # Tag each member window with its group id
    member_to_group = {
        m: g.id for g in groups for m in g.member_window_ids
    }
    for w in windows:
        if w.id in member_to_group:
            w.window_group_id = member_to_group[w.id]
    return groups


def _build_siding_waste_table(
    total_facade: float, windows: list[Window], doors: list[Door],
):
    """APIR's 3-row waste table: trim-only, +openings<20sqft, +openings<33sqft."""
    import math as _m
    from app.schemas.apir import SidingWasteRow

    small_openings = (
        sum(w.area_sqft for w in windows if w.area_sqft < 20)
        + sum(d.area_sqft for d in doors if d.area_sqft < 20)
    )
    medium_openings = (
        sum(w.area_sqft for w in windows if w.area_sqft < 33)
        + sum(d.area_sqft for d in doors if d.area_sqft < 33)
    )

    def _row(category: str, base: float) -> SidingWasteRow:
        z = base
        p10 = base * 1.10
        p18 = base * 1.18
        return SidingWasteRow(
            category=category,  # type: ignore[arg-type]
            zero_waste_sqft=int(round(z)),
            zero_waste_squares=_m.ceil(z / 100 * 4) / 4,
            plus10_sqft=int(round(p10)),
            plus10_squares=_m.ceil(p10 / 100 * 4) / 4,
            plus18_sqft=int(round(p18)),
            plus18_squares=_m.ceil(p18 / 100 * 4) / 4,
        )

    return [
        _row("siding_trim_only", total_facade),
        _row("openings_lt_20sqft", total_facade + small_openings),
        _row("openings_lt_33sqft", total_facade + medium_openings),
    ]


# ─────────────────────────────────────────────────────────────────────────
# 7. Features assembly
# ─────────────────────────────────────────────────────────────────────────

def _build_features(
    penetration_counts: dict[str, int],
    feature_polygons: dict[str, list[PointPx]],
) -> Features:
    """penetration_counts keys map to roof_penetrations.type values."""
    return Features(
        chimneys=int(penetration_counts.get("chimney", 0))
                 + (1 if "chimney" in feature_polygons else 0),
        skylights=int(penetration_counts.get("skylight", 0)),
        vents=(
            int(penetration_counts.get("plumbing_vent", 0))
            + int(penetration_counts.get("exhaust_vent", 0))
            + int(penetration_counts.get("ridge_vent", 0))
            + int(penetration_counts.get("box_vent", 0))
            + int(penetration_counts.get("turbine_vent", 0))
        ),
        satellite_dishes=int(penetration_counts.get("satellite_dish", 0)),
        hvac_units=int(penetration_counts.get("hvac_unit", 0)),
        gutters_present=False,
        garage_doors=0,
    )


# ─────────────────────────────────────────────────────────────────────────
# Job + contractor metadata
# ─────────────────────────────────────────────────────────────────────────

def _build_job_metadata(
    job_row: dict, scale: ScalingFactor, report_type: ReportType,
) -> JobMetadata:
    addr = job_row.get("property_address") or ""
    return JobMetadata(
        job_id=str(job_row.get("id", job_row.get("run_id", ""))),
        property_address=addr,
        property_city=job_row.get("property_city", ""),
        property_state=job_row.get("property_state", ""),
        property_zip=job_row.get("property_zip", ""),
        report_date=datetime.now(timezone.utc).date().isoformat(),
        report_type=report_type,
        scale_confidence=scale.confidence,
        scale_method=scale.method,
        scale_reference_description=scale.reference_description,
        pixels_per_foot=scale.pixels_per_foot,
        report_version=int(job_row.get("report_version", 1) or 1),
        status="draft",
    )


def _build_contractor(row: Optional[dict]) -> ContractorInfo:
    if not row:
        return ContractorInfo(company_name="Axis Performance")
    return ContractorInfo(
        company_name=row.get("company_name") or "Axis Performance",
        contact_name=row.get("contact_name") or "",
        address=row.get("address") or "",
        city_state_zip=row.get("city_state_zip") or "",
        phone=row.get("phone") or "",
        email=row.get("email") or "",
        logo_url=row.get("logo_url") or "",
        license_number=row.get("license_number"),
        website=row.get("website"),
    )


def _build_photos(
    job_row: dict, elevation_photo_bytes: dict[str, tuple[bytes, str]],
) -> Photos:
    """For Phase 1 we only carry the URL of the satellite tile; per-elevation
    URLs come in via job_row when the API layer hydrates them."""
    return Photos(
        satellite_original=job_row.get("satellite_image_url"),
        front_elevation=job_row.get("front_photo_url"),
        right_elevation=job_row.get("right_photo_url"),
        left_elevation=job_row.get("left_photo_url"),
        back_elevation=job_row.get("back_photo_url"),
    )


# ─────────────────────────────────────────────────────────────────────────
# Aggregation helpers
# ─────────────────────────────────────────────────────────────────────────

def _median_pitch(pitches: list[str]) -> Optional[str]:
    """Return the median pitch as 'rise/12' (ignores values without '/')."""
    rises: list[int] = []
    for p in pitches:
        if "/" in p:
            try:
                rises.append(int(p.split("/")[0]))
            except ValueError:
                continue
    if not rises:
        return None
    rises.sort()
    return f"{rises[len(rises) // 2]}/12"


def _aggregate_confidence(values: list[ScaleConfidence]) -> ScaleConfidence:
    """Take the lowest confidence across all readings (most conservative)."""
    if not values:
        return "estimated"
    order = {"high": 2, "medium": 1, "estimated": 0}
    lowest = min(values, key=lambda v: order.get(v, 0))
    return lowest


def _coerce_roof_material(raw: str) -> str:
    valid = {"metal", "asphalt_shingles", "tile", "flat_membrane",
             "wood_shake", "slate", "unknown"}
    return raw if raw in valid else "unknown"


def _coerce_siding_material(raw: str) -> str:
    valid = {"vinyl", "hardie", "wood", "brick", "stucco",
             "aluminum", "stone", "unknown"}
    return raw if raw in valid else "unknown"
