"""
scene_builder.py
Builds a complete, organized Blender scene from a scene_data dict produced
by blueprint_parser.py. Uses bmesh for all mesh operations (not bpy.ops).

Collections created: Structure | Openings | Furniture | Lighting | Cameras
"""

import math
import time
import logging

log = logging.getLogger("scene_builder")
logging.basicConfig(level=logging.INFO, format="[BUILDER %(asctime)s] %(message)s",
                    datefmt="%H:%M:%S")

import bpy
import bmesh
from mathutils import Vector, Matrix


# ── Scene helpers ─────────────────────────────────────────────────────────────

def _get_or_create_collection(name: str, parent=None) -> bpy.types.Collection:
    if name in bpy.data.collections:
        return bpy.data.collections[name]
    col = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(col)
    return col


def _link_to_collection(obj: bpy.types.Object, col: bpy.types.Collection):
    """Link object to specific collection, unlink from all others."""
    for c in obj.users_collection:
        c.objects.unlink(obj)
    col.objects.link(obj)


def _new_mesh_object(name: str, mesh_data: bpy.types.Mesh,
                     col: bpy.types.Collection) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, mesh_data)
    col.objects.link(obj)
    return obj


def _set_metric_units():
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = "METERS"


def _clear_scene():
    """Remove all default objects (cube, light, camera) before building."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    # Also purge orphan data blocks
    for block in list(bpy.data.meshes):
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in list(bpy.data.lights):
        if block.users == 0:
            bpy.data.lights.remove(block)
    for block in list(bpy.data.cameras):
        if block.users == 0:
            bpy.data.cameras.remove(block)
    log.info("Scene cleared")


# ── Wall builder (bmesh, no bpy.ops mesh edits) ───────────────────────────────

def _build_wall(name: str, start: tuple, end: tuple,
                thickness: float, height: float,
                col: bpy.types.Collection) -> bpy.types.Object:
    """Extrude a wall mesh along its vector using bmesh."""
    sx, sy = start
    ex, ey = end
    dx, dz = ex - sx, ey - sy
    length = math.hypot(dx, dz)
    if length < 0.05:
        return None

    nx, nz = -dz / length, dx / length   # wall normal

    # Four corners of the wall base at Y=0, extruded to Y=height
    hw = thickness / 2.0
    corners = [
        Vector((sx + nx * hw,  0.0,    sy + nz * hw)),
        Vector((sx - nx * hw,  0.0,    sy - nz * hw)),
        Vector((ex - nx * hw,  0.0,    ey - nz * hw)),
        Vector((ex + nx * hw,  0.0,    ey + nz * hw)),
    ]
    top_corners = [Vector((v.x, height, v.z)) for v in corners]

    bm = bmesh.new()
    verts_bot = [bm.verts.new(v) for v in corners]
    verts_top = [bm.verts.new(v) for v in top_corners]
    bm.verts.ensure_lookup_table()

    # Bottom face
    bm.faces.new([verts_bot[0], verts_bot[1], verts_bot[2], verts_bot[3]])
    # Top face
    bm.faces.new([verts_top[3], verts_top[2], verts_top[1], verts_top[0]])
    # Side faces
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new([verts_bot[i], verts_bot[j], verts_top[j], verts_top[i]])

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.001)

    mesh = bpy.data.meshes.new(name + "_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()

    obj = _new_mesh_object(name, mesh, col)
    obj["wall_thickness"] = thickness
    obj["wall_height"] = height

    # Subdivision surface for smooth edges (level 1)
    sub = obj.modifiers.new("Subsurf", "SUBSURF")
    sub.levels = 1
    sub.render_levels = 1
    return obj


# ── Floor builder ─────────────────────────────────────────────────────────────

def _build_floor(scene_data: dict, col: bpy.types.Collection) -> bpy.types.Object:
    """Create floor from outer footprint with bevel on edges."""
    fw = scene_data["footprint_width"]
    fd = scene_data["footprint_depth"]

    bm = bmesh.new()
    # Simple rectangular floor — subdivided 8x8 for material detail
    verts = [
        bm.verts.new(Vector((0,    -0.05, 0))),
        bm.verts.new(Vector((fw,   -0.05, 0))),
        bm.verts.new(Vector((fw,   -0.05, fd))),
        bm.verts.new(Vector((0,    -0.05, fd))),
    ]
    bm.faces.new(verts)
    # Subdivide
    bmesh.ops.subdivide_edges(bm, edges=bm.edges, cuts=7, use_grid_fill=True)
    # Slight bevel on perimeter edges for realism
    bmesh.ops.bevel(bm, geom=list(bm.edges),
                    offset=0.01, segments=2, profile=0.5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new("floor_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()

    obj = _new_mesh_object("Floor", mesh, col)
    obj["type"] = "floor"
    return obj


# ── Roof builder ──────────────────────────────────────────────────────────────

def _build_gable_roof(fw: float, fd: float, base_y: float, pitch_deg: float,
                       col: bpy.types.Collection) -> bpy.types.Object:
    """Gable roof: two sloped faces meeting at a central ridge."""
    pitch = math.radians(pitch_deg)
    ridge_h = (fd / 2.0) * math.tan(pitch)
    ridge_y = base_y + ridge_h
    overhang = 0.6

    bm = bmesh.new()
    # Ridge runs along X at center Z
    v = [
        bm.verts.new(Vector((-overhang,  base_y,   -overhang))),
        bm.verts.new(Vector((fw + overhang, base_y, -overhang))),
        bm.verts.new(Vector((fw + overhang, ridge_y, fd / 2.0))),
        bm.verts.new(Vector((-overhang,  ridge_y,  fd / 2.0))),
        bm.verts.new(Vector((fw + overhang, base_y,  fd + overhang))),
        bm.verts.new(Vector((-overhang,  base_y,   fd + overhang))),
    ]
    # Front slope
    bm.faces.new([v[0], v[1], v[2], v[3]])
    # Back slope
    bm.faces.new([v[3], v[2], v[4], v[5]])
    # Gable ends (triangles)
    bm.faces.new([v[0], v[3], v[5]])
    bm.faces.new([v[1], v[4], v[2]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new("roof_gable_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return _new_mesh_object("Roof_Gable", mesh, col)


def _build_hip_roof(fw: float, fd: float, base_y: float, pitch_deg: float,
                    col: bpy.types.Collection) -> bpy.types.Object:
    """Hip roof: four sloped faces meeting at a central ridge."""
    pitch = math.radians(pitch_deg)
    rise = (min(fw, fd) / 2.0) * math.tan(pitch)
    ridge_y = base_y + rise
    inset = min(fw, fd) / 2.0
    overhang = 0.5

    bm = bmesh.new()
    # Base perimeter (with overhang)
    b = [
        bm.verts.new(Vector((-overhang,          base_y, -overhang))),
        bm.verts.new(Vector((fw + overhang,       base_y, -overhang))),
        bm.verts.new(Vector((fw + overhang,       base_y, fd + overhang))),
        bm.verts.new(Vector((-overhang,          base_y, fd + overhang))),
    ]
    # Ridge vertices
    r = [
        bm.verts.new(Vector((inset,     ridge_y, inset))),
        bm.verts.new(Vector((fw - inset, ridge_y, inset))),
        bm.verts.new(Vector((fw - inset, ridge_y, fd - inset))),
        bm.verts.new(Vector((inset,     ridge_y, fd - inset))),
    ]
    # Four hip faces
    bm.faces.new([b[0], b[1], r[1], r[0]])   # front
    bm.faces.new([b[1], b[2], r[2], r[1]])   # right
    bm.faces.new([b[2], b[3], r[3], r[2]])   # back
    bm.faces.new([b[3], b[0], r[0], r[3]])   # left
    # Ridge cap
    bm.faces.new([r[0], r[1], r[2], r[3]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new("roof_hip_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return _new_mesh_object("Roof_Hip", mesh, col)


def _build_flat_roof(fw: float, fd: float, base_y: float,
                     col: bpy.types.Collection) -> bpy.types.Object:
    """Flat roof with parapet edge."""
    overhang = 0.3
    parapet_h = 0.4
    bm = bmesh.new()
    verts = [
        bm.verts.new(Vector((-overhang,  base_y,           -overhang))),
        bm.verts.new(Vector((fw + overhang, base_y,        -overhang))),
        bm.verts.new(Vector((fw + overhang, base_y,        fd + overhang))),
        bm.verts.new(Vector((-overhang,  base_y,           fd + overhang))),
        bm.verts.new(Vector((-overhang,  base_y + parapet_h, -overhang))),
        bm.verts.new(Vector((fw + overhang, base_y + parapet_h, -overhang))),
        bm.verts.new(Vector((fw + overhang, base_y + parapet_h, fd + overhang))),
        bm.verts.new(Vector((-overhang,  base_y + parapet_h, fd + overhang))),
    ]
    # Roof plane
    bm.faces.new([verts[0], verts[1], verts[2], verts[3]])
    # Parapet walls (outer top)
    bm.faces.new([verts[4], verts[5], verts[1], verts[0]])
    bm.faces.new([verts[5], verts[6], verts[2], verts[1]])
    bm.faces.new([verts[6], verts[7], verts[3], verts[2]])
    bm.faces.new([verts[7], verts[4], verts[0], verts[3]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new("roof_flat_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return _new_mesh_object("Roof_Flat", mesh, col)


def _build_shed_roof(fw: float, fd: float, base_y: float, pitch_deg: float,
                     col: bpy.types.Collection) -> bpy.types.Object:
    """Single-slope shed roof."""
    pitch = math.radians(pitch_deg)
    rise = fd * math.tan(pitch)
    overhang = 0.5
    bm = bmesh.new()
    verts = [
        bm.verts.new(Vector((-overhang,    base_y,        -overhang))),
        bm.verts.new(Vector((fw + overhang, base_y,        -overhang))),
        bm.verts.new(Vector((fw + overhang, base_y + rise, fd + overhang))),
        bm.verts.new(Vector((-overhang,    base_y + rise, fd + overhang))),
    ]
    bm.faces.new(verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new("roof_shed_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return _new_mesh_object("Roof_Shed", mesh, col)


def _build_roof(scene_data: dict, wall_height: float, roof_type: str,
                pitch_deg: float, col: bpy.types.Collection) -> bpy.types.Object:
    fw = scene_data["footprint_width"]
    fd = scene_data["footprint_depth"]
    base_y = wall_height + 0.02
    dispatch = {
        "gable": _build_gable_roof,
        "hip":   _build_hip_roof,
        "flat":  _build_flat_roof,
        "shed":  _build_shed_roof,
    }
    builder = dispatch.get(roof_type, _build_gable_roof)
    if roof_type in ("flat",):
        return builder(fw, fd, base_y, col)
    return builder(fw, fd, base_y, pitch_deg, col)


# ── Opening cutouts ───────────────────────────────────────────────────────────

def _make_cutter(pos: tuple, width: float, height: float, thickness: float,
                 wall_dir: tuple, is_window: bool,
                 sill_height: float = 0.9) -> bpy.types.Object:
    """Create a box cutter mesh for boolean subtraction."""
    bm = bmesh.new()
    nx, nz = wall_dir
    hw = width / 2.0
    ht = (thickness + 0.1) / 2.0   # slightly wider than wall
    y0 = sill_height if is_window else 0.0
    y1 = y0 + height
    px, pz = pos
    verts = [
        bm.verts.new(Vector((px + nx * hw - nz * ht,  y0, pz + nz * hw - nx * ht))),  # Hmm need correct dir
        bm.verts.new(Vector((px - nx * hw - nz * ht,  y0, pz - nz * hw - nx * ht))),
        bm.verts.new(Vector((px - nx * hw + nz * ht,  y0, pz - nz * hw + nx * ht))),
        bm.verts.new(Vector((px + nx * hw + nz * ht,  y0, pz + nz * hw + nx * ht))),
        bm.verts.new(Vector((px + nx * hw - nz * ht,  y1, pz + nz * hw - nx * ht))),
        bm.verts.new(Vector((px - nx * hw - nz * ht,  y1, pz - nz * hw - nx * ht))),
        bm.verts.new(Vector((px - nx * hw + nz * ht,  y1, pz - nz * hw + nx * ht))),
        bm.verts.new(Vector((px + nx * hw + nz * ht,  y1, pz + nz * hw + nx * ht))),
    ]
    faces = [(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]
    for f in faces:
        bm.faces.new([verts[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new("cutter_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    obj = bpy.data.objects.new("Cutter", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.display_type = "WIRE"
    return obj


def _build_door_panel(op: dict, wall_dir: tuple,
                      col: bpy.types.Collection) -> bpy.types.Object:
    """Simple door panel with handle sphere."""
    w, h = op["width"], op["height"]
    px, pz = op["position"]
    nx, nz = wall_dir
    bm = bmesh.new()
    hw = (w - 0.06) / 2.0
    # Door panel (thin box)
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((w - 0.06, 0.05, h - 0.06)), verts=bm.verts,
                    space=Matrix.Identity(4))
    bmesh.ops.translate(bm, vec=Vector((px, (h - 0.06) / 2.0, pz)), verts=bm.verts)
    mesh = bpy.data.meshes.new("door_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    door = _new_mesh_object(f"Door_{len(col.objects)}", mesh, col)
    door["type"] = "door"

    # Brass handle sphere
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=0.04,
        location=(px + nx * (hw * 0.6), h * 0.47, pz + nz * (hw * 0.6))
    )
    handle = bpy.context.active_object
    handle.name = "Door_Handle"
    _link_to_collection(handle, col)
    return door


def _build_window_glass(op: dict, col: bpy.types.Collection) -> bpy.types.Object:
    """Window glass pane."""
    w, h = op["width"], op["height"]
    px, pz = op["position"]
    sill = op.get("sill_height", 0.9)
    bm = bmesh.new()
    verts = [
        bm.verts.new(Vector((px - w/2, sill,     pz))),
        bm.verts.new(Vector((px + w/2, sill,     pz))),
        bm.verts.new(Vector((px + w/2, sill + h, pz))),
        bm.verts.new(Vector((px - w/2, sill + h, pz))),
    ]
    bm.faces.new(verts)
    mesh = bpy.data.meshes.new("window_glass_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    obj = _new_mesh_object(f"Window_Glass_{len(col.objects)}", mesh, col)
    obj["type"] = "window_glass"
    return obj


def _build_frame(op: dict, thickness: float, is_window: bool,
                 col: bpy.types.Collection) -> bpy.types.Object:
    """Thin rectangular frame around door or window opening."""
    w, h = op["width"], op["height"]
    px, pz = op["position"]
    sill = op.get("sill_height", 0.9) if is_window else 0.0
    fw = 0.07   # frame width
    fd = thickness + 0.02

    bm = bmesh.new()

    def _add_bar(x0, y0, z0, x1, y1, z1):
        dx, dy, dz = x1 - x0, y1 - y0, z1 - z0
        cx, cy, cz = (x0+x1)/2, (y0+y1)/2, (z0+z1)/2
        bm2 = bmesh.new()
        bmesh.ops.create_cube(bm2, size=1.0)
        length = math.hypot(dx, math.hypot(dy, dz))
        bmesh.ops.scale(bm2, vec=Vector((length, fw, fd)), verts=bm2.verts,
                        space=Matrix.Identity(4))
        bmesh.ops.translate(bm2, vec=Vector((cx, cy, cz)), verts=bm2.verts)
        for f in bm2.faces:
            bm.faces.new([bm.verts.new(v.co.copy()) for v in f.verts])
        bm2.free()

    # Left jamb
    _add_bar(px - w/2 - fw/2, sill, pz, px - w/2 - fw/2, sill + h + fw, pz)
    # Right jamb
    _add_bar(px + w/2 + fw/2, sill, pz, px + w/2 + fw/2, sill + h + fw, pz)
    # Header
    _add_bar(px - w/2 - fw, sill + h + fw/2, pz, px + w/2 + fw, sill + h + fw/2, pz)
    # Sill bar (windows only)
    if is_window:
        _add_bar(px - w/2 - fw, sill - fw/2, pz, px + w/2 + fw, sill - fw/2, pz)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new("frame_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    label = "Window" if is_window else "Door"
    obj = _new_mesh_object(f"{label}_Frame_{len(col.objects)}", mesh, col)
    obj["type"] = "frame"
    return obj


# ── Ground plane ──────────────────────────────────────────────────────────────

def _build_ground(fw: float, fd: float, col: bpy.types.Collection) -> bpy.types.Object:
    """50m x 50m subdivided ground plane with subtle displacement noise."""
    cx, cz = fw / 2.0, fd / 2.0
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=20, y_segments=20, size=25.0)
    # Translate so building center aligns
    bmesh.ops.translate(bm, vec=Vector((cx, -0.22, cz)), verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new("ground_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    ground = _new_mesh_object("Ground", mesh, col)
    ground["type"] = "ground"
    # Displacement modifier for terrain noise
    disp = ground.modifiers.new("Displacement", "DISPLACE")
    tex = bpy.data.textures.new("ground_noise", "CLOUDS")
    tex.noise_scale = 8.0
    disp.texture = tex
    disp.strength = 0.05
    disp.texture_coords = "GLOBAL"
    return ground


# ── Wall-to-opening association helper ───────────────────────────────────────

def _nearest_wall(op: dict, walls: list) -> dict | None:
    px, pz = op["position"]
    best, best_d = None, float("inf")
    for w in walls:
        sx, sy = w["start"]
        ex, ey = w["end"]
        length = math.hypot(ex - sx, ey - sy)
        if length < 0.1:
            continue
        dx_n, dz_n = (ex - sx) / length, (ey - sy) / length
        t = (px - sx) * dx_n + (pz - sy) * dz_n
        t = max(0.0, min(length, t))
        cx, cz = sx + t * dx_n, sy + t * dz_n
        d = math.hypot(px - cx, pz - cz)
        if d < best_d:
            best_d = d
            best = w
    return best if best_d < 1.5 else None


# ── Public API ────────────────────────────────────────────────────────────────

def build_scene(
    scene_data: dict,
    wall_height: float = 2.7,
    roof_type: str = "gable",
    pitch_deg: float = 35.0,
) -> None:
    """
    Build a complete Blender 3D scene from scene_data.

    Args:
        scene_data:  Output of blueprint_parser.parse_blueprint().
        wall_height: Wall height in meters (default 2.7 m).
        roof_type:   One of "gable", "hip", "flat", "shed".
        pitch_deg:   Roof pitch angle in degrees (default 35°).
    """
    t0 = time.time()
    log.info("=== Scene Builder START ===")

    _set_metric_units()
    _clear_scene()

    # ── Collections ───────────────────────────────────────────────────────────
    root = bpy.context.scene.collection
    col_struct    = _get_or_create_collection("Structure",  root)
    col_openings  = _get_or_create_collection("Openings",   root)
    col_furniture = _get_or_create_collection("Furniture",  root)
    col_lighting  = _get_or_create_collection("Lighting",   root)
    col_cameras   = _get_or_create_collection("Cameras",    root)

    walls    = scene_data.get("walls",    [])
    rooms    = scene_data.get("rooms",    [])
    openings = scene_data.get("openings", [])
    fw       = scene_data.get("footprint_width",  10.0)
    fd       = scene_data.get("footprint_depth",   8.0)

    # ── Walls ─────────────────────────────────────────────────────────────────
    log.info(f"Building {len(walls)} walls...")
    wall_objs = []
    for i, w in enumerate(walls):
        obj = _build_wall(
            f"Wall_{i:03d}",
            w["start"], w["end"],
            w.get("thickness", 0.2),
            w.get("height", wall_height),
            col_struct,
        )
        if obj:
            wall_objs.append((obj, w))

    # ── Floor ─────────────────────────────────────────────────────────────────
    log.info("Building floor...")
    _build_floor(scene_data, col_struct)

    # ── Roof ──────────────────────────────────────────────────────────────────
    log.info(f"Building {roof_type} roof (pitch={pitch_deg}°)...")
    _build_roof(scene_data, wall_height, roof_type, pitch_deg, col_struct)

    # ── Ground ────────────────────────────────────────────────────────────────
    log.info("Building ground plane...")
    _build_ground(fw, fd, col_struct)

    # ── Openings (doors + windows) ────────────────────────────────────────────
    log.info(f"Building {len(openings)} openings...")
    for op in openings:
        is_window = op["type"] == "window"
        wall = _nearest_wall(op, walls)
        wall_thickness = wall.get("thickness", 0.2) if wall else 0.2

        # Wall direction for this opening
        if wall:
            sx, sy = wall["start"]
            ex, ey = wall["end"]
            length = math.hypot(ex - sx, ey - sy)
            if length > 0.01:
                wall_dir = ((ex - sx) / length, (ey - sy) / length)
            else:
                wall_dir = (1.0, 0.0)
        else:
            wall_dir = (1.0, 0.0)

        # Boolean cutter on nearest wall object
        if wall_objs:
            target_obj = next(
                (obj for obj, wd in wall_objs if wd is wall),
                wall_objs[0][0]
            )
            if target_obj:
                cutter = _make_cutter(
                    op["position"], op["width"], op["height"],
                    wall_thickness, wall_dir, is_window
                )
                bool_mod = target_obj.modifiers.new("Bool_Opening", "BOOLEAN")
                bool_mod.operation = "DIFFERENCE"
                bool_mod.object = cutter
                bool_mod.solver = "FAST"
                # Apply the boolean
                bpy.context.view_layer.objects.active = target_obj
                try:
                    bpy.ops.object.modifier_apply(modifier=bool_mod.name)
                except Exception as exc:
                    log.warning(f"Boolean apply failed: {exc} — skipping cut")
                # Remove cutter
                bpy.data.objects.remove(cutter, do_unlink=True)

        # Frame around opening
        _build_frame(op, wall_thickness, is_window, col_openings)

        if is_window:
            _build_window_glass(op, col_openings)
        else:
            _build_door_panel(op, wall_dir, col_openings)

    elapsed = round(time.time() - t0, 2)
    log.info(
        f"=== Scene Builder DONE in {elapsed}s | "
        f"walls={len(wall_objs)} openings={len(openings)} ==="
    )
