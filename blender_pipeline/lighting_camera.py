"""
lighting_camera.py
Builds a professional architectural lighting rig and 4-camera system.

Coordinate system: X=width (East), Y=depth (North), Z=height (Up) — Blender default Z-up.

Lighting:  Sky Texture (sun/sky) + fill area light + interior ceiling lights
           + exterior accent spots
Cameras:   Exterior Hero | Aerial 45 | Street Level | Interior Walkthrough
"""

import os
import math
import time
import logging

log = logging.getLogger("lighting_camera")
logging.basicConfig(level=logging.INFO, format="[LIGHTING %(asctime)s] %(message)s",
                    datefmt="%H:%M:%S")

import bpy
from mathutils import Vector, Euler


# ── Time-of-day presets ───────────────────────────────────────────────────────

TIME_PRESETS = {
    "morning": {
        "sun_elevation":  30.0,
        "sun_rotation":   90.0,
        "sun_intensity":  3.5,
        "sky_turbidity":  4.0,
        "sky_intensity":  0.6,
        "sun_color":      (1.0, 0.82, 0.60),
        "fill_intensity": 15.0,
    },
    "midday": {
        "sun_elevation":  70.0,
        "sun_rotation":   180.0,
        "sun_intensity":  6.0,
        "sky_turbidity":  2.5,
        "sky_intensity":  1.0,
        "sun_color":      (1.0, 0.97, 0.92),
        "fill_intensity": 20.0,
    },
    "golden_hour": {
        "sun_elevation":  12.0,
        "sun_rotation":   240.0,
        "sun_intensity":  5.0,
        "sky_turbidity":  3.0,
        "sky_intensity":  0.80,   # brighter sky fills the scene more naturally
        "sun_color":      (1.0, 0.65, 0.35),
        "fill_intensity": 14.0,
    },
    "dusk": {
        "sun_elevation":  4.0,
        "sun_rotation":   270.0,
        "sun_intensity":  2.0,
        "sky_turbidity":  5.0,
        "sky_intensity":  0.35,
        "sun_color":      (1.0, 0.45, 0.25),
        "fill_intensity": 8.0,
    },
}


# ── Helper functions ──────────────────────────────────────────────────────────

def _get_or_create_collection(name: str) -> bpy.types.Collection:
    if name in bpy.data.collections:
        return bpy.data.collections[name]
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    return col


def _link_to(obj: bpy.types.Object, col: bpy.types.Collection):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    col.objects.link(obj)


def _add_area_light(name: str, location: Vector, size: float,
                    energy: float, color: tuple,
                    col: bpy.types.Collection) -> bpy.types.Object:
    light_data = bpy.data.lights.new(name=name, type="AREA")
    light_data.energy          = energy
    light_data.color           = color[:3]
    light_data.size            = size
    light_data.use_shadow      = True
    light_data.shadow_soft_size = size * 0.5
    obj = bpy.data.objects.new(name, light_data)
    col.objects.link(obj)
    obj.location = location
    return obj


def _add_spot_light(name: str, location: Vector, target: Vector,
                    energy: float, color: tuple, spot_angle_deg: float,
                    col: bpy.types.Collection) -> bpy.types.Object:
    light_data = bpy.data.lights.new(name=name, type="SPOT")
    light_data.energy          = energy
    light_data.color           = color[:3]
    light_data.spot_size       = math.radians(spot_angle_deg)
    light_data.spot_blend      = 0.25
    light_data.use_shadow      = True
    light_data.shadow_soft_size = 0.15
    obj = bpy.data.objects.new(name, light_data)
    col.objects.link(obj)
    obj.location = location
    fwd = (target - location).normalized()
    obj.rotation_euler = fwd.to_track_quat("-Z", "Y").to_euler()
    return obj


def _add_camera(name: str, location: Vector, look_at: Vector,
                lens_mm: float, dof_distance: float, fstop: float,
                col: bpy.types.Collection) -> bpy.types.Object:
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens                    = lens_mm
    cam_data.clip_start              = 0.1
    cam_data.clip_end                = 1000.0
    cam_data.dof.use_dof             = True
    cam_data.dof.aperture_fstop      = fstop
    cam_data.dof.focus_distance      = dof_distance
    cam_data.sensor_width            = 36.0   # full-frame sensor
    obj = bpy.data.objects.new(name, cam_data)
    col.objects.link(obj)
    obj.location = location
    direction = (look_at - location).normalized()
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


# ── World (Sky + HDRI) setup ──────────────────────────────────────────────────

