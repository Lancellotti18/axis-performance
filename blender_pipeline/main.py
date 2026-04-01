"""
main.py — AXIS Photorealistic Rendering Pipeline
================================================
Orchestrates: blueprint parse → 3D scene build → PBR materials →
              lighting/cameras → Cycles render → GLB/FBX export

Run headless (no Blender GUI):
  blender --background --python main.py -- blueprint.pdf ./output production

  Arguments (after --):
    1. blueprint_path   (default: blueprint.pdf)
    2. output_dir       (default: ./output)
    3. quality          (default: production)  preview | production | ultra
    4. roof_type        (default: gable)        gable | hip | flat | shed
    5. time_of_day      (default: golden_hour)  morning | midday | golden_hour | dusk
    6. wall_material    (default: stucco)        stucco | brick | concrete
    7. roof_material    (default: asphalt)       asphalt | metal | clay

Example — brick exterior, metal roof, midday sun, ultra quality:
  blender --background --python main.py -- house.png ./renders ultra hip midday brick metal
"""

import sys
import os
import time
import logging

logging.basicConfig(
    level=logging.INFO,
    format="[AXIS %(asctime)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("axis_pipeline")

# ── Parse args passed after the "--" separator ────────────────────────────────
def _get_args() -> dict:
    """Extract user arguments from sys.argv after '--'."""
    argv = sys.argv
    separator = "--"
    try:
        idx = argv.index(separator)
        user_args = argv[idx + 1:]
    except ValueError:
        user_args = []

    defaults = {
        "blueprint_path": "blueprint.pdf",
        "output_dir":     "./output",
        "quality":        "production",
        "roof_type":      "gable",
        "time_of_day":    "golden_hour",
        "wall_material":  "stucco",
        "roof_material":  "asphalt",
    }
    keys = list(defaults.keys())
    for i, val in enumerate(user_args):
        if i < len(keys):
            defaults[keys[i]] = val
    return defaults


# ── Pipeline ──────────────────────────────────────────────────────────────────

def run_pipeline(
    blueprint_path: str,
    output_dir:     str,
    quality:        str  = "production",
    roof_type:      str  = "gable",
    time_of_day:    str  = "golden_hour",
    wall_material:  str  = "stucco",
    roof_material:  str  = "asphalt",
    hdri_path:      str  = "",
    wall_height:    float = 2.7,
    pitch_deg:      float = 35.0,
    resolution:     tuple = (3840, 2160),
    file_format:    str  = "PNG",
    export_3d:      bool = True,
) -> None:
    """Full AXIS render pipeline."""
    global_t0 = time.time()

    log.info("=" * 60)
    log.info("  AXIS PHOTOREALISTIC RENDERING PIPELINE")
    log.info("=" * 60)
    log.info(f"  Blueprint   : {blueprint_path}")
    log.info(f"  Output dir  : {output_dir}")
    log.info(f"  Quality     : {quality}")
    log.info(f"  Roof type   : {roof_type}")
    log.info(f"  Time of day : {time_of_day}")
    log.info(f"  Wall mat    : {wall_material}")
    log.info(f"  Roof mat    : {roof_material}")
    log.info(f"  Resolution  : {resolution[0]}x{resolution[1]}")
    log.info("=" * 60)

    os.makedirs(output_dir, exist_ok=True)

    # ─────────────────────────────────────────────────────────────────────────
    # STEP 1 — Parse blueprint
    # ─────────────────────────────────────────────────────────────────────────
    log.info("[1/5] Parsing blueprint...")
    t = time.time()
    from blueprint_parser import parse_blueprint
    scene_data = parse_blueprint(blueprint_path, wall_height=wall_height)
    log.info(
        f"[1/5] DONE in {time.time()-t:.2f}s — "
        f"{len(scene_data['walls'])} walls, "
        f"{len(scene_data['rooms'])} rooms, "
        f"{len(scene_data['openings'])} openings, "
        f"confidence={scene_data.get('confidence', 0):.2f}, "
        f"source={scene_data.get('source','?')}"
    )

    # ─────────────────────────────────────────────────────────────────────────
    # STEP 2 — Build 3D scene
    # ─────────────────────────────────────────────────────────────────────────
    log.info("[2/5] Building 3D scene...")
    t = time.time()
    from scene_builder import build_scene
    build_scene(
        scene_data,
        wall_height=wall_height,
        roof_type=roof_type,
        pitch_deg=pitch_deg,
    )
    log.info(f"[2/5] DONE in {time.time()-t:.2f}s")

    # ─────────────────────────────────────────────────────────────────────────
    # STEP 3 — Apply PBR materials
    # ─────────────────────────────────────────────────────────────────────────
    log.info("[3/5] Applying PBR materials...")
    t = time.time()
    from materials_engine import apply_materials
    apply_materials(
        scene_data,
        wall_material=wall_material,
        roof_material=roof_material,
    )
    log.info(f"[3/5] DONE in {time.time()-t:.2f}s")

    # ─────────────────────────────────────────────────────────────────────────
    # STEP 4 — Lighting and cameras
    # ─────────────────────────────────────────────────────────────────────────
    log.info("[4/5] Configuring lighting and cameras...")
    t = time.time()
    from lighting_camera import setup_lighting_and_cameras
    cameras = setup_lighting_and_cameras(
        scene_data,
        time_of_day=time_of_day,
        hdri_path=hdri_path,
        wall_height=wall_height,
    )
    log.info(f"[4/5] DONE in {time.time()-t:.2f}s — {len(cameras)} cameras ready")

    # ─────────────────────────────────────────────────────────────────────────
    # STEP 5 — Render
    # ─────────────────────────────────────────────────────────────────────────
    log.info("[5/5] Rendering all cameras...")
    t = time.time()
    from render_engine import configure_and_render
    configure_and_render(
        cameras=cameras,
        output_dir=output_dir,
        quality=quality,
        resolution=resolution,
        file_format=file_format,
        export_3d=export_3d,
    )
    log.info(f"[5/5] DONE in {time.time()-t:.2f}s")

    # ─────────────────────────────────────────────────────────────────────────
    total = round(time.time() - global_t0, 1)
    log.info("=" * 60)
    log.info(f"  PIPELINE COMPLETE in {total}s ({total/60:.1f} min)")
    log.info(f"  Renders: {os.path.abspath(os.path.join(output_dir, 'renders'))}")
    log.info(f"  Exports: {os.path.abspath(os.path.join(output_dir, 'exports'))}")
    log.info("=" * 60)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    args = _get_args()
    run_pipeline(
        blueprint_path = args["blueprint_path"],
        output_dir     = args["output_dir"],
        quality        = args["quality"],
        roof_type      = args["roof_type"],
        time_of_day    = args["time_of_day"],
        wall_material  = args["wall_material"],
        roof_material  = args["roof_material"],
    )
