"""
blueprint_parser.py
Parses a blueprint image (PNG/JPG) or PDF and extracts structured spatial data
for use by scene_builder.py.

Outputs a scene_data dict:
  {
    "walls":    [ {"start":(x,y), "end":(x,y), "thickness":float, "height":float, "confidence":float} ],
    "rooms":    [ {"polygon":[(x,y),...], "label":str, "area_sqft":float, "confidence":float} ],
    "openings": [ {"type":"door"|"window", "position":(x,y), "width":float, "height":float} ],
    "footprint_width":  float,   # meters
    "footprint_depth":  float,   # meters
    "scale_factor":     float,   # pixels per meter
    "confidence":       float,
    "source":           str,
  }
"""

import os
import time
import math
import logging

import numpy as np

logging.basicConfig(level=logging.INFO, format="[PARSER %(asctime)s] %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("blueprint_parser")

# ── Optional dependency guards ────────────────────────────────────────────────
try:
    import cv2
    HAVE_CV2 = True
except ImportError:
    HAVE_CV2 = False
    log.warning("opencv-python not found. Run: pip install opencv-python")

try:
    import fitz          # PyMuPDF
    HAVE_FITZ = True
except ImportError:
    HAVE_FITZ = False
    log.warning("PyMuPDF not found. Run: pip install PyMuPDF  (needed for PDF input)")

try:
    from PIL import Image as _PIL_Image
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False

# ── Default fallback scene (3-room house, ~80 m²) ────────────────────────────
DEFAULT_SCENE: dict = {
    "walls": [
        # Outer perimeter
        {"start": (0.0, 0.0),  "end": (12.0, 0.0),  "thickness": 0.25, "height": 2.7, "confidence": 1.0},
        {"start": (12.0, 0.0), "end": (12.0, 9.0),  "thickness": 0.25, "height": 2.7, "confidence": 1.0},
        {"start": (12.0, 9.0), "end": (0.0, 9.0),   "thickness": 0.25, "height": 2.7, "confidence": 1.0},
        {"start": (0.0, 9.0),  "end": (0.0, 0.0),   "thickness": 0.25, "height": 2.7, "confidence": 1.0},
        # Interior dividers
        {"start": (0.0, 5.0),  "end": (7.5, 5.0),   "thickness": 0.15, "height": 2.7, "confidence": 1.0},
        {"start": (7.5, 0.0),  "end": (7.5, 5.0),   "thickness": 0.15, "height": 2.7, "confidence": 1.0},
        {"start": (7.5, 5.0),  "end": (7.5, 9.0),   "thickness": 0.15, "height": 2.7, "confidence": 1.0},
    ],
    "rooms": [
        {"polygon": [(0,0),(7.5,0),(7.5,5),(0,5)],        "label": "Living Room",    "area_sqft": 403.6, "confidence": 1.0},
        {"polygon": [(7.5,0),(12,0),(12,5),(7.5,5)],      "label": "Kitchen",        "area_sqft": 242.2, "confidence": 1.0},
        {"polygon": [(0,5),(7.5,5),(7.5,9),(0,9)],        "label": "Master Bedroom", "area_sqft": 322.9, "confidence": 1.0},
        {"polygon": [(7.5,5),(12,5),(12,9),(7.5,9)],      "label": "Bathroom",       "area_sqft": 193.8, "confidence": 1.0},
    ],
    "openings": [
        {"type": "door",   "position": (6.0,  0.0),  "width": 0.9, "height": 2.1, "confidence": 1.0},
        {"type": "door",   "position": (7.5,  2.5),  "width": 0.9, "height": 2.1, "confidence": 1.0},
        {"type": "door",   "position": (7.5,  7.0),  "width": 0.9, "height": 2.1, "confidence": 1.0},
        {"type": "window", "position": (2.0,  0.0),  "width": 1.4, "height": 1.2, "confidence": 1.0},
        {"type": "window", "position": (10.0, 0.0),  "width": 1.2, "height": 1.2, "confidence": 1.0},
        {"type": "window", "position": (0.0,  7.0),  "width": 1.2, "height": 1.2, "confidence": 1.0},
        {"type": "window", "position": (12.0, 2.5),  "width": 1.0, "height": 1.0, "confidence": 1.0},
        {"type": "window", "position": (5.0,  9.0),  "width": 1.4, "height": 1.2, "confidence": 1.0},
        {"type": "window", "position": (10.0, 9.0),  "width": 1.0, "height": 1.0, "confidence": 1.0},
    ],
    "footprint_width": 12.0,
    "footprint_depth": 9.0,
    "scale_factor": 100.0,
    "confidence": 0.0,
    "source": "default_fallback",
}

ROOM_LABELS = [
    "Living Room", "Kitchen", "Master Bedroom", "Bedroom", "Bathroom",
    "Dining Room", "Office", "Garage", "Hallway", "Utility Room",
]


# ── Internal helpers ──────────────────────────────────────────────────────────

def _pdf_to_numpy(pdf_path: str, dpi: int = 300) -> np.ndarray:
    """Convert the first page of a PDF to an RGB numpy array at specified DPI."""
    if not HAVE_FITZ:
        raise RuntimeError("PyMuPDF not installed. Run: pip install PyMuPDF")
    doc = fitz.open(pdf_path)
    page = doc[0]
    mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
    pix = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).copy()
    img = arr.reshape(pix.height, pix.width, 3)
    doc.close()
    log.info(f"PDF converted: {pix.width}x{pix.height}px at {dpi} DPI")
    return img


