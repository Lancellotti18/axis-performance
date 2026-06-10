"""
APIR (Axis Property Intelligence Report) — Pydantic schemas.

This module is the single source of truth for the shape of an APIR report.
Vision extraction writes into PropertyMeasurements; the diagram renderer
and PDF assembler read from it; the API surfaces it to the frontend.

Notes on deviations from the original APIR spec (Part 2):

* `scale_method = "web_mercator"` is the primary path because Axis serves
  tiles at known zoom/lat — that's mathematically exact (more accurate than
  detecting a car). `gsd` and `reference_object` are fallbacks for non-tile
  imagery (drone photos uploaded later).
* Added `WindowGroup` (WG-X) to support APIR Page 10's grouped-windows
  table. Not in the spec's Part 2 schema, but Page 10 requires it.
* Added `material_zone` on siding entities ("siding" / "brick" / "stone" /
  "unknown") to support Page 3's "Siding vs Other" two-column split and
  Page 9's separate BR-X / UN-X tables.
* `ReportVersion` mirrors the new `reports` table for version-history APIs.
* `CompanyProfile` mirrors the new `company_profile` table for the cover.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


# ─────────────────────────────────────────────────────────────────────────
# Common literal types
# ─────────────────────────────────────────────────────────────────────────

ScaleMethod = Literal["web_mercator", "reference_object", "gsd", "estimated"]
ScaleConfidence = Literal["high", "medium", "estimated"]
ReportType = Literal["full_exterior", "roof_only", "siding_only"]
ReportStatus = Literal["draft", "final"]
SlopeDirection = Literal["N", "S", "E", "W", "NE", "NW", "SE", "SW"]
EdgeType = Literal[
    "ridge", "hip", "valley", "eave", "rake", "flashing", "step_flashing"
]
Elevation = Literal["front", "right", "left", "back"]
DoorType = Literal["entry", "service", "garage", "patio"]
MaterialZone = Literal["siding", "brick", "stone", "unknown"]
RoofMaterial = Literal[
    "metal", "asphalt_shingles", "tile", "flat_membrane",
    "wood_shake", "slate", "unknown",
]
SidingMaterial = Literal[
    "vinyl", "hardie", "wood", "brick", "stucco",
    "aluminum", "stone", "unknown",
]


# ─────────────────────────────────────────────────────────────────────────
# Geometry primitives
# ─────────────────────────────────────────────────────────────────────────

class PointPx(BaseModel):
    """A single {x, y} vertex in satellite-image pixel space."""
    x: float
    y: float


# ─────────────────────────────────────────────────────────────────────────
# Scale calibration provenance
# ─────────────────────────────────────────────────────────────────────────

class ScalingFactor(BaseModel):
    pixels_per_foot: float
    method: ScaleMethod
    confidence: ScaleConfidence
    reference_description: str = ""


# ─────────────────────────────────────────────────────────────────────────
# Roof
# ─────────────────────────────────────────────────────────────────────────

class RoofEdge(BaseModel):
    type: EdgeType
    length_ft: float
    pixel_start: PointPx
    pixel_end: PointPx
    # If type is ridge/hip/valley, the other facet this edge is shared with
    shared_with: Optional[str] = None


class RoofFacet(BaseModel):
    id: str = Field(..., max_length=8)  # "RF-1"
    projected_area_sqft: float
    actual_area_sqft: float            # pitch-corrected (sloped surface)
    pitch: str = "5/12"
    slope_direction: SlopeDirection = "S"
    pixel_polygon: list[PointPx]
    edges: list[RoofEdge] = Field(default_factory=list)
    centroid_px: PointPx

    @field_validator("pixel_polygon")
    @classmethod
    def _check_polygon(cls, v: list[PointPx]) -> list[PointPx]:
        if len(v) < 3:
            raise ValueError("polygon must have at least 3 vertices")
        return v


class RoofLengths(BaseModel):
    ridges_ft: float = 0.0
    hips_ft: float = 0.0
    valleys_ft: float = 0.0
    rakes_ft: float = 0.0
    eaves_ft: float = 0.0
    drip_edge_ft: float = 0.0
    flashing_ft: float = 0.0
    step_flashing_ft: float = 0.0


class PitchBreakdownRow(BaseModel):
    pitch: str
    area_sqft: float
    percentage: float  # 0..100


class RoofWasteRow(BaseModel):
    waste_pct: int
    area_sqft: int
    squares: float
    is_selected: bool


class RoofWasteCalculator(BaseModel):
    roof_waste_pct: int = 12
    siding_waste_pct: int = 10
    roof_waste_table: list[RoofWasteRow] = Field(default_factory=list)


class Roof(BaseModel):
    total_area_sqft: float
    total_facets: int
    predominant_pitch: str
    number_of_stories: int = 1
    material: RoofMaterial = "asphalt_shingles"
    color_description: str = ""
    pitch_confidence: ScaleConfidence = "estimated"

    facets: list[RoofFacet] = Field(default_factory=list)
    lengths: RoofLengths = Field(default_factory=RoofLengths)
    pitch_breakdown: list[PitchBreakdownRow] = Field(default_factory=list)
    waste_calculator: RoofWasteCalculator = Field(default_factory=RoofWasteCalculator)


# ─────────────────────────────────────────────────────────────────────────
# Siding — openings, elevations, corners, trim, roofline, waste
# ─────────────────────────────────────────────────────────────────────────

class WindowGroup(BaseModel):
    """
    APIR Page 10 groups identical-dimension windows on the same elevation
    into a single WG-X row. A triple window is one group with group_size=3.
    """
    id: str = Field(..., max_length=8)        # "WG-3"
    elevation_id: str                          # "SI-1"
    template_w_in: int
    template_h_in: int
    united_inches: int
    group_size: int = 1
    member_window_ids: list[str] = Field(default_factory=list)


class Window(BaseModel):
    id: str = Field(..., max_length=8)        # "W-103"
    elevation_id: str                          # "SI-1"
    window_group_id: Optional[str] = None      # "WG-3" if grouped
    material_zone: MaterialZone = "siding"
    width_in: int
    height_in: int
    united_inches: int
    area_sqft: float
    snapped_to_standard: bool = False
    has_shutters: bool = False
    position_from_left_pct: float = 0.5
    position_from_bottom_pct: float = 0.5


class Door(BaseModel):
    id: str = Field(..., max_length=8)        # "D-1"
    elevation_id: str
    material_zone: MaterialZone = "siding"
    width_in: int
    height_in: int
    area_sqft: float
    type: DoorType = "entry"
    snapped_to_standard: bool = False
    position_from_left_pct: float = 0.5
    position_from_bottom_pct: float = 0.0


class Openings(BaseModel):
    windows: list[Window] = Field(default_factory=list)
    doors: list[Door] = Field(default_factory=list)
    window_groups: list[WindowGroup] = Field(default_factory=list)
    total_window_sqft: float = 0.0
    total_door_sqft: float = 0.0
    total_opening_sqft: float = 0.0


class SidingElevation(BaseModel):
    id: str = Field(..., max_length=8)        # "SI-1"
    elevation: Elevation
    gross_area_sqft: float                     # wall_width × wall_height
    net_area_sqft: float                       # gross minus openings
    wall_width_ft: float                       # derived from roof eave − 2×soffit
    wall_height_ft: float                      # from ground photo
    wall_height_confidence: ScaleConfidence = "estimated"
    material: SidingMaterial = "vinyl"
    material_zone: MaterialZone = "siding"
    # Per-zone breakdown — populates Page 3 "Siding vs Other" tables.
    # For a wholly-siding elevation, primary_material_sqft == net_area_sqft
    # and the other two are 0.
    primary_material_sqft: float = 0.0
    secondary_material_sqft: float = 0.0
    unknown_material_sqft: float = 0.0
    pixel_polygon: list[PointPx] = Field(default_factory=list)
    openings_count: int = 0
    shutter_count: int = 0
    vent_count: int = 0


class CornerCounts(BaseModel):
    """Each side (siding / other) gets its own counts on Page 3."""
    inside_qty: int = 0
    inside_total_length_ft: float = 0.0
    outside_qty: int = 0
    outside_total_length_ft: float = 0.0


class Corners(BaseModel):
    siding: CornerCounts = Field(default_factory=CornerCounts)
    other: CornerCounts = Field(default_factory=CornerCounts)


class Trim(BaseModel):
    level_starter_ft: float = 0.0     # horizontal starter strip
    sloped_trim_ft: float = 0.0       # along rake/gable edges
    vertical_trim_ft: float = 0.0     # vertical corners + window trim


class Roofline(BaseModel):
    eaves_fascia_ft: float = 0.0      # mirrors roof.lengths.eaves_ft
    rakes_fascia_ft: float = 0.0      # mirrors roof.lengths.rakes_ft
    level_frieze_board_ft: float = 0.0
    level_frieze_avg_depth_in: float = 0.0
    soffit_area_sqft: float = 0.0


class SidingWasteRow(BaseModel):
    category: Literal[
        "siding_trim_only", "openings_lt_20sqft", "openings_lt_33sqft"
    ]
    zero_waste_sqft: int
    zero_waste_squares: float
    plus10_sqft: int
    plus10_squares: float
    plus18_sqft: int
    plus18_squares: float


class Siding(BaseModel):
    total_facade_sqft: float = 0.0    # sum of net areas
    total_gross_sqft: float = 0.0     # sum of gross areas
    material: SidingMaterial = "vinyl"
    color_description: str = ""
    secondary_material: Optional[SidingMaterial] = None
    secondary_material_sqft: Optional[float] = None

    elevations: list[SidingElevation] = Field(default_factory=list)
    openings: Openings = Field(default_factory=Openings)
    corners: Corners = Field(default_factory=Corners)
    trim: Trim = Field(default_factory=Trim)
    roofline: Roofline = Field(default_factory=Roofline)
    waste_table: list[SidingWasteRow] = Field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────
# Footprint
# ─────────────────────────────────────────────────────────────────────────

class FootprintSegment(BaseModel):
    direction: str                     # "front", "back", "left", "right", "left-step", ...
    length_ft: float
    pixel_start: PointPx
    pixel_end: PointPx


class Footprint(BaseModel):
    area_sqft: float                   # no pitch correction (it IS the plan view)
    perimeter_ft: float
    number_of_stories: int = 1
    pixel_polygon: list[PointPx] = Field(default_factory=list)
    segments: list[FootprintSegment] = Field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────
# Soffit
# ─────────────────────────────────────────────────────────────────────────

class SoffitSegment(BaseModel):
    id: int
    type: Literal["eave"] = "eave"
    depth_in: float                    # horizontal overhang depth
    length_ft: float
    area_sqft: float
    pitch: str = "5/12"
    depth_confidence: ScaleConfidence = "estimated"


class Soffit(BaseModel):
    total_area_sqft: float = 0.0
    total_length_ft: float = 0.0       # mirrors roof.lengths.eaves_ft
    breakdown: list[SoffitSegment] = Field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────
# Detected features (chimneys, skylights, etc.)
# ─────────────────────────────────────────────────────────────────────────

class Features(BaseModel):
    chimneys: int = 0
    skylights: int = 0
    vents: int = 0
    satellite_dishes: int = 0
    hvac_units: int = 0
    gutters_present: bool = False
    gutters_estimated_length_ft: Optional[float] = None
    garage_doors: int = 0
    garage_door_width_ft: Optional[float] = None


# ─────────────────────────────────────────────────────────────────────────
# Photos
# ─────────────────────────────────────────────────────────────────────────

class AdditionalPhoto(BaseModel):
    url: str
    label: str


class Photos(BaseModel):
    satellite_original: Optional[str] = None
    satellite_annotated: Optional[str] = None
    front_elevation: Optional[str] = None
    right_elevation: Optional[str] = None
    left_elevation: Optional[str] = None
    back_elevation: Optional[str] = None
    additional: list[AdditionalPhoto] = Field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────
# Job metadata, contractor, extraction metadata
# ─────────────────────────────────────────────────────────────────────────

class JobMetadata(BaseModel):
    job_id: str
    property_address: str
    property_city: str = ""
    property_state: str = ""           # 2-letter abbreviation
    property_zip: str = ""
    report_date: str                   # ISO 8601 date "2026-06-10"
    report_type: ReportType = "full_exterior"
    scale_confidence: ScaleConfidence = "estimated"
    scale_method: ScaleMethod = "estimated"
    scale_reference_description: str = ""
    pixels_per_foot: float = 1.0
    report_version: int = 1
    status: ReportStatus = "draft"


class ContractorInfo(BaseModel):
    """Mirrors company_profile row, denormalized into the report snapshot."""
    company_name: str
    contact_name: str = ""
    address: str = ""
    city_state_zip: str = ""
    phone: str = ""
    email: str = ""
    logo_url: str = ""
    license_number: Optional[str] = None
    website: Optional[str] = None


class PitchReading(BaseModel):
    elevation: str
    pitch: str
    confidence: ScaleConfidence
    method: Literal["gable_end", "slope_angle", "estimated"] = "estimated"


class ManualOverride(BaseModel):
    field_path: str                    # "roof.facets[0].pitch"
    original_value: str                # stringified for JSONB portability
    override_value: str
    override_timestamp: str
    override_by: str                   # contractor user_id


class ExtractionMetadata(BaseModel):
    scaling_factor: ScalingFactor
    pitch_readings: list[PitchReading] = Field(default_factory=list)
    ai_model_used: str = "gemini-2.0-flash"
    extraction_timestamp: str          # ISO 8601
    manual_overrides: list[ManualOverride] = Field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────
# The root: PropertyMeasurements
# ─────────────────────────────────────────────────────────────────────────

class PropertyMeasurements(BaseModel):
    """
    The complete data payload for one APIR report. Built once during vision
    extraction, snapshot-frozen into reports.measurements_snapshot at PDF
    generation time, then read by the diagram renderer and HTML template.
    """
    job: JobMetadata
    contractor: ContractorInfo
    roof: Roof
    siding: Siding = Field(default_factory=Siding)
    footprint: Footprint
    soffit: Soffit = Field(default_factory=Soffit)
    features: Features = Field(default_factory=Features)
    photos: Photos = Field(default_factory=Photos)
    extraction_metadata: ExtractionMetadata


# ─────────────────────────────────────────────────────────────────────────
# CompanyProfile — DB row shape for contractor branding
# ─────────────────────────────────────────────────────────────────────────

class CompanyProfile(BaseModel):
    user_id: str
    company_name: str
    contact_name: Optional[str] = None
    address: Optional[str] = None
    city_state_zip: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    logo_url: Optional[str] = None
    license_number: Optional[str] = None
    website: Optional[str] = None


class CompanyProfileUpsert(BaseModel):
    """Payload accepted by PUT /api/v2/company-profile."""
    company_name: str = Field(..., min_length=1, max_length=200)
    contact_name: Optional[str] = Field(None, max_length=120)
    address: Optional[str] = Field(None, max_length=240)
    city_state_zip: Optional[str] = Field(None, max_length=120)
    phone: Optional[str] = Field(None, max_length=40)
    email: Optional[str] = Field(None, max_length=200)
    logo_url: Optional[str] = Field(None, max_length=1000)
    license_number: Optional[str] = Field(None, max_length=80)
    website: Optional[str] = Field(None, max_length=400)


# ─────────────────────────────────────────────────────────────────────────
# Report row + version history
# ─────────────────────────────────────────────────────────────────────────

class ReportVersion(BaseModel):
    id: str
    project_id: str
    run_id: Optional[str] = None
    version: int
    status: ReportStatus
    pdf_url: Optional[str] = None
    pdf_size_kb: Optional[int] = None
    scale_confidence: Optional[ScaleConfidence] = None
    scale_method: Optional[str] = None
    report_type: Optional[ReportType] = None
    ai_model_used: Optional[str] = None
    page_count: int = 12
    generated_at: datetime
    generated_by: Optional[str] = None
    finalized_at: Optional[datetime] = None
    finalized_by: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────
# API request / response shapes (mirrors APIR Part 7)
# ─────────────────────────────────────────────────────────────────────────

class GenerateReportRequest(BaseModel):
    project_id: str
    run_id: Optional[str] = None       # default: latest run for the project
    report_type: ReportType = "full_exterior"
    force_regenerate: bool = False


class GenerateReportResponse(BaseModel):
    report_id: str
    status: ReportStatus
    version: int
    download_url: Optional[str] = None
    generated_at: datetime
    page_count: int = 12
    scale_confidence: ScaleConfidence


# Error codes used by /api/v2/reports/generate. Map 1:1 to APIR Part 7.
ReportErrorCode = Literal[
    "MISSING_REQUIRED_DATA",
    "NO_ROOF_OUTLINES",
    "SATELLITE_RESOLUTION_TOO_LOW",
    "EXTRACTION_FAILED",
    "FINALIZED_REPORT_LOCKED",
]


class ReportErrorResponse(BaseModel):
    error: ReportErrorCode
    message: str
    details: Optional[dict] = None