def _setup_world(preset: dict, hdri_path: str = "") -> None:
    world = bpy.context.scene.world
    if world is None:
        world = bpy.data.worlds.new("World")
        bpy.context.scene.world = world
    world.use_nodes = True
    tree = world.node_tree
    tree.nodes.clear()

    out    = tree.nodes.new("ShaderNodeOutputWorld")
    out.location = (600, 0)

    mix_bg = tree.nodes.new("ShaderNodeMixShader")
    mix_bg.location = (400, 0)
    tree.links.new(mix_bg.outputs["Shader"], out.inputs["Surface"])

    # Sky Texture (Nishita physically-based sky)
    sky_bg  = tree.nodes.new("ShaderNodeBackground")
    sky_bg.location = (200, 100)
    sky_bg.inputs["Strength"].default_value = preset["sky_intensity"]

    sky_tex = tree.nodes.new("ShaderNodeTexSky")
    sky_tex.location = (-100, 100)
    try: sky_tex.sky_type = "NISHITA"
    except Exception: pass
    try: sky_tex.sun_elevation  = math.radians(preset["sun_elevation"])
    except Exception: pass
    try: sky_tex.sun_rotation   = math.radians(preset["sun_rotation"])
    except Exception: pass
    try: sky_tex.turbidity      = preset["sky_turbidity"]
    except Exception: pass
    try: sky_tex.sun_intensity  = preset["sun_intensity"]
    except Exception: pass
    try: sky_tex.sun_disc       = True
    except Exception: pass
    try: sky_tex.sun_size       = math.radians(0.545)
    except Exception: pass
    tree.links.new(sky_tex.outputs["Color"], sky_bg.inputs["Color"])
    tree.links.new(sky_bg.outputs["Background"], mix_bg.inputs[1])

    # Fill: HDRI or procedural sky-blue
    hdri_bg = tree.nodes.new("ShaderNodeBackground")
    hdri_bg.location = (200, -100)

    if hdri_path and os.path.exists(hdri_path):
        env_tex = tree.nodes.new("ShaderNodeTexEnvironment")
        env_tex.location = (-100, -100)
        env_tex.image = bpy.data.images.load(hdri_path, check_existing=True)
        tree.links.new(env_tex.outputs["Color"], hdri_bg.inputs["Color"])
        hdri_bg.inputs["Strength"].default_value = 0.30
        log.info(f"HDRI loaded: {hdri_path}")
    else:
        sky_color = tree.nodes.new("ShaderNodeRGB")
        sky_color.location = (-100, -100)
        sky_color.outputs[0].default_value = (0.55, 0.70, 0.85, 1.0)
        tree.links.new(sky_color.outputs["Color"], hdri_bg.inputs["Color"])
        hdri_bg.inputs["Strength"].default_value = 0.20

    tree.links.new(hdri_bg.outputs["Background"], mix_bg.inputs[2])
    mix_bg.inputs["Fac"].default_value = 0.70
    log.info(f"World sky: elevation={preset['sun_elevation']}° "
             f"rotation={preset['sun_rotation']}° turbidity={preset['sky_turbidity']}")


# ── Lighting rig ──────────────────────────────────────────────────────────────

def _setup_sun_fill(preset: dict, cx: float, cy: float,
                    col: bpy.types.Collection) -> None:
    """Large area fill light on the opposite side of the sun."""
    sun_az  = math.radians(preset["sun_rotation"])
    fill_az = sun_az + math.pi
    dist = 30.0
    # Fill light position in the XY plane (Z-up), elevated to Z=15
    fx = cx + math.sin(fill_az) * dist
    fy = cy + math.cos(fill_az) * dist
    fz = 15.0
    fill = _add_area_light(
        "Light_FillArea",
        Vector((fx, fy, fz)),
        size=8.0,
        energy=preset["fill_intensity"],
        color=(0.85, 0.90, 1.00),
        col=col,
    )
    fill.rotation_euler = (
        Vector((cx, cy, 0.0)) - Vector((fx, fy, fz))
    ).normalized().to_track_quat("-Z", "Y").to_euler()
    log.info(f"Fill light at ({fx:.1f}, {fy:.1f}, {fz:.1f})")


def _setup_interior_lights(scene_data: dict, wall_height: float,
                            col: bpy.types.Collection) -> None:
    """Ceiling area light for each room at Z = wall_height - 0.15."""
    rooms = scene_data.get("rooms", [])
    if not rooms:
        return
    for i, room in enumerate(rooms):
        poly = room.get("polygon", [])
        if not poly:
            continue
        cx = sum(p[0] for p in poly) / len(poly)
        cy = sum(p[1] for p in poly) / len(poly)
        _add_area_light(
            f"Light_Interior_Room{i:02d}",
            Vector((cx, cy, wall_height - 0.15)),
            size=1.4,
            energy=600.0,
            color=(1.0, 0.88, 0.72),
            col=col,
        )
    log.info(f"Added {len(rooms)} interior ceiling lights")


def _setup_accent_spots(scene_data: dict, wall_height: float,
                         col: bpy.types.Collection) -> None:
    """Ground-level uplighting at building corners."""
    fw = scene_data.get("footprint_width", 10.0)
    fd = scene_data.get("footprint_depth",  8.0)
    corners = [(0, 0), (fw, 0), (fw, fd), (0, fd)]
    for i, (cx, cy) in enumerate(corners):
        target_x = cx + (fw * 0.05 if cx == 0 else -fw * 0.05)
        target_y = cy + (fd * 0.05 if cy == 0 else -fd * 0.05)
        _add_spot_light(
            f"Light_Accent_{i:02d}",
            Vector((cx, cy, 0.3)),
            Vector((target_x, target_y, wall_height * 0.5)),
            energy=80.0,
            color=(1.0, 0.92, 0.75),
            spot_angle_deg=40.0,
            col=col,
        )
    log.info("Added 4 corner accent uplights")