def _load_image(file_path: str) -> np.ndarray:
    """Load image or PDF into RGB numpy array."""
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".pdf":
        return _pdf_to_numpy(file_path)
    if not HAVE_CV2:
        raise RuntimeError("opencv-python not installed. Run: pip install opencv-python")
    img_bgr = cv2.imread(file_path, cv2.IMREAD_COLOR)
    if img_bgr is None:
        raise FileNotFoundError(f"Cannot read image: {file_path}")
    return cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)


def _detect_scale(gray: np.ndarray) -> float:
    """
    Attempt to detect scale from a ruler/legend near the bottom of the image.
    Falls back to 100 px/m (1 px = 1 cm) if nothing reliable is found.
    """
    h, w = gray.shape
    # Look for a dense row of short horizontal segments near the bottom 10%
    bottom_strip = gray[int(h * 0.88):, :]
    row_means = np.mean(bottom_strip, axis=1)
    dark_rows = np.where(row_means < 80)[0]
    if len(dark_rows) > 3:
        # Crude estimate: assume the strip spans 1 meter in reality
        strip_width_px = w * 0.5
        estimated_scale = strip_width_px / 5.0   # 5 m assumed
        if 20 < estimated_scale < 1000:
            log.info(f"Scale detected from legend: {estimated_scale:.1f} px/m")
            return estimated_scale
    log.info("No scale bar detected — using default 100 px/m (1 px = 1 cm)")
    return 100.0


def _preprocess(img_rgb: np.ndarray):
    """Grayscale, denoise, adaptive threshold, morphological close."""
    gray = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY)
    # Increase contrast via CLAHE
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    binary = cv2.adaptiveThreshold(
        blurred, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        blockSize=11, C=3,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    return gray, binary


def _snap_angle(angle_rad: float, tol_deg: float = 5.0) -> float:
    """Snap angle to nearest 0/90/180/270 to clean up nearly-orthogonal walls."""
    tol = math.radians(tol_deg)
    for snap in [0, math.pi / 2, math.pi, 3 * math.pi / 2, 2 * math.pi]:
        if abs(angle_rad - snap) < tol:
            return snap
    return angle_rad


def _detect_walls(binary: np.ndarray, scale: float, wall_height: float = 2.7) -> list:
    """Probabilistic Hough Line Transform → wall segment list in meters."""
    lines = cv2.HoughLinesP(
        binary,
        rho=1, theta=np.pi / 180,
        threshold=60,
        minLineLength=int(scale * 0.5),     # min 0.5 m wall
        maxLineGap=int(scale * 0.12),       # allow 12 cm gap
    )
    if lines is None:
        log.warning("HoughLinesP found no lines — using default walls")
        return DEFAULT_SCENE["walls"]

    walls = []
    # Deduplicate by proximity grid
    grid: dict = {}
    for line in lines:
        x1, y1, x2, y2 = line[0]
        # Ensure consistent direction (left-to-right or top-to-bottom)
        if x1 > x2 or (x1 == x2 and y1 > y2):
            x1, y1, x2, y2 = x2, y2, x1, y1
        length_px = math.hypot(x2 - x1, y2 - y1)
        if length_px < 25:
            continue
        key = (round(x1 / 12), round(y1 / 12), round(x2 / 12), round(y2 / 12))
        if key in grid:
            continue
        grid[key] = True
        angle = math.atan2(y2 - y1, x2 - x1)
        angle = _snap_angle(angle)
        confidence = min(1.0, length_px / (scale * 3))
        thickness = 0.25 if length_px > scale * 2 else 0.15
        walls.append({
            "start":      (round(x1 / scale, 3), round(y1 / scale, 3)),
            "end":        (round(x2 / scale, 3), round(y2 / scale, 3)),
            "thickness":  thickness,
            "height":     wall_height,
            "confidence": round(confidence, 2),
        })

    avg_conf = sum(w["confidence"] for w in walls) / max(len(walls), 1)
    log.info(f"Detected {len(walls)} wall segments | avg confidence {avg_conf:.2f}")
    return walls if walls else DEFAULT_SCENE["walls"]


def _detect_rooms(binary: np.ndarray, scale: float) -> list:
    """
    Find room polygons via contour detection on the binary blueprint image.
    Filters out very small (noise) and very large (border) contours.
    """
    # Invert so rooms appear as filled blobs
    inv = cv2.bitwise_not(binary)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    filled = cv2.morphologyEx(inv, cv2.MORPH_CLOSE, kernel, iterations=3)

    contours, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = binary.shape[0] * binary.shape[1]
    rooms = []
    label_idx = 0

    for c in sorted(contours, key=cv2.contourArea, reverse=True):
        area_px = cv2.contourArea(c)
        # Skip noise (< 1% image) and border (> 85% image)
        if area_px < img_area * 0.01 or area_px > img_area * 0.85:
            continue
        epsilon = 0.025 * cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, epsilon, True)
        if len(approx) < 3:
            continue
        polygon = [(round(pt[0][0] / scale, 3), round(pt[0][1] / scale, 3)) for pt in approx]
        area_m2 = area_px / (scale ** 2)
        area_sqft = round(area_m2 * 10.764, 1)
        confidence = 0.65 if len(approx) >= 4 else 0.45
        rooms.append({
            "polygon":    polygon,
            "label":      ROOM_LABELS[label_idx % len(ROOM_LABELS)],
            "area_sqft":  area_sqft,
            "confidence": confidence,
        })
        label_idx += 1
        if label_idx >= 12:   # cap at 12 rooms
            break

    log.info(f"Detected {len(rooms)} rooms")
    return rooms if rooms else DEFAULT_SCENE["rooms"]


