"""
scene_builder.py
Builds a complete, organized Blender scene from a scene_data dict produced
by blueprint_parser.py. Uses bmesh for all mesh operations (not bpy.ops).

Coordinate system: X=width (East), Y=depth (North), Z=height (Up) — Blender default Z-up.

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


# ── Wall builder (bmesh, Z-up: X=width, Y=depth, Z=height) ───────────────────

def _build_wall(name: str, start: tuple, end: tuple,
                thickness: float, height: float,
                col: bpy.types.Collection) -> bpy.types.Object:
    """
    Build a wall between two 2D floor-plan points.
    Floor plan coords map to (X, Y); Z is height.
    """
    sx, sy = start
    ex, ey = end
    dx, dy = ex - sx, ey - sy
    length = math.hypot(dx, dy)
    if length < 0.05:
        return None

    # Wall tangent and normal in the XY floor plane
    tx, ty = dx / length, dy / length   # along wall
    nx, ny = -ty, tx                     # perpendicular (normal)

    hw = thickness / 2.0

    # Four base corners in XY at Z=0, extruded to Z=height
    corners = [
        Vector((sx + nx * hw, sy + ny * hw, 0.0)),
        Vector((sx - nx * hw, sy - ny * hw, 0.0)),
        Vector((ex - nx * hw, ey - ny * hw, 0.0)),
        Vector((ex + nx * hw, ey + ny * hw, 0.0)),
    ]
    top_corners = [Vector((v.x, v.y, height)) for v in corners]

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
    # No subdivision — walls need sharp edges for architectural accuracy
    return obj


# ── Floor builder ─────────────────────────────────────────────────────────────

def _build_floor(scene_data: dict, col: bpy.types.Collection) -> bpy.types.Object:
    """Rectangular floor in the XY plane at Z=-0.05."""
    fw = scene_data["footprint_width"]
    fd = scene_data["footprint_depth"]

    bm = bmesh.new()
    verts = [
        bm.verts.new(Vector((0,   0,  -0.05))),
        bm.verts.new(Vector((fw,  0,  -0.05))),
        bm.verts.new(Vector((fw,  fd, -0.05))),
        bm.verts.new(Vector((0,   fd, -0.05))),
    ]
    bm.faces.new(verts)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges, cuts=7, use_grid_fill=True)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new("floor_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()

    obj = _new_mesh_object("Floor", mesh, col)
    obj["type"] = "floor"
    return obj


# ── Roof builders (Z-up: X=width, Y=depth, Z=height) ─────────────────────────

def _build_gable_roof(fw: float, fd: float, base_z: float, pitch_deg: float,
                      col: bpy.types.Collection) -> bpy.types.Object:
    """Gable roof: two sloped faces meeting at a central ridge parallel to X."""
    pitch = math.radians(pitch_deg)
    ridge_h = (fd / 2.0) * math.tan(pitch)
    ridge_z = base_z + ridge_h
    overhang = 0.6

    bm = bmesh.new()
    v = [
        bm.verts.new(Vector((-overhang,      -overhang,      base_z))),   # SW eave
        bm.verts.new(Vector((fw + overhang,  -overhang,      base_z))),   # SE eave
        bm.verts.new(Vector((fw + overhang,  fd / 2.0,       ridge_z))),  # E ridge
        bm.verts.new(Vector((-overhang,      fd / 2.0,       ridge_z))),  # W ridge
        bm.verts.new(Vector((fw + overhang,  fd + overhang,  base_z))),   # NE eave
        bm.verts.new(Vector((-overhang,      fd + overhang,  base_z))),   # NW eave
    ]
    bm.faces.new([v[0], v[1], v[2], v[3]])   # south slope
    bm.faces.new([v[3], v[2], v[4], v[5]])   # north slope
    bm.faces.new([v[0], v[3], v[5]])          # west gable
    bm.faces.new([v[1], v[4], v[2]])          # east gable
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new("roof_gable_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return _new_mesh_object("Roof_Gable", mesh, col)


def _build_hip_roof(fw: float, fd: float, base_z: float, pitch_deg: float,
                    col: bpy.types.Collection) -> bpy.types.Object:
    """Hip roof: four sloped faces."""
    pitch = math.radians(pitch_deg)
    rise = (min(fw, fd) / 2.0) * math.tan(pitch)
    ridge_z = base_z + rise
    inset = min(fw, fd) / 2.0
    overhang = 0.5

    bm = bmesh.new()
    b = [
        bm.verts.new(Vector((-overhang,      -overhang,      base_z))),
        bm.verts.new(Vector((fw + overhang,  -overhang,      base_z))),
        bm.verts.new(Vector((fw + overhang,  fd + overhang,  base_z))),
        bm.verts.new(Vector((-overhang,      fd + overhang,  base_z))),
    ]
    r = [
        bm.verts.new(Vector((inset,      inset,      ridge_z))),
        bm.verts.new(Vector((fw - inset, inset,      ridge_z))),
        bm.verts.new(Vector((fw - inset, fd - inset, ridge_z))),
        bm.verts.new(Vector((inset,      fd - inset, ridge_z))),
    ]
    bm.faces.new([b[0], b[1], r[1], r[0]])   # south
    bm.faces.new([b[1], b[2], r[2], r[1]])   # east
    bm.faces.new([b[2], b[3], r[3], r[2]])   # north
    bm.faces.new([b[3], b[0], r[0], r[3]])   # west
    bm.faces.new([r[0], r[1], r[2], r[3]])   # ridge cap
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new("roof_hip_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return _new_mesh_object("Roof_Hip", mesh, col)


def _build_flat_roof(fw: float, fd: float, base_z: float,
                     col: bpy.types.Collection) -> bpy.types.Object:
    """Flat roof with parapet edge."""
    overhang = 0.3
    parapet_h = 0.4
    bm = bmesh.new()
    verts = [
        bm.verts.new(Vector((-overhang,      -overhang,              base_z))),
        bm.verts.new(Vector((fw + overhang,  -overhang,              base_z))),
        bm.verts.new(Vector((fw + overhang,  fd + overhang,          base_z))),
        bm.verts.new(Vector((-overhang,      fd + overhang,          base_z))),
        bm.verts.new(Vector((-overhang,      -overhang,              base_z + parapet_h))),
        bm.verts.new(Vector((fw + overhang,  -overhang,              base_z + parapet_h))),
        bm.verts.new(Vector((fw + overhang,  fd + overhang,          base_z + parapet_h))),
        bm.verts.new(Vector((-overhang,      fd + overhang,          base_z + parapet_h))),
    ]
    bm.faces.new([verts[0], verts[1], verts[2], verts[3]])   # roof deck
    bm.faces.new([verts[4], verts[5], verts[1], verts[0]])   # south parapet
    bm.faces.new([verts[5], verts[6], verts[2], verts[1]])   # east parapet
    bm.faces.new([verts[6], verts[7], verts[3], verts[2]])   # north parapet
    bm.faces.new([verts[7], verts[4], verts[0], verts[3]])   # west parapet
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new("roof_flat_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return _new_mesh_object("Roof_Flat", mesh, col)


def _build_shed_roof(fw: float, fd: float, base_z: float, pitch_deg: float,
                     col: bpy.types.Collection) -> bpy.types.Object:
    """Single-slope shed roof (rises from south to north)."""
    pitch = math.radians(pitch_deg)
    rise = fd * math.tan(pitch)
    overhang = 0.5
    bm = bmesh.new()
    verts = [
        bm.verts.new(Vector((-overhang,      -overhang,      base_z))),
        bm.verts.new(Vector((fw + overhang,  -overhang,      base_z))),
        bm.verts.new(Vector((fw + overhang,  fd + overhang,  base_z + rise))),
        bm.verts.new(Vector((-overhang,      fd + overhang,  base_z + rise))),
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
    base_z = wall_height + 0.02
    dispatch = {
        "gable": _build_gable_roof,
        "hip":   _build_hip_roof,
        "flat":  _build_flat_roof,
        "shed":  _build_shed_roof,
    }
    builder = dispatch.get(roof_type, _build_gable_roof)
    if roof_type == "flat":
        return builder(fw, fd, base_z, col)
    return builder(fw, fd, base_z, pitch_deg, col)


# ── Opening cutouts ───────────────────────────────────────────────────────────

def _make_cutter(pos: tuple, width: float, height: float, thickness: float,
                 wall_dir: tuple, is_window: bool,
                 sill_height: float = 0.9) -> bpy.types.Object:
    """
    Create a box cutter for boolean subtraction through a wall.
    wall_dir: (tx, ty) unit vector along the wall in the XY floor plane.
    pos: (px, py) center of opening in XY.
    Z is height.
    """
    tx, ty = wall_dir
    nx, ny = -ty, tx        # wall normal in XY

    hw = width / 2.0
    ht = (thickness + 0.15) / 2.0   # slightly thicker than wall for clean boolean
    z0 = sill_height if is_window else 0.0
    z1 = z0 + height
    px, py = pos

    bm = bmesh.new()
    # Box corners: 4 at z0, 4 at z1
    # Along wall: ±hw * tangent
    # Through wall: ±ht * normal
    verts = [
        bm.verts.new(Vector((px + tx * hw + nx * ht,  py + ty * hw + ny * ht,  z0))),
        bm.verts.new(Vector((px - tx * hw + nx * ht,  py - ty * hw + ny * ht,  z0))),
        bm.verts.new(Vector((px - tx * hw - nx * ht,  py - ty * hw - ny * ht,  z0))),
        bm.verts.new(Vector((px + tx * hw - nx * ht,  py + ty * hw - ny * ht,  z0))),
        bm.verts.new(Vector((px + tx * hw + nx * ht,  py + ty * hw + ny * ht,  z1))),
        bm.verts.new(Vector((px - tx * hw + nx * ht,  py - ty * hw + ny * ht,  z1))),
        bm.verts.new(Vector((px - tx * hw - nx * ht,  py - ty * hw - ny * ht,  z1))),
        bm.verts.new(Vector((px + tx * hw - nx * ht,  py + ty * hw - ny * ht,  z1))),
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
    """Simple door panel (thin box) with handle sphere."""
    w, h = op["width"], op["height"]
    px, py = op["position"]
    tx, ty = wall_dir

    bm = bmesh.new()
    hw = (w - 0.06) / 2.0
    d = 0.04   # door thickness
    verts = [
        bm.verts.new(Vector((px + tx * hw + tx * 0 - ty * d, py + ty * hw - tx * d,  0.03))),
        bm.verts.new(Vector((px - tx * hw - tx * 0 - ty * d, py - ty * hw - tx * d,  0.03))),
        bm.verts.new(Vector((px - tx * hw - tx * 0 + ty * d, py - ty * hw + tx * d,  0.03))),
        bm.verts.new(Vector((px + tx * hw + tx * 0 + ty * d, py + ty * hw + tx * d,  0.03))),
        bm.verts.new(Vector((px + tx * hw + tx * 0 - ty * d, py + ty * hw - tx * d,  h - 0.03))),
        bm.verts.new(Vector((px - tx * hw - tx * 0 - ty * d, py - ty * hw - tx * d,  h - 0.03))),
        bm.verts.new(Vector((px - tx * hw - tx * 0 + ty * d, py - ty * hw + tx * d,  h - 0.03))),
        bm.verts.new(Vector((px + tx * hw + tx * 0 + ty * d, py + ty * hw + tx * d,  h - 0.03))),
    ]
    faces = [(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]
    for f in faces:
        bm.faces.new([verts[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new("door_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    door = _new_mesh_object(f"Door_{len(col.objects)}", mesh, col)
    door["type"] = "door"

    # Brass handle sphere
    handle_x = px + tx * (hw * 0.7)
    handle_y = py + ty * (hw * 0.7)
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=0.04,
        location=(handle_x, handle_y, h * 0.47)
    )
    handle = bpy.context.active_object
    handle.name = "Door_Handle"
    _link_to_collection(handle, col)
    return door


def _build_window_glass(op: dict, col: bpy.types.Collection) -> bpy.types.Object:
    """Flat window glass pane parallel to the wall face."""
    w, h = op["width"], op["height"]
    px, py = op["position"]
    sill = op.get("sill_height", 0.9)

    bm = bmesh.new()
    hw = w / 2.0
    # Thin pane in the XY plane centered at (px, py)
    verts = [
        bm.verts.new(Vector((px - hw, py, sill))),
        bm.verts.new(Vector((px + hw, py, sill))),
        bm.verts.new(Vector((px + hw, py, sill + h))),
        bm.verts.new(Vector((px - hw, py, sill + h))),
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
    """Rectangular trim frame around a door or window opening."""
    w, h = op["width"], op["height"]
    px, py = op["position"]
    sill = op.get("sill_height", 0.9) if is_window else 0.0
    fw = 0.07   # frame bar width
    fd = thickness + 0.02

    bm = bmesh.new()

    def _add_bar(x0, y0, z0, x1, y1, z1):
        # Create a thin box bar along the given axis
        cx_b, cy_b, cz_b = (x0+x1)/2, (y0+y1)/2, (z0+z1)/2
        length = math.hypot(x1-x0, math.hypot(y1-y0, z1-z0))
        bm2 = bmesh.new()
        bmesh.ops.create_cube(bm2, size=1.0)
        bmesh.ops.scale(bm2, vec=Vector((length + fw, fd, fw)),
                        verts=bm2.verts, space=Matrix.Identity(4))
        bmesh.ops.translate(bm2, vec=Vector((cx_b, cy_b, cz_b)), verts=bm2.verts)
        for f in bm2.faces:
            bm.faces.new([bm.verts.new(v.co.copy()) for v in f.verts])
        bm2.free()

    hw = w / 2.0
    # Vertical jambs (left and right)
    _add_bar(px - hw - fw/2, py, sill,        px - hw - fw/2, py, sill + h + fw)
    _add_bar(px + hw + fw/2, py, sill,        px + hw + fw/2, py, sill + h + fw)
    # Header
    _add_bar(px - hw - fw,   py, sill + h + fw/2, px + hw + fw,   py, sill + h + fw/2)
    # Sill bar (windows only)
    if is_window:
        _add_bar(px - hw - fw, py, sill - fw/2, px + hw + fw, py, sill - fw/2)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new("frame_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    label = "Window" if is_window else "Door"
    obj = _new_mesh_object(f"{label}_Frame_{len(col.objects)}", mesh, col)
    obj["type"] = "frame"
    return obj


# ── Entourage ─────────────────────────────────────────────────────────────────

def _build_tree(cx: float, cy: float, scale: float,
                col: bpy.types.Collection) -> None:
    """Single tree: cone canopy on cylinder trunk."""
    trunk_h = 2.0 * scale
    trunk_r = 0.18 * scale
    canopy_h = 5.5 * scale
    canopy_r = 2.8 * scale

    # Trunk
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False,
                          segments=8, radius1=trunk_r, radius2=trunk_r * 0.6,
                          depth=trunk_h)
    bmesh.ops.translate(bm, vec=Vector((cx, cy, trunk_h / 2)), verts=bm.verts)
    mesh = bpy.data.meshes.new("trunk_mesh")
    bm.to_mesh(mesh); bm.free(); mesh.update()
    trunk_obj = _new_mesh_object(f"Tree_Trunk_{cx:.0f}_{cy:.0f}", mesh, col)
    trunk_obj["type"] = "entourage_trunk"

    # Canopy
    bm2 = bmesh.new()
    bmesh.ops.create_cone(bm2, cap_ends=True, cap_tris=False,
                          segments=8, radius1=canopy_r, radius2=0.4,
                          depth=canopy_h)
    bmesh.ops.translate(bm2, vec=Vector((cx, cy, trunk_h + canopy_h / 2 - 0.3)), verts=bm2.verts)
    mesh2 = bpy.data.meshes.new("canopy_mesh")
    bm2.to_mesh(mesh2); bm2.free(); mesh2.update()
    canopy_obj = _new_mesh_object(f"Tree_Canopy_{cx:.0f}_{cy:.0f}", mesh2, col)
    sub = canopy_obj.modifiers.new("Smooth", "SUBSURF")
    sub.levels = 2
    canopy_obj["type"] = "entourage_canopy"


def _build_driveway(fw: float, fd: float, col: bpy.types.Collection) -> None:
    """3.5m wide × 6m driveway from front of building to ground edge."""
    dw, dl = 3.5, 6.0
    cx = fw / 2.0
    # Front of building is at y=0; driveway extends forward (negative y)
    bm = bmesh.new()
    verts = [
        Vector((cx - dw / 2, 0.0,  0.01)),
        Vector((cx + dw / 2, 0.0,  0.01)),
        Vector((cx + dw / 2, -dl,  0.01)),
        Vector((cx - dw / 2, -dl,  0.01)),
    ]
    for v in verts:
        bm.verts.new(v)
    bm.verts.ensure_lookup_table()
    bm.faces.new(bm.verts)
    mesh = bpy.data.meshes.new("driveway_mesh")
    bm.to_mesh(mesh); bm.free(); mesh.update()
    obj = _new_mesh_object("Driveway", mesh, col)
    obj["type"] = "entourage_driveway"


def _build_scale_figure(door_x: float, door_y: float,
                         col: bpy.types.Collection) -> None:
    """1.75m tall capsule silhouette 2.5m from the front door — gives scale reference."""
    h = 1.75
    r = 0.22
    offset = 2.5   # metres in front of door
    bm = bmesh.new()
    # Cylinder body
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False,
                          segments=8, radius1=r, radius2=r, depth=h * 0.7)
    # Head sphere approximated by UV sphere
    bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=6, radius=r * 1.1)
    # Translate head to top of body
    head_verts = [v for v in bm.verts if v.co.z > h * 0.35 - 0.1]
    bmesh.ops.translate(bm, vec=Vector((0, 0, h * 0.35 + r * 1.1)), verts=head_verts)
    # Center whole figure
    bmesh.ops.translate(bm, vec=Vector((door_x + 1.0, door_y - offset, h * 0.35)),
                        verts=bm.verts)
    mesh = bpy.data.meshes.new("figure_mesh")
    bm.to_mesh(mesh); bm.free(); mesh.update()
    obj = _new_mesh_object("Scale_Figure", mesh, col)
    obj["type"] = "entourage_figure"


def _build_entourage(fw: float, fd: float, openings: list,
                      col: bpy.types.Collection) -> None:
    """
    Add trees around the building perimeter, a driveway, and a scale reference figure.
    """
    import random
    rng = random.Random(42)   # deterministic — same blueprint → same trees

    # Tree positions: 4 corners + 2 sides, 3–8m from building footprint
    corner_offsets = [
        (-4.5, -4.5, 0.85), (fw + 4.0, -4.0, 0.95),
        (-5.0, fd + 3.5, 0.80), (fw + 3.5, fd + 4.0, 0.90),
        (fw / 2 - 6.0, -5.5, 0.75), (fw / 2 + 5.0, fd + 5.0, 1.05),
    ]
    for (tx, ty, scale) in corner_offsets:
        _build_tree(tx, ty, scale, col)

    # Driveway
    _build_driveway(fw, fd, col)

    # Scale figure near first door opening
    doors = [o for o in openings if o.get("type") == "door"]
    if doors:
        d = doors[0]
        dx, dy = d.get("position", [fw / 2, 0.0])
        _build_scale_figure(dx, dy, col)
    else:
        _build_scale_figure(fw / 2, 0.0, col)


# ── Ground plane ──────────────────────────────────────────────────────────────

def _build_ground(fw: float, fd: float, col: bpy.types.Collection) -> bpy.types.Object:
    """50m × 50m subdivided ground plane in the XY plane at Z≈0."""
    cx, cy = fw / 2.0, fd / 2.0
    bm = bmesh.new()
    # create_grid makes an XY plane (Z=0) — correct for Z-up
    bmesh.ops.create_grid(bm, x_segments=20, y_segments=20, size=25.0)
    bmesh.ops.translate(bm, vec=Vector((cx, cy, -0.22)), verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new("ground_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    ground = _new_mesh_object("Ground", mesh, col)
    ground["type"] = "ground"
    disp = ground.modifiers.new("Displacement", "DISPLACE")
    tex = bpy.data.textures.new("ground_noise", "CLOUDS")
    tex.noise_scale = 8.0
    disp.texture = tex
    disp.strength = 0.05
    disp.texture_coords = "GLOBAL"
    return ground


# ── Wall-to-opening association helper ───────────────────────────────────────

def _nearest_wall(op: dict, walls: list) -> dict | None:
    px, py = op["position"]
    best, best_d = None, float("inf")
    for w in walls:
        sx, sy = w["start"]
        ex, ey = w["end"]
        length = math.hypot(ex - sx, ey - sy)
        if length < 0.1:
            continue
        dx_n, dy_n = (ex - sx) / length, (ey - sy) / length
        t = (px - sx) * dx_n + (py - sy) * dy_n
        t = max(0.0, min(length, t))
        cx, cy_w = sx + t * dx_n, sy + t * dy_n
        d = math.hypot(px - cx, py - cy_w)
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
    Uses Z-up coordinate convention (Blender default).

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

    root = bpy.context.scene.collection
    col_struct    = _get_or_create_collection("Structure",  root)
    col_openings  = _get_or_create_collection("Openings",   root)
    col_lighting  = _get_or_create_collection("Lighting",   root)
    col_cameras   = _get_or_create_collection("Cameras",    root)

    walls    = scene_data.get("walls",    [])
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

    # ── Entourage ─────────────────────────────────────────────────────────────
    log.info("Building entourage (trees, driveway, scale figure)...")
    _build_entourage(fw, fd, openings, col_struct)

    # ── Openings (doors + windows) ────────────────────────────────────────────
    log.info(f"Building {len(openings)} openings...")
    for op in openings:
        is_window = op["type"] == "window"
        wall = _nearest_wall(op, walls)
        wall_thickness = wall.get("thickness", 0.2) if wall else 0.2

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

        # Boolean cutter
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
                bool_mod.solver = "FLOAT"
                bpy.context.view_layer.objects.active = target_obj
                try:
                    bpy.ops.object.modifier_apply(modifier=bool_mod.name)
                except Exception as exc:
                    log.warning(f"Boolean apply failed: {exc} — skipping cut")
                bpy.data.objects.remove(cutter, do_unlink=True)

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
