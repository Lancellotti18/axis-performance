"""Phase 1: measured roof pitch from USGS 3DEP LiDAR — a COVERAGE FALLBACK for the
addresses Google Solar doesn't reach (rural / small-town).

STATUS: interface + guards only. Disabled by default (AXIS_LIDAR_PITCH). It returns
None until the point-cloud path below is implemented and validated on real jobs.
This is deliberate — see the correctness note.

── Why this is a stub, not a quick DEM read ──────────────────────────────────
USGS 3DEP's easily-queryable REST product is the BARE-EARTH DEM. Bare earth has
ground elevation, NOT the roof surface — sampling it and fitting a plane reports a
~flat pitch on every house. Emitting that would break the project's non-negotiable
rule ("every number traces to geometry; a zero is never a silent default"). So this
module refuses to guess: real roof pitch requires the CLASSIFIED POINT CLOUD (first
returns / building class), which contains the roof surface.

── How to implement (when we take the infra on) ──────────────────────────────
  1. Convert the facet polygon (image fractions) → geographic points using the same
     Web Mercator basis the measurement pipeline already uses (lat, zoom, image
     dims) — see geometry_service.metres_per_pixel. Reuse it; don't reinvent it.
  2. Read the 3DEP point cloud for that footprint. Options, lightest first:
       • OpenTopography "USGS 3DEP" API → DSM raster for the AOI (needs API key,
         rate-limited). Fit a plane to the DSM cells inside the polygon.
       • PDAL readers.ept against the USGS EPT/entwine tiles → crop to the polygon
         → filter to building/first-return class → RANSAC plane fit. Heavier
         (PDAL is a C++ dep); verify it builds on Render before committing.
  3. Plane normal → slope angle → "X/12" via geometry_service.degrees_to_pitch.
  4. Return (pitch_string, confidence). Low confidence when point density is thin
     or the plane fit residual is high — never upgrade a shaky fit to a metric.

Until (2) is real and Phase-4 validated, this returns None and the pipeline falls
through to Google Solar → ground photo → AI → contractor confirmation.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)


def is_enabled() -> bool:
    """3DEP pitch is opt-in until validated. Set AXIS_LIDAR_PITCH=1 to turn on."""
    return os.getenv("AXIS_LIDAR_PITCH", "").strip().lower() in ("1", "true", "yes", "on")


def facet_pitch_from_3dep(
    polygon: list[list[float]],
    *,
    lat: float,
    lng: float,
    zoom: int,
    image_width_px: int,
    image_height_px: int,
) -> Optional[tuple[str, float]]:
    """Measured pitch for one facet from 3DEP, or None if unavailable/disabled.

    Returns (pitch_string, confidence) on success. Returns None whenever the pitch
    cannot be measured — never a fabricated default. Callers treat None as "no
    LiDAR pitch" and fall through to the next source.
    """
    if not is_enabled():
        return None
    # Point-cloud path not yet implemented — see module docstring. Returning None
    # (not a guess) is the correct behavior per the non-negotiable rules.
    logger.info("lidar_pitch: enabled but point-cloud path not implemented — returning None")
    return None