# ── Cameras ───────────────────────────────────────────────────────────────────

def _setup_cameras(scene_data: dict, col: bpy.types.Collection) -> list:
    """
    Create 4 architectural cameras. All positions use Z-up convention:
      X = East (width), Y = North (depth), Z = Up (height).
    Building occupies X=[0..fw], Y=[0..fd], Z=[0..wall_height].
    """
    fw  = scene_data.get("footprint_width", 10.0)
    fd  = scene_data.get("footprint_depth",  8.0)
    cx  = fw / 2.0   # building center X
    cy  = fd / 2.0   # building center Y
    # Aim cameras at the building center at ~1.4m height
    center = Vector((cx, cy, 1.4))
    cameras = []

    # ── CAM_01: Exterior Hero — 3/4 angle from south-west ────────────────────
    hero_dist = max(fw, fd) * 1.3 + 8.0
    cam01 = _add_camera(
        "CAM_01_ExteriorHero",
        Vector((cx - fw * 0.45, -hero_dist, 2.8)),   # offset left for 3/4 view
        Vector((cx + fw * 0.1, cy * 0.4, 1.2)),       # look slightly into face
        lens_mm=35.0,
        dof_distance=hero_dist,
        fstop=8.0,
        col=col,
    )
    cameras.append(("exterior_hero", cam01))

    # ── CAM_02: Aerial 45 — high angle from SE ────────────────────────────────
    aerial_d = max(fw, fd) * 1.5 + 10.0
    cam02 = _add_camera(
        "CAM_02_Aerial45",
        Vector((cx + aerial_d * 0.7, cy - aerial_d * 0.7, 20.0)),
        Vector((cx, cy, 0.0)),
        lens_mm=24.0,
        dof_distance=30.0,
        fstop=16.0,
        col=col,
    )
    cameras.append(("aerial_45", cam02))

    # ── CAM_03: Street Level — perspective from south-west ────────────────────
    street_d = max(fw, fd) * 2.0 + 12.0
    cam03 = _add_camera(
        "CAM_03_StreetLevel",
        Vector((cx - fw * 0.35, -street_d, 1.65)),
        Vector((cx + fw * 0.2, cy, 1.0)),
        lens_mm=50.0,
        dof_distance=street_d,
        fstop=5.6,
        col=col,
    )
    cameras.append(("street_level", cam03))

    # ── CAM_04: Interior Walkthrough — inside first room looking in ───────────
    rooms = scene_data.get("rooms", [])
    if rooms:
        poly = rooms[0].get("polygon", [(1, 1)])
        rx = sum(p[0] for p in poly) / len(poly)
        ry = sum(p[1] for p in poly) / len(poly)
    else:
        rx, ry = cx, cy

    cam04 = _add_camera(
        "CAM_04_Interior",
        Vector((rx, ry + fd * 0.35, 1.5)),
        Vector((rx, ry - fd * 0.35, 1.5)),
        lens_mm=18.0,
        dof_distance=4.0,
        fstop=4.0,
        col=col,
    )
    cameras.append(("interior_walkthrough", cam04))

    log.info(f"Created {len(cameras)} cameras: " +
             ", ".join(c[0] for c in cameras))
    return cameras


# ── Public API ────────────────────────────────────────────────────────────────

def setup_lighting_and_cameras(
    scene_data:   dict,
    time_of_day:  str  = "golden_hour",
    hdri_path:    str  = "",
    wall_height:  float = 2.7,
) -> list:
    """
    Build sun/sky world, area fill, interior and accent lights, and 4 cameras.

    Returns:
        List of (render_name, camera_object) tuples for render_engine.
    """
    t0 = time.time()
    log.info(f"=== Lighting & Cameras START | time_of_day={time_of_day!r} ===")

    preset = TIME_PRESETS.get(time_of_day, TIME_PRESETS["golden_hour"])

    col_light = _get_or_create_collection("Lighting")
    col_cam   = _get_or_create_collection("Cameras")

    _setup_world(preset, hdri_path)

    cx = scene_data.get("footprint_width", 10.0) / 2.0
    cy = scene_data.get("footprint_depth",  8.0) / 2.0
    _setup_sun_fill(preset, cx, cy, col_light)
    _setup_interior_lights(scene_data, wall_height, col_light)
    _setup_accent_spots(scene_data, wall_height, col_light)

    cameras = _setup_cameras(scene_data, col_cam)

    # Set render resolution 16:9
    scene = bpy.context.scene
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080
    scene.render.pixel_aspect_x = 1.0
    scene.render.pixel_aspect_y = 1.0

    elapsed = round(time.time() - t0, 2)
    log.info(f"=== Lighting & Cameras DONE in {elapsed}s ===")
    return cameras