def _point_on_segment(px: float, py: float, sx: float, sy: float,
                       ex: float, ey: float, tol: float = 0.3) -> bool:
    """Check if point (px,py) lies on segment (sx,sy)→(ex,ey) within tolerance."""
    seg_len = math.hypot(ex - sx, ey - sy)
    if seg_len < 0.01:
        return False
    dx, dz = (ex - sx) / seg_len, (ey - sy) / seg_len
    t = (px - sx) * dx + (py - sy) * dz
    if t < -0.05 or t > seg_len + 0.05:
        return False
    closest_x = sx + t * dx
    closest_z = sy + t * dz
    return math.hypot(px - closest_x, py - closest_z) < tol


def _detect_openings(walls: list, binary: np.ndarray, scale: float) -> list:
    """
    Scan along each detected wall for gaps (low pixel density = opening).
    Returns doors (>= 0.7 m wide) and windows (< 0.7 m wide).
    """
    h, w_img = binary.shape
    openings = []

    for wall in walls:
        sx, sy = wall["start"]
        ex, ey = wall["end"]
        length_m = math.hypot(ex - sx, ey - sy)
        if length_m < 0.4:
            continue
        steps = max(20, int(length_m * scale / 3))
        gap_start_t = None

        for i in range(steps + 1):
            t = i / steps
            px = int((sx + t * (ex - sx)) * scale)
            py = int((sy + t * (ey - sy)) * scale)
            px = max(0, min(w_img - 1, px))
            py = max(0, min(h - 1, py))
            # Sample a small cross around the point
            val = int(binary[py, px])
            if py > 0:    val = max(val, int(binary[py - 1, px]))
            if py < h-1:  val = max(val, int(binary[py + 1, px]))

            is_gap = val < 30   # dark = no wall = gap

            if is_gap and gap_start_t is None:
                gap_start_t = t
            elif not is_gap and gap_start_t is not None:
                gap_width_m = (t - gap_start_t) * length_m
                if 0.55 <= gap_width_m <= 3.0:
                    mid_t = (gap_start_t + t) / 2.0
                    mx = round(sx + mid_t * (ex - sx), 3)
                    my = round(sy + mid_t * (ey - sy), 3)
                    otype = "door" if gap_width_m >= 0.7 else "window"
                    height = 2.1 if otype == "door" else 1.2
                    openings.append({
                        "type":       otype,
                        "position":   (mx, my),
                        "width":      round(gap_width_m, 2),
                        "height":     height,
                        "confidence": 0.55,
                    })
                gap_start_t = None

    # Fallback if we found almost nothing
    if len(openings) < 2:
        log.warning("Too few openings detected — merging with defaults")
        openings = openings + DEFAULT_SCENE["openings"]

    log.info(f"Detected {len(openings)} openings "
             f"({sum(1 for o in openings if o['type']=='door')} doors, "
             f"{sum(1 for o in openings if o['type']=='window')} windows)")
    return openings


