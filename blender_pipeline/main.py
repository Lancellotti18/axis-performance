from __future__ import annotations
"""
main.py — AXIS PERFORMANCE Master Orchestrator
================================================
Runs the full pipeline:

  3D PIPELINE (inside Blender, Steps 1–5):
    1. Parse blueprint → scene_data
    2. Build 3D scene in Blender
    3. Apply PBR materials
    4. Configure lighting + cameras
    5. Render at 4K + export GLB/FBX

  5D PIPELINE (standard Python, Steps 6–11):
    6. Quantity takeoff
    7. Cost estimation (3 scenarios)
    8. Construction schedule + Gantt
    9. AI insights (Claude API)
   10. 12-page PDF report
   11. Launch interactive Dash dashboard

Run headless (no Blender GUI):
  blender --background --python main.py -- blueprint.pdf ./output production

Arguments (after --):
  1. blueprint_path   (default: blueprint.pdf)
  2. output_dir       (default: ./output)
  3. quality          (default: production)    preview | production | ultra
  4. roof_type        (default: gable)         gable | hip | flat | shed
  5. time_of_day      (default: golden_hour)   morning | midday | golden_hour | dusk
  6. wall_material    (default: stucco)        stucco | brick | concrete
  7. roof_material    (default: asphalt)       asphalt | metal | clay
  8. run_5d           (default: true)          true | false
  9. project_name     (default: Project)
 10. start_date       (default: today, ISO format)

Example:
  blender --background --python main.py -- house.pdf ./output production gable golden_hour stucco asphalt true "My House"
"""

import sys
import os
import json
import time
import logging

_pipeline_dir = os.path.dirname(os.path.abspath(__file__))
if _pipeline_dir not in sys.path:
    sys.path.insert(0, _pipeline_dir)

logging.basicConfig(
    level=logging.INFO,
    format="[AXIS %(asctime)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("axis_pipeline")


# ── Arg parsing ───────────────────────────────────────────────────────────────
def _get_args() -> dict:
    argv = sys.argv
    try:
        idx       = argv.index("--")
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
        "run_5d":         "true",
        "project_name":   "Project",
        "start_date":     "",
    }
    keys = list(defaults.keys())
    for i, val in enumerate(user_args):
        if i < len(keys):
            defaults[keys[i]] = val
    return defaults


# ── 3D PIPELINE (Blender-internal) ────────────────────────────────────────────
def run_3d_pipeline(
    blueprint_path: str,
    output_dir:     str,
    quality:        str   = "production",
    roof_type:      str   = "gable",
    time_of_day:    str   = "golden_hour",
    wall_material:  str   = "stucco",
    roof_material:  str   = "asphalt",
    hdri_path:      str   = "",
    wall_height:    float = 2.7,
    pitch_deg:      float = 35.0,
    resolution:     tuple = (3840, 2160),
    file_format:    str   = "PNG",
    export_3d:      bool  = True,
) -> dict:
    """Runs the Blender 3D render pipeline and returns scene_data."""
    os.makedirs(output_dir, exist_ok=True)

    log.info("=" * 60)
    log.info("  AXIS PERFORMANCE — 3D Pipeline")
    log.info("=" * 60)

    # Step 1 — Parse
    log.info("[1/5] Parsing blueprint...")
    t = time.time()
    from blueprint_parser import parse_blueprint
    scene_data = parse_blueprint(blueprint_path, wall_height=wall_height)
    log.info(
        f"[1/5] DONE in {time.time()-t:.2f}s — "
        f"{len(scene_data['walls'])} walls, {len(scene_data['rooms'])} rooms, "
        f"{len(scene_data['openings'])} openings"
    )

    # Save scene_data for 5D pipeline
    data_dir = os.path.join(output_dir, "data")
    os.makedirs(data_dir, exist_ok=True)
    scene_data_path = os.path.join(data_dir, "scene_data.json")
    with open(scene_data_path, "w") as f:
        json.dump(scene_data, f, indent=2)

    # Step 2 — Scene
    log.info("[2/5] Building 3D scene...")
    t = time.time()
    from scene_builder import build_scene
    build_scene(scene_data, wall_height=wall_height, roof_type=roof_type, pitch_deg=pitch_deg)
    log.info(f"[2/5] DONE in {time.time()-t:.2f}s")

    # Step 3 — Materials
    log.info("[3/5] Applying PBR materials...")
    t = time.time()
    from materials_engine import apply_materials
    apply_materials(scene_data, wall_material=wall_material, roof_material=roof_material)
    log.info(f"[3/5] DONE in {time.time()-t:.2f}s")

    # Step 4 — Lighting + cameras
    log.info("[4/5] Configuring lighting and cameras...")
    t = time.time()
    from lighting_camera import setup_lighting_and_cameras
    cameras = setup_lighting_and_cameras(
        scene_data, time_of_day=time_of_day, hdri_path=hdri_path, wall_height=wall_height
    )
    log.info(f"[4/5] DONE in {time.time()-t:.2f}s — {len(cameras)} cameras")

    # Step 5 — Render
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

    return scene_data


