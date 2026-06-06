"""
Axis Performance — Training-Data Collection API.

Phase-0 of Option 4 (custom segmentation model). Every facet, edge,
penetration, wall, and opening a contractor confirms is captured to the
training_examples table by Postgres triggers (see migration
20260606_training_data_collection.sql). This module exposes:

  GET  /training/stats           — total count + breakdown by task_type / quality
  GET  /training/examples        — paginated list (filterable by task_type, quality_tier)
  GET  /training/examples/{id}   — single example with full annotation
  PATCH /training/examples/{id}  — mark reviewed / rejected / expert_verified
  GET  /training/export          — COCO-format JSON export ready for SAM2 fine-tuning

The COCO export emits a standard polygon-segmentation JSON file consumable
by every major training framework (Detectron2, MMDetection, SAM2 fine-tune
scripts, etc.). One file per task_type so the model trainer can pick which
task to train.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from app.core.auth import require_user
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)
router = APIRouter()


TASK_TYPES = (
    "roof_facet_polygon", "edge_classification", "penetration_location",
    "wall_polygon", "opening_rectangle", "roof_outline_polygon",
)

QUALITY_TIERS = ("unverified", "reviewed", "expert_verified", "rejected")


# ----------------------------------------------------------------------------
# Stats
# ----------------------------------------------------------------------------

@router.get("/stats")
async def get_training_stats(user: dict = Depends(require_user)) -> dict:
    """
    Headline numbers for the /training-data dashboard.

    Returns:
      {
        "total": 1247,
        "by_task_type": {"roof_facet_polygon": 412, "edge_classification": 803, ...},
        "by_quality": {"unverified": 1100, "reviewed": 140, "rejected": 7},
        "by_capture_source": {"organic": 1100, "ai_corrected": 147},
        "ready_for_training": 140,        # quality_tier in ('reviewed','expert_verified')
        "recent_7d": 89,                  # examples added in last 7 days
      }
    """
    db = get_supabase()
    res = db.table("training_examples").select(
        "task_type, quality_tier, capture_source, created_at", count="exact",
    ).execute()
    rows = res.data or []
    total = res.count if res.count is not None else len(rows)

    by_task: dict[str, int] = {}
    by_quality: dict[str, int] = {}
    by_source: dict[str, int] = {}
    ready_count = 0
    recent_count = 0

    from datetime import datetime, timedelta, timezone
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)

    for r in rows:
        t = r.get("task_type") or "unknown"
        q = r.get("quality_tier") or "unverified"
        s = r.get("capture_source") or "organic"
        by_task[t] = by_task.get(t, 0) + 1
        by_quality[q] = by_quality.get(q, 0) + 1
        by_source[s] = by_source.get(s, 0) + 1
        if q in ("reviewed", "expert_verified"):
            ready_count += 1
        created_raw = r.get("created_at")
        if created_raw:
            try:
                # Supabase returns ISO 8601 in UTC
                created = datetime.fromisoformat(str(created_raw).replace("Z", "+00:00"))
                if created >= cutoff:
                    recent_count += 1
            except Exception:
                pass

    return {
        "total": total,
        "by_task_type": by_task,
        "by_quality": by_quality,
        "by_capture_source": by_source,
        "ready_for_training": ready_count,
        "recent_7d": recent_count,
    }


# ----------------------------------------------------------------------------
# List
# ----------------------------------------------------------------------------

@router.get("/examples")
async def list_examples(
    task_type: Optional[str] = Query(None),
    quality_tier: Optional[str] = Query(None),
    capture_source: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    q = db.table("training_examples").select("*").order("created_at", desc=True)
    if task_type:
        if task_type not in TASK_TYPES:
            raise HTTPException(status_code=422, detail="Unknown task_type.")
        q = q.eq("task_type", task_type)
    if quality_tier:
        if quality_tier not in QUALITY_TIERS:
            raise HTTPException(status_code=422, detail="Unknown quality_tier.")
        q = q.eq("quality_tier", quality_tier)
    if capture_source:
        if capture_source not in ("organic", "labeling_mode", "ai_corrected"):
            raise HTTPException(status_code=422, detail="Unknown capture_source.")
        q = q.eq("capture_source", capture_source)
    q = q.range(offset, offset + limit - 1)
    res = q.execute()
    return {"examples": res.data or [], "count": len(res.data or [])}


@router.get("/examples/{example_id}")
async def get_example(example_id: str, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    res = db.table("training_examples").select("*").eq("id", example_id).single().execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Example not found.")
    return res.data


class PatchExampleRequest(BaseModel):
    quality_tier: Optional[Literal["unverified", "reviewed", "expert_verified", "rejected"]] = None
    reviewer_notes: Optional[str] = None


@router.patch("/examples/{example_id}")
async def patch_example(
    example_id: str, req: PatchExampleRequest, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    updates: dict[str, Any] = req.model_dump(exclude_none=True)
    if "quality_tier" in updates:
        updates["reviewer_id"] = user.get("sub")
        from datetime import datetime, timezone
        updates["reviewed_at"] = datetime.now(timezone.utc).isoformat()
    res = db.table("training_examples").update(updates).eq("id", example_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Example not found.")
    return res.data[0]


# ----------------------------------------------------------------------------
# COCO export
# ----------------------------------------------------------------------------

# COCO category IDs per task. Frozen here so models trained against this
# dataset stay compatible across exports.
COCO_CATEGORIES: dict[str, list[dict]] = {
    "roof_facet_polygon": [{"id": 1, "name": "roof_facet", "supercategory": "roof"}],
    "edge_classification": [
        {"id": 1, "name": "eave",              "supercategory": "edge"},
        {"id": 2, "name": "rake",              "supercategory": "edge"},
        {"id": 3, "name": "ridge",             "supercategory": "edge"},
        {"id": 4, "name": "hip",               "supercategory": "edge"},
        {"id": 5, "name": "valley",            "supercategory": "edge"},
        {"id": 6, "name": "gable_end",         "supercategory": "edge"},
        {"id": 7, "name": "wall_intersection", "supercategory": "edge"},
    ],
    "penetration_location": [
        {"id": 1, "name": "plumbing_vent",  "supercategory": "penetration"},
        {"id": 2, "name": "exhaust_vent",   "supercategory": "penetration"},
        {"id": 3, "name": "ridge_vent",     "supercategory": "penetration"},
        {"id": 4, "name": "box_vent",       "supercategory": "penetration"},
        {"id": 5, "name": "turbine_vent",   "supercategory": "penetration"},
        {"id": 6, "name": "chimney",        "supercategory": "penetration"},
        {"id": 7, "name": "skylight",       "supercategory": "penetration"},
        {"id": 8, "name": "satellite_dish", "supercategory": "penetration"},
        {"id": 9, "name": "solar_panel",    "supercategory": "penetration"},
        {"id": 10, "name": "hvac_unit",     "supercategory": "penetration"},
        {"id": 11, "name": "other",         "supercategory": "penetration"},
    ],
    "wall_polygon": [
        {"id": 1, "name": "vinyl",        "supercategory": "siding"},
        {"id": 2, "name": "fiber_cement", "supercategory": "siding"},
        {"id": 3, "name": "wood",         "supercategory": "siding"},
        {"id": 4, "name": "brick",        "supercategory": "siding"},
        {"id": 5, "name": "stone",        "supercategory": "siding"},
        {"id": 6, "name": "stucco",       "supercategory": "siding"},
        {"id": 7, "name": "metal",        "supercategory": "siding"},
        {"id": 8, "name": "other",        "supercategory": "siding"},
    ],
    "opening_rectangle": [
        {"id": 1, "name": "window", "supercategory": "opening"},
        {"id": 2, "name": "door",   "supercategory": "opening"},
    ],
    "roof_outline_polygon": [
        {"id": 1, "name": "building_outline", "supercategory": "building"},
    ],
}


def _polygon_to_coco_segmentation(polygon: list[list[float]], img_w: int, img_h: int, is_fraction: bool) -> tuple[list[float], list[float], float]:
    """
    Convert a polygon (either fraction 0..1 or pixel coords) to:
      - COCO segmentation array (flat [x1,y1,x2,y2,...] in pixel space)
      - COCO bbox [x, y, w, h]
      - area (pixel²)
    """
    pts: list[tuple[float, float]] = []
    for p in polygon:
        x = float(p[0])
        y = float(p[1])
        if is_fraction:
            x *= img_w
            y *= img_h
        pts.append((x, y))

    seg: list[float] = []
    for x, y in pts:
        seg.extend([round(x, 2), round(y, 2)])

    xs = [x for x, _ in pts]
    ys = [y for _, y in pts]
    bbox = [
        round(min(xs), 2),
        round(min(ys), 2),
        round(max(xs) - min(xs), 2),
        round(max(ys) - min(ys), 2),
    ]
    # Shoelace area in pixel²
    n = len(pts)
    s = 0.0
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    area = abs(s) / 2.0
    return seg, bbox, area


def _coco_category_id(task_type: str, annotation: dict) -> int:
    """Map an annotation to its COCO category id for the task."""
    if task_type == "roof_facet_polygon":
        return 1
    if task_type == "edge_classification":
        order = ("eave", "rake", "ridge", "hip", "valley", "gable_end", "wall_intersection")
        try:
            return order.index(annotation.get("edge_type") or "eave") + 1
        except ValueError:
            return 1
    if task_type == "penetration_location":
        order = ("plumbing_vent", "exhaust_vent", "ridge_vent", "box_vent", "turbine_vent",
                 "chimney", "skylight", "satellite_dish", "solar_panel", "hvac_unit", "other")
        try:
            return order.index(annotation.get("type") or "other") + 1
        except ValueError:
            return 11
    if task_type == "wall_polygon":
        order = ("vinyl", "fiber_cement", "wood", "brick", "stone", "stucco", "metal", "other")
        try:
            return order.index(annotation.get("material_type") or "other") + 1
        except ValueError:
            return 8
    if task_type == "opening_rectangle":
        return 1 if annotation.get("type") == "window" else 2
    if task_type == "roof_outline_polygon":
        return 1
    return 1


@router.get("/export")
async def export_coco(
    task_type: str = Query(..., description="Which task to export"),
    min_quality: Literal["unverified", "reviewed", "expert_verified"] = Query("reviewed"),
    limit: int = Query(10000, ge=1, le=50000),
    user: dict = Depends(require_user),
):
    """
    Emit a COCO-format JSON export ready for SAM2 fine-tuning (or any other
    polygon-segmentation framework). The output file follows the standard
    schema:
        {
          "info":     {"description": ..., "year": ..., "version": ...},
          "licenses": [],
          "images":   [{id, file_name, width, height, axis_image_url}, ...],
          "categories":  [{id, name, supercategory}, ...],
          "annotations": [{id, image_id, category_id, segmentation, bbox, area, iscrowd}, ...]
        }

    Default min_quality='reviewed' so models train on contractor-verified data
    only. Pass min_quality='unverified' to include everything (use cautiously
    — model may pick up labeler noise).
    """
    if task_type not in TASK_TYPES:
        raise HTTPException(status_code=422, detail="Unknown task_type.")

    db = get_supabase()
    q = db.table("training_examples").select("*").eq("task_type", task_type)
    tiers_allowed = {
        "unverified": ("unverified", "reviewed", "expert_verified"),
        "reviewed": ("reviewed", "expert_verified"),
        "expert_verified": ("expert_verified",),
    }[min_quality]
    q = q.in_("quality_tier", list(tiers_allowed))
    q = q.limit(limit)
    res = q.execute()
    rows = res.data or []

    from datetime import datetime, timezone

    images: list[dict] = []
    annotations: list[dict] = []
    seen_image_ids: dict[str, int] = {}   # photo_url -> coco image id

    for row in rows:
        img_url = row.get("image_url")
        if not img_url:
            continue
        if img_url not in seen_image_ids:
            seen_image_ids[img_url] = len(images) + 1
            images.append({
                "id": seen_image_ids[img_url],
                "file_name": img_url.split("/")[-1] or f"img_{seen_image_ids[img_url]}.jpg",
                "axis_image_url": img_url,            # non-standard but useful
                "width": int(row.get("image_width_px") or 2048),
                "height": int(row.get("image_height_px") or 1366),
            })
        image_id = seen_image_ids[img_url]
        img_w = int(row.get("image_width_px") or 2048)
        img_h = int(row.get("image_height_px") or 1366)

        ann = row.get("annotation") or {}
        # Pick the right polygon depending on task type
        polygon = None
        is_fraction = True
        if task_type == "roof_facet_polygon":
            polygon = ann.get("polygon")
        elif task_type == "edge_classification":
            # Encode edge as a degenerate polygon: the two endpoints of the edge.
            poly = ann.get("facet_polygon") or []
            i = int(ann.get("vertex_index_start") or 0)
            j = int(ann.get("vertex_index_end") or 0)
            if poly and 0 <= i < len(poly) and 0 <= j < len(poly):
                polygon = [poly[i], poly[j]]
        elif task_type == "penetration_location":
            x = float(ann.get("pos_x_frac") or 0)
            y = float(ann.get("pos_y_frac") or 0)
            # Express as a small 1% bounding box around the point
            polygon = [[x - 0.01, y - 0.01], [x + 0.01, y - 0.01],
                       [x + 0.01, y + 0.01], [x - 0.01, y + 0.01]]
        elif task_type == "wall_polygon":
            polygon = ann.get("polygon")
            is_fraction = False    # exterior measurements use pixel coords
        elif task_type == "opening_rectangle":
            rect = ann.get("rect") or []
            if len(rect) >= 2:
                x1, y1 = rect[0][0], rect[0][1]
                x2, y2 = rect[1][0], rect[1][1]
                polygon = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
            is_fraction = False
        elif task_type == "roof_outline_polygon":
            polygon = ann.get("polygon")

        if not polygon or len(polygon) < 2:
            continue

        try:
            seg, bbox, area = _polygon_to_coco_segmentation(polygon, img_w, img_h, is_fraction)
        except Exception:
            continue

        annotations.append({
            "id": len(annotations) + 1,
            "image_id": image_id,
            "category_id": _coco_category_id(task_type, ann),
            "segmentation": [seg],
            "bbox": bbox,
            "area": round(area, 2),
            "iscrowd": 0,
            "axis_example_id": row.get("id"),                      # non-standard but useful
            "axis_capture_source": row.get("capture_source"),
            "axis_quality_tier": row.get("quality_tier"),
        })

    coco: dict[str, Any] = {
        "info": {
            "description": f"Axis Performance training set — {task_type}",
            "version": "1.0",
            "year": datetime.now(timezone.utc).year,
            "contributor": "Axis Performance contractor network",
            "date_created": datetime.now(timezone.utc).isoformat(),
            "task_type": task_type,
            "min_quality_tier": min_quality,
            "example_count": len(annotations),
            "image_count": len(images),
        },
        "licenses": [{"id": 1, "name": "Axis Performance Proprietary", "url": ""}],
        "images": images,
        "categories": COCO_CATEGORIES.get(task_type, []),
        "annotations": annotations,
    }

    body = json.dumps(coco, separators=(",", ":")).encode("utf-8")
    filename = f"axis-training-{task_type}-{min_quality}.coco.json"
    return Response(
        content=body,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