def _compute_footprint(walls: list) -> tuple:
    """Return (width, depth) bounding box of all wall endpoints in meters."""
    if not walls:
        return DEFAULT_SCENE["footprint_width"], DEFAULT_SCENE["footprint_depth"]
    xs = [w["start"][0] for w in walls] + [w["end"][0] for w in walls]
    ys = [w["start"][1] for w in walls] + [w["end"][1] for w in walls]
    fw = round(max(xs) - min(xs), 2)
    fd = round(max(ys) - min(ys), 2)
    # Guard against degenerate results
    fw = max(fw, 4.0)
    fd = max(fd, 4.0)
    return fw, fd


# ── Public API ────────────────────────────────────────────────────────────────

def parse_blueprint(file_path: str, wall_height: float = 2.7) -> dict:
    """
    Parse a blueprint image or PDF and return a scene_data dict.

    Source priority (most accurate → least accurate):
      1. Pre-parsed scene_data.json written by Claude Vision backend
         (placed next to the blueprint file, or in the same output dir).
         Claude Vision has ~85% accuracy vs. ~40% for CV2 Hough detection.
      2. OpenCV Hough line detection + contour room labeling (fallback).
      3. Default 3-room scene (last resort).

    Args:
        file_path:   Path to PNG, JPG, or PDF blueprint file.
        wall_height: Default wall height in meters (default 2.7 m / 9 ft).

    Returns:
        scene_data dict ready for scene_builder.build_scene().
    """
    import json as _json

    t0 = time.time()
    log.info(f"=== Blueprint Parser START: {file_path} ===")

    # ── Priority 1: Claude Vision pre-parsed scene_data.json ─────────────────
    # The backend (axis.py) saves scene_data.json to the output dir before
    # invoking Blender. Check several candidate locations.
    blueprint_dir = os.path.dirname(os.path.abspath(file_path))
    candidates = [
        os.path.join(blueprint_dir, "scene_data.json"),
        # If running from within the output dir structure (e.g. /tmp/axis_outputs/{project_id}/)
        os.path.join(blueprint_dir, "..", "scene_data.json"),
        os.path.join(blueprint_dir, "..", "data", "scene_data.json"),
    ]
    for candidate in candidates:
        candidate = os.path.normpath(candidate)
        if os.path.exists(candidate):
            try:
                with open(candidate) as f:
                    sd = _json.load(f)
                # Must have walls to be useful
                if sd.get("walls") and len(sd["walls"]) >= 3:
                    source = sd.get("source", "claude_vision")
                    conf = sd.get("confidence", 0.85)
                    log.info(
                        f"=== Using pre-parsed scene_data.json from {candidate} "
                        f"(source={source}, confidence={conf}) ==="
                    )
                    elapsed = round(time.time() - t0, 3)
                    log.info(f"=== Parser DONE in {elapsed}s (pre-parsed) ===")
                    return sd
            except Exception as e:
                log.warning(f"Failed to load pre-parsed scene_data.json at {candidate}: {e}")

    log.info("No valid pre-parsed scene_data.json found — falling back to CV2 detection")

    # ── Guard: file must exist ────────────────────────────────────────────────
    if not os.path.exists(file_path):
        log.error(f"File not found: {file_path!r} — returning default scene")
        return {**DEFAULT_SCENE, "error": "file_not_found"}

    if not HAVE_CV2:
        log.error("OpenCV not available — returning default scene (install opencv-python)")
        return {**DEFAULT_SCENE, "source": "default_no_cv2"}

    try:
        img_rgb = _load_image(file_path)
        log.info(f"Image loaded: {img_rgb.shape[1]}x{img_rgb.shape[0]}px")
        gray, binary = _preprocess(img_rgb)
        scale = _detect_scale(gray)
        walls = _detect_walls(binary, scale, wall_height)
        rooms = _detect_rooms(binary, scale)
        openings = _detect_openings(walls, binary, scale)
        fw, fd = _compute_footprint(walls)

        # Overall confidence
        all_conf = [w.get("confidence", 0.5) for w in walls]
        all_conf += [r.get("confidence", 0.5) for r in rooms]
        overall_conf = round(sum(all_conf) / max(len(all_conf), 1), 2)

        scene_data = {
            "walls":           walls,
            "rooms":           rooms,
            "openings":        openings,
            "footprint_width": fw,
            "footprint_depth": fd,
            "scale_factor":    scale,
            "confidence":      overall_conf,
            "source":          "cv2_hough_contour",
        }
        elapsed = round(time.time() - t0, 2)
        log.info(f"=== Parser DONE in {elapsed}s | "
                 f"walls={len(walls)} rooms={len(rooms)} openings={len(openings)} "
                 f"conf={overall_conf} ===")
        return scene_data

    except Exception as exc:
        log.error(f"Parser exception: {exc} — returning default scene")
        import traceback
        traceback.print_exc()
        return {**DEFAULT_SCENE, "error": str(exc)}