# ── 5D PIPELINE (standard Python) ────────────────────────────────────────────
def run_5d_pipeline(
    scene_data:   dict,
    output_dir:   str,
    project_name: str          = "Project",
    start_date:   str | None   = None,
    pitch_deg:    float        = 35.0,
    generate_pdf: bool         = True,
    launch_dash:  bool         = True,
    dash_port:    int          = 8050,
) -> dict:
    """
    Runs quantity takeoff → cost engine → scheduler → AI insights → PDF → Dashboard.
    Returns a summary dict.
    """
    log.info("=" * 60)
    log.info("  AXIS PERFORMANCE — 5D Pipeline")
    log.info("=" * 60)

    results = {}

    # Step 6 — Quantity takeoff
    log.info("[6/10] Calculating quantities...")
    t = time.time()
    from quantity_takeoff import run_quantity_takeoff
    quantities = run_quantity_takeoff(scene_data, output_dir, pitch_angle=pitch_deg)
    results["quantities"] = quantities
    log.info(f"[6/10] DONE in {time.time()-t:.2f}s")

    # Step 7 — Cost engine
    log.info("[7/10] Estimating costs (3 scenarios)...")
    t = time.time()
    from cost_engine import run_cost_engine
    cost_report = run_cost_engine(quantities, output_dir)
    results["cost_report"] = cost_report
    log.info(f"[7/10] DONE in {time.time()-t:.2f}s")

    # Step 8 — Scheduler
    log.info("[8/10] Building construction schedule...")
    t = time.time()
    from construction_scheduler import run_scheduler
    schedule = run_scheduler(quantities, output_dir, scene_data=scene_data,
                              start_date=start_date if start_date else None)
    results["schedule"] = schedule
    log.info(f"[8/10] DONE in {time.time()-t:.2f}s — "
             f"{schedule['total_calendar_days']} days / "
             f"{schedule['total_labor_hours']:,.0f} hrs")

    # Step 9 — AI insights
    log.info("[9/10] Generating AI insights...")
    t = time.time()
    from ai_insights import run_ai_insights
    insights = run_ai_insights(quantities, cost_report, schedule,
                                output_dir, project_name=project_name)
    results["insights"] = insights
    log.info(f"[9/10] DONE in {time.time()-t:.2f}s")

    # Step 10 — PDF report
    if generate_pdf:
        log.info("[10/10] Generating PDF report...")
        t = time.time()
        from report_generator import generate_report
        pdf_path = generate_report(
            quantities=quantities,
            cost_report=cost_report,
            schedule=schedule,
            insights=insights,
            output_dir=output_dir,
            project_name=project_name,
        )
        results["pdf_path"] = pdf_path
        log.info(f"[10/10] PDF done in {time.time()-t:.2f}s → {pdf_path}")
    else:
        log.info("[10/10] PDF skipped")

    # Step 11 — Dashboard (non-blocking background thread)
    if launch_dash:
        log.info("[11] Launching interactive dashboard...")
        import threading
        from interactive_dashboard import launch_dashboard
        dash_thread = threading.Thread(
            target=launch_dashboard,
            args=(output_dir,),
            kwargs={"port": dash_port, "open_browser": True},
            daemon=True,
        )
        dash_thread.start()
        results["dashboard_url"] = f"http://127.0.0.1:{dash_port}"
        log.info(f"[11] Dashboard: http://127.0.0.1:{dash_port}")

    # Write a results summary JSON for the backend to read
    summary = {
        "project_name":   project_name,
        "area_sqft":      quantities["meta"]["area_sqft"],
        "standard_total": cost_report["summary"]["standard_total"],
        "economy_total":  cost_report["summary"]["economy_total"],
        "premium_total":  cost_report["summary"]["premium_total"],
        "standard_psf":   cost_report["summary"]["standard_per_sqft"],
        "calendar_days":  schedule["total_calendar_days"],
        "working_days":   schedule["total_working_days"],
        "labor_hours":    schedule["total_labor_hours"],
        "pdf_path":       results.get("pdf_path", ""),
        "dashboard_url":  results.get("dashboard_url", ""),
        "renders": {
            "exterior_hero":        "renders/exterior_hero.png",
            "aerial_45":            "renders/aerial_45.png",
            "street_level":         "renders/street_level.png",
            "interior_walkthrough": "renders/interior_walkthrough.png",
        },
    }

    summary_path = os.path.join(output_dir, "data", "axis_summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    return results


# ── Full pipeline ─────────────────────────────────────────────────────────────
def run_full_pipeline(
    blueprint_path: str,
    output_dir:     str,
    quality:        str   = "production",
    roof_type:      str   = "gable",
    time_of_day:    str   = "golden_hour",
    wall_material:  str   = "stucco",
    roof_material:  str   = "asphalt",
    run_5d:         bool  = True,
    project_name:   str   = "Project",
    start_date:     str   = "",
    wall_height:    float = 2.7,
    pitch_deg:      float = 35.0,
    resolution:     tuple = (3840, 2160),
    export_3d:      bool  = True,
    generate_pdf:   bool  = True,
    launch_dash:    bool  = False,   # default off in headless mode
) -> None:
    global_t0 = time.time()

    log.info("=" * 60)
    log.info("  AXIS PERFORMANCE — Full Pipeline (3D + 5D)")
    log.info(f"  Blueprint   : {blueprint_path}")
    log.info(f"  Output      : {output_dir}")
    log.info(f"  Quality     : {quality}")
    log.info(f"  Roof        : {roof_type} / {roof_material}")
    log.info(f"  Walls       : {wall_material}")
    log.info(f"  Time of day : {time_of_day}")
    log.info(f"  5D Pipeline : {'enabled' if run_5d else 'disabled'}")
    log.info("=" * 60)

    for folder in ["renders", "data", "exports", "reports"]:
        os.makedirs(os.path.join(output_dir, folder), exist_ok=True)

    # 3D
    scene_data = run_3d_pipeline(
        blueprint_path=blueprint_path,
        output_dir=output_dir,
        quality=quality,
        roof_type=roof_type,
        time_of_day=time_of_day,
        wall_material=wall_material,
        roof_material=roof_material,
        wall_height=wall_height,
        pitch_deg=pitch_deg,
        resolution=resolution,
        export_3d=export_3d,
    )

    # 5D
    if run_5d:
        run_5d_pipeline(
            scene_data=scene_data,
            output_dir=output_dir,
            project_name=project_name,
            start_date=start_date or None,
            pitch_deg=pitch_deg,
            generate_pdf=generate_pdf,
            launch_dash=launch_dash,
        )

    total = round(time.time() - global_t0, 1)
    log.info("=" * 60)
    log.info(f"  AXIS COMPLETE in {total}s ({total/60:.1f} min)")
    log.info(f"  Renders   : {os.path.abspath(os.path.join(output_dir, 'renders'))}")
    log.info(f"  Reports   : {os.path.abspath(os.path.join(output_dir, 'reports'))}")
    log.info(f"  Data      : {os.path.abspath(os.path.join(output_dir, 'data'))}")
    log.info("=" * 60)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    args = _get_args()
    run_full_pipeline(
        blueprint_path = args["blueprint_path"],
        output_dir     = args["output_dir"],
        quality        = args["quality"],
        roof_type      = args["roof_type"],
        time_of_day    = args["time_of_day"],
        wall_material  = args["wall_material"],
        roof_material  = args["roof_material"],
        run_5d         = args["run_5d"].lower() != "false",
        project_name   = args["project_name"],
        start_date     = args["start_date"],
    )
