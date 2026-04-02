"""
render_engine.py
Configures Blender Cycles for maximum photorealism and renders all cameras
to an organized output folder. Exports GLB and FBX for downstream use.

Quality levels:
  "preview"    → 128 samples  (fast client preview)
  "production" → 512 samples  (deliverable quality)
  "ultra"      → 1024 samples (print / 4K presentation)
"""

import os
import time
import logging

log = logging.getLogger("render_engine")
logging.basicConfig(level=logging.INFO, format="[RENDER %(asctime)s] %(message)s",
                    datefmt="%H:%M:%S")

import bpy


# ── GPU detection ─────────────────────────────────────────────────────────────

def _configure_gpu() -> str:
    """Detect and enable GPU compute for Cycles. Returns device description."""
    prefs = bpy.context.preferences
    cycles_prefs = prefs.addons.get("cycles")
    if not cycles_prefs:
        log.warning("Cycles addon not found — CPU only")
        return "cpu"

    cp = cycles_prefs.preferences
    # Try CUDA (NVIDIA) → OptiX → Metal (Apple) → OpenCL (AMD) → CPU
    for device_type in ("OPTIX", "CUDA", "METAL", "HIP", "ONEAPI", "OPENCL"):
        try:
            cp.compute_device_type = device_type
            # Refresh device list
            cp.get_devices()
            active_gpus = [d for d in cp.devices if d.type != "CPU"]
            if active_gpus:
                for d in cp.devices:
                    d.use = True   # enable all available devices
                bpy.context.scene.cycles.device = "GPU"
                gpu_names = ", ".join(d.name for d in active_gpus if d.use)
                log.info(f"GPU enabled [{device_type}]: {gpu_names}")
                return f"gpu_{device_type.lower()}"
        except Exception:
            continue

    # Fallback to CPU
    bpy.context.scene.cycles.device = "CPU"
    log.info("No GPU found — rendering on CPU")
    return "cpu"


# ── Cycles engine configuration ───────────────────────────────────────────────

QUALITY_SAMPLES = {
    "preview":    128,
    "production": 512,
    "ultra":     1024,
}

def _configure_cycles(quality: str = "production") -> None:
    """Set all Cycles render settings for photorealism."""
    scene = bpy.context.scene
    rd    = scene.render
    cy    = scene.cycles

    # Engine
    rd.engine = "CYCLES"
    samples   = QUALITY_SAMPLES.get(quality, 512)
    cy.samples          = samples
    cy.preview_samples  = 32
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold    = 0.01   # stop when noise < 1%
    cy.adaptive_min_samples  = max(32, samples // 8)
    log.info(f"Cycles: {samples} samples, adaptive threshold 0.01")

    # Light paths
    cy.max_bounces              = 12
    cy.diffuse_bounces          = 4
    cy.glossy_bounces           = 4
    cy.transmission_bounces     = 12
    cy.volume_bounces           = 0
    cy.transparent_max_bounces  = 8
    cy.caustics_reflective      = False   # disable for speed (rarely needed)
    cy.caustics_refractive      = False

    # Denoising
    cy.use_denoising = True
    # Try OptiX denoiser (NVIDIA) first, fall back to OpenImageDenoise
    for denoiser in ("OPTIX", "OPENIMAGEDENOISE"):
        try:
            cy.denoiser = denoiser
            break
        except Exception:
            continue
    try: cy.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    except Exception: pass
    try: cy.denoising_prefilter = "ACCURATE"
    except Exception: pass
    log.info(f"Denoiser: {cy.denoiser}")

    # Film
    cy.film_exposure            = 1.0
    rd.film_transparent         = False
    cy.pixel_filter_type        = "BLACKMAN_HARRIS"
    cy.filter_width             = 1.5

    # Color management — Filmic is critical for photorealism
    scene.view_settings.view_transform  = "Filmic"
    scene.view_settings.look            = "Medium High Contrast"
    scene.view_settings.gamma           = 1.0
    scene.view_settings.exposure        = 0.0
    scene.sequencer_colorspace_settings.name = "sRGB"
    log.info("Color: Filmic + Medium High Contrast")

    # Performance
    rd.threads_mode = "AUTO"
    try:
        cy.tile_size = 2048   # optimal for GPU
    except AttributeError:
        pass   # Blender 3.0+ removed manual tile size (auto-tiling)


# ── Output settings ───────────────────────────────────────────────────────────

def _set_output(filepath: str, file_format: str = "PNG",
                resolution: tuple = (3840, 2160)) -> None:
    """Configure render output path and format."""
    rd = bpy.context.scene.render
    rd.filepath            = filepath
    rd.image_settings.file_format  = file_format
    rd.resolution_x        = resolution[0]
    rd.resolution_y        = resolution[1]
    rd.resolution_percentage = 100

    if file_format == "PNG":
        rd.image_settings.color_mode        = "RGBA"
        rd.image_settings.color_depth       = "16"
        rd.image_settings.compression       = 15
    elif file_format == "JPEG":
        rd.image_settings.color_mode        = "RGB"
        rd.image_settings.quality           = 95
    log.info(f"Output: {filepath} | {file_format} | {resolution[0]}x{resolution[1]}")


# ── Render loop ───────────────────────────────────────────────────────────────

def _render_camera(cam_obj: bpy.types.Object, filepath: str,
                   resolution: tuple, file_format: str) -> float:
    """Set active camera, configure output, render, return elapsed seconds."""
    bpy.context.scene.camera = cam_obj
    _set_output(filepath, file_format, resolution)
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    elapsed = round(time.time() - t0, 2)
    log.info(f"  Rendered {os.path.basename(filepath)} in {elapsed}s")
    return elapsed


# ── 3D Export ─────────────────────────────────────────────────────────────────

def _export_glb(output_dir: str) -> None:
    """Export full scene as GLB (GLTF 2.0) for web viewer compatibility."""
    out_path = os.path.join(output_dir, "exports", "scene.glb")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_apply=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_texcoords=True,
        export_normals=True,
        export_draco_mesh_compression_enable=False,
    )
    log.info(f"GLB exported: {out_path}")


def _export_fbx(output_dir: str) -> None:
    """Export full scene as FBX for Unreal/Unity/etc."""
    out_path = os.path.join(output_dir, "exports", "scene.fbx")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    bpy.ops.export_scene.fbx(
        filepath=out_path,
        use_selection=False,
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_NONE",
        bake_space_transform=False,
        mesh_smooth_type="FACE",
        add_leaf_bones=False,
        bake_anim=False,
    )
    log.info(f"FBX exported: {out_path}")


# ── Time estimator ────────────────────────────────────────────────────────────

def _estimate_render_time(n_cameras: int, samples: int, resolution: tuple,
                           device: str) -> float:
    """
    Very rough heuristic: seconds per camera.
    GPU at 512 samples / 4K ≈ 90s; CPU ≈ 4x longer.
    """
    base = 90.0 * (samples / 512.0) * (resolution[0] * resolution[1]) / (3840 * 2160)
    if "cpu" in device:
        base *= 4.0
    return round(base * n_cameras, 0)


# ── Public API ────────────────────────────────────────────────────────────────

def configure_and_render(
    cameras:     list,
    output_dir:  str   = "./output",
    quality:     str   = "production",
    resolution:  tuple = (3840, 2160),
    file_format: str   = "PNG",
    export_3d:   bool  = True,
) -> None:
    """
    Configure Cycles and render all cameras to output_dir.

    Args:
        cameras:     List of (render_name, camera_object) from lighting_camera.
        output_dir:  Root output directory.
        quality:     "preview" | "production" | "ultra"
        resolution:  (width, height) in pixels. Default 4K.
        file_format: "PNG" | "JPEG"
        export_3d:   If True, export GLB and FBX after rendering.
    """
    t0 = time.time()
    log.info(f"=== Render Engine START | quality={quality!r} "
             f"res={resolution[0]}x{resolution[1]} ===")

    # ── Setup ─────────────────────────────────────────────────────────────────
    device = _configure_gpu()
    _configure_cycles(quality)

    renders_dir  = os.path.join(output_dir, "renders")
    previews_dir = os.path.join(output_dir, "previews")
    os.makedirs(renders_dir, exist_ok=True)
    os.makedirs(previews_dir, exist_ok=True)

    samples = QUALITY_SAMPLES.get(quality, 512)
    est_secs = _estimate_render_time(len(cameras), samples, resolution, device)
    log.info(f"Estimated total render time: ~{est_secs:.0f}s "
             f"({est_secs/60:.1f} min) on {device}")

    # ── Save .blend before rendering (checkpoint) ─────────────────────────────
    blend_path = os.path.join(output_dir, "scene_checkpoint.blend")
    os.makedirs(output_dir, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    log.info(f"Scene saved: {blend_path}")

    ext = ".png" if file_format == "PNG" else ".jpg"
    render_times = {}

    # ── Preview pass (128 samples) ────────────────────────────────────────────
    if quality != "preview":
        prev_samples = bpy.context.scene.cycles.samples
        bpy.context.scene.cycles.samples = 64
        bpy.context.scene.cycles.use_adaptive_sampling = False
        for render_name, cam_obj in cameras:
            prev_path = os.path.join(previews_dir, f"{render_name}_preview{ext}")
            _render_camera(cam_obj, prev_path, (1280, 720), file_format)
        # Restore production settings
        bpy.context.scene.cycles.samples = prev_samples
        bpy.context.scene.cycles.use_adaptive_sampling = True
        log.info("Preview renders complete")

    # ── Production pass ───────────────────────────────────────────────────────
    for render_name, cam_obj in cameras:
        out_path = os.path.join(renders_dir, f"{render_name}{ext}")
        elapsed  = _render_camera(cam_obj, out_path, resolution, file_format)
        render_times[render_name] = elapsed

    # ── 3D Exports ────────────────────────────────────────────────────────────
    if export_3d:
        try:
            _export_glb(output_dir)
        except Exception as exc:
            log.warning(f"GLB export failed: {exc}")
        try:
            _export_fbx(output_dir)
        except Exception as exc:
            log.warning(f"FBX export failed: {exc}")

    total = round(time.time() - t0, 1)
    log.info("=== Render Engine DONE ===")
    log.info(f"Total pipeline time: {total}s ({total/60:.1f} min)")
    log.info("Per-camera render times:")
    for name, t in render_times.items():
        log.info(f"  {name}: {t}s")
    log.info(f"Output directory: {os.path.abspath(output_dir)}")
