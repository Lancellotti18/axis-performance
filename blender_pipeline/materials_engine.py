"""
materials_engine.py
Applies photorealistic PBR materials to every object in the scene.
All materials use Principled BSDF. Procedural node-based fallbacks are
always available — no external texture files required to get a great result.
Poly Haven textures downloaded automatically when internet is available.
"""

import os
import time
import logging
import math

log = logging.getLogger("materials_engine")
logging.basicConfig(level=logging.INFO, format="[MATERIALS %(asctime)s] %(message)s",
                    datefmt="%H:%M:%S")

import bpy

# ── Optional requests for Poly Haven downloads ────────────────────────────────
try:
    import requests
    HAVE_REQUESTS = True
except ImportError:
    HAVE_REQUESTS = False
    log.warning("requests not installed — Poly Haven textures unavailable")


# ── Node creation helpers ─────────────────────────────────────────────────────

def _node(tree, bl_type: str, loc: tuple = (0, 0)) -> bpy.types.Node:
    n = tree.nodes.new(bl_type)
    n.location = loc
    return n


def _link(tree, from_node, from_socket, to_node, to_socket):
    tree.links.new(from_node.outputs[from_socket], to_node.inputs[to_socket])


def _new_material(name: str) -> bpy.types.Material:
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.node_tree.nodes.clear()
    return mat


def _principled(tree) -> bpy.types.Node:
    """Add a Principled BSDF + Material Output, return the BSDF node."""
    output = _node(tree, "ShaderNodeOutputMaterial", (400, 0))
    bsdf   = _node(tree, "ShaderNodeBsdfPrincipled", (0, 0))
    _link(tree, bsdf, "BSDF", output, "Surface")
    return bsdf


def _tex_coord_mapping(tree, scale: tuple = (1, 1, 1),
                        loc_offset: tuple = (-800, 0)) -> bpy.types.Node:
    """TexCoord → Mapping chain, return Mapping node.
    Uses 'Generated' (object bounding box) instead of UV — works on all bmesh
    geometry without requiring explicit UV unwrap."""
    coord   = _node(tree, "ShaderNodeTexCoord",   (loc_offset[0] - 200, loc_offset[1]))
    mapping = _node(tree, "ShaderNodeMapping",     loc_offset)
    mapping.vector_type = "POINT"
    mapping.inputs["Scale"].default_value = scale
    _link(tree, coord, "Generated", mapping, "Vector")
    return mapping


def _image_texture(tree, img_path: str, color_space: str = "sRGB",
                   loc: tuple = (-400, 0)) -> bpy.types.Node | None:
    """Load image texture node, return None if file doesn't exist."""
    if not os.path.exists(img_path):
        return None
    img_node = _node(tree, "ShaderNodeTexImage", loc)
    img_node.image = bpy.data.images.load(img_path, check_existing=True)
    img_node.image.colorspace_settings.name = color_space
    return img_node


def _noise_color(tree, scale: float = 5.0, detail: float = 8.0,
                 roughness: float = 0.6,
                 color_a=(0.8, 0.8, 0.8, 1), color_b=(0.9, 0.9, 0.9, 1),
                 loc: tuple = (-400, 0)):
    """Procedural noise → ColorRamp, returns ColorRamp node."""
    noise  = _node(tree, "ShaderNodeTexNoise", (loc[0], loc[1]))
    noise.inputs["Scale"].default_value     = scale
    noise.inputs["Detail"].default_value    = detail
    noise.inputs["Roughness"].default_value = roughness
    ramp   = _node(tree, "ShaderNodeValToRGB", (loc[0] + 220, loc[1]))
    ramp.color_ramp.elements[0].color = color_a
    ramp.color_ramp.elements[1].color = color_b
    _link(tree, noise, "Fac", ramp, "Fac")
    return ramp


def _bump_from_noise(tree, bsdf, strength: float = 0.4,
                     scale: float = 8.0, loc: tuple = (-400, -300)):
    """Add a Noise-based bump map and connect to BSDF Normal."""
    noise  = _node(tree, "ShaderNodeTexNoise", (loc[0], loc[1]))
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = 12.0
    bump   = _node(tree, "ShaderNodeBump",    (loc[0] + 220, loc[1]))
    bump.inputs["Strength"].default_value = strength
    _link(tree, noise, "Fac",    bump,  "Height")
    _link(tree, bump,  "Normal", bsdf,  "Normal")


def _try_download_polyhaven(name: str, resolution: str,
                             save_dir: str) -> dict | None:
    """
    Download a PBR texture from Poly Haven API.
    Returns dict of {map_type: local_path} or None if unavailable.
    """
    if not HAVE_REQUESTS:
        return None
    api_url = f"https://api.polyhaven.com/files/{name}"
    try:
        resp = requests.get(api_url, timeout=8)
        if resp.status_code != 200:
            return None
        data = resp.json()
        textures = data.get("textures", {})
        maps = {}
        os.makedirs(save_dir, exist_ok=True)
        for map_type in ("diffuse", "rough", "nor_gl", "arm"):
            entry = textures.get(map_type, {}).get(resolution, {}).get("png")
            if not entry:
                continue
            dl_url  = entry.get("url")
            if not dl_url:
                continue
            filename = f"{name}_{map_type}_{resolution}.png"
            local_path = os.path.join(save_dir, filename)
            if not os.path.exists(local_path):
                img_resp = requests.get(dl_url, timeout=20)
                if img_resp.status_code == 200:
                    with open(local_path, "wb") as f:
                        f.write(img_resp.content)
            if os.path.exists(local_path):
                maps[map_type] = local_path
        return maps if maps else None
    except Exception as exc:
        log.warning(f"Poly Haven download failed ({name}): {exc}")
        return None


# ── Individual material builders ─────────────────────────────────────────────

def make_stucco_wall(tex_dir: str = "") -> bpy.types.Material:
    """Painted stucco exterior wall — warm off-white with procedural grain."""
    mat = _new_material("MAT_Stucco_Wall")
    tree = mat.node_tree
    bsdf = _principled(tree)
    # Slight color variation so it's not perfectly flat
    mapping = _tex_coord_mapping(tree, scale=(3.0, 3.0, 3.0))
    ramp = _noise_color(tree, scale=8.0, detail=10.0, roughness=0.65,
                        color_a=(0.88, 0.85, 0.80, 1.0),
                        color_b=(0.95, 0.93, 0.89, 1.0))
    noise_n = tree.nodes.get("Noise Texture") or list(tree.nodes)[-3]
    try: _link(tree, mapping, "Vector", noise_n, "Vector")
    except Exception: pass
    _link(tree, ramp, "Color", bsdf, "Base Color")
    bsdf.inputs["Roughness"].default_value   = 0.88
    bsdf.inputs["Metallic"].default_value    = 0.0
    try: bsdf.inputs["Specular IOR Level"].default_value = 0.04
    except KeyError: pass
    _bump_from_noise(tree, bsdf, strength=0.35, scale=40.0)
    return mat


def make_brick_wall(tex_dir: str = "") -> bpy.types.Material:
    """Brick exterior — warm red-brown with deep mortar normal."""
    mat = _new_material("MAT_Brick_Wall")
    tree = mat.node_tree
    bsdf = _principled(tree)
    mapping = _tex_coord_mapping(tree, scale=(4.0, 4.0, 4.0))
    # Procedural brick via noise + wave texture
    wave = _node(tree, "ShaderNodeTexWave", (-400, 100))
    wave.wave_type  = "BANDS"
    wave.bands_direction = "X"
    wave.inputs["Scale"].default_value      = 20.0
    wave.inputs["Distortion"].default_value = 3.0
    _link(tree, mapping, "Vector", wave, "Vector")
    noise = _node(tree, "ShaderNodeTexNoise", (-400, -100))
    noise.inputs["Scale"].default_value = 200.0
    _link(tree, mapping, "Vector", noise, "Vector")
    mix = _node(tree, "ShaderNodeMixRGB", (-200, 0))
    mix.blend_type = "OVERLAY"
    mix.inputs["Fac"].default_value = 0.7
    mix.inputs["Color1"].default_value = (0.65, 0.27, 0.18, 1.0)  # brick red
    _link(tree, wave,  "Color", mix, "Color2")
    _link(tree, mix,   "Color", bsdf, "Base Color")
    bsdf.inputs["Roughness"].default_value = 0.9
    _bump_from_noise(tree, bsdf, strength=0.6, scale=60.0, loc=(-400, -350))
    return mat


def make_concrete_wall(tex_dir: str = "") -> bpy.types.Material:
    """Concrete — gray, rough, subtle displacement."""
    mat = _new_material("MAT_Concrete")
    tree = mat.node_tree
    bsdf = _principled(tree)
    ramp = _noise_color(tree, scale=3.0, detail=10.0, roughness=0.7,
                        color_a=(0.50, 0.50, 0.49, 1.0),
                        color_b=(0.58, 0.58, 0.57, 1.0))
    _link(tree, ramp, "Color", bsdf, "Base Color")
    bsdf.inputs["Roughness"].default_value = 0.75
    bsdf.inputs["Metallic"].default_value  = 0.0
    _bump_from_noise(tree, bsdf, strength=0.25, scale=20.0)
    return mat


def make_asphalt_shingles() -> bpy.types.Material:
    """Dark charcoal asphalt shingles — rough, tiled."""
    mat = _new_material("MAT_Asphalt_Shingles")
    tree = mat.node_tree
    bsdf = _principled(tree)
    mapping = _tex_coord_mapping(tree, scale=(6.0, 4.0, 1.0))
    noise = _node(tree, "ShaderNodeTexNoise", (-400, 0))
    noise.inputs["Scale"].default_value = 40.0
    _link(tree, mapping, "Vector", noise, "Vector")
    ramp = _node(tree, "ShaderNodeValToRGB", (-200, 0))
    ramp.color_ramp.elements[0].color = (0.08, 0.08, 0.08, 1.0)
    ramp.color_ramp.elements[1].color = (0.16, 0.15, 0.14, 1.0)
    _link(tree, noise, "Fac", ramp, "Fac")
    _link(tree, ramp, "Color", bsdf, "Base Color")
    bsdf.inputs["Roughness"].default_value = 0.95
    bsdf.inputs["Metallic"].default_value  = 0.0
    _bump_from_noise(tree, bsdf, strength=0.5, scale=80.0, loc=(-400, -300))
    return mat


def make_metal_roof() -> bpy.types.Material:
    """Standing seam metal roof — dark gray, high metallic, anisotropic."""
    mat = _new_material("MAT_Metal_Roof")
    tree = mat.node_tree
    bsdf = _principled(tree)
    mapping = _tex_coord_mapping(tree, scale=(1.0, 8.0, 1.0))
    wave = _node(tree, "ShaderNodeTexWave", (-400, 0))
    wave.inputs["Scale"].default_value      = 8.0
    wave.inputs["Distortion"].default_value = 0.2
    _link(tree, mapping, "Vector", wave, "Vector")
    ramp = _node(tree, "ShaderNodeValToRGB", (-200, 0))
    ramp.color_ramp.elements[0].color = (0.16, 0.16, 0.18, 1.0)
    ramp.color_ramp.elements[1].color = (0.26, 0.26, 0.28, 1.0)
    _link(tree, wave, "Color", ramp, "Fac")
    _link(tree, ramp, "Color", bsdf, "Base Color")
    bsdf.inputs["Metallic"].default_value   = 0.88
    bsdf.inputs["Roughness"].default_value  = 0.28
    bsdf.inputs["Anisotropic"].default_value = 0.6
    return mat


def make_clay_tile_roof() -> bpy.types.Material:
    """Terracotta clay tile — warm orange-brown, rounded."""
    mat = _new_material("MAT_Clay_Tile")
    tree = mat.node_tree
    bsdf = _principled(tree)
    mapping = _tex_coord_mapping(tree, scale=(3.0, 3.0, 1.0))
    noise = _node(tree, "ShaderNodeTexNoise", (-400, 0))
    noise.inputs["Scale"].default_value = 12.0
    _link(tree, mapping, "Vector", noise, "Vector")
    ramp = _node(tree, "ShaderNodeValToRGB", (-200, 0))
    ramp.color_ramp.elements[0].color = (0.72, 0.30, 0.12, 1.0)  # terracotta
    ramp.color_ramp.elements[1].color = (0.80, 0.38, 0.18, 1.0)
    _link(tree, noise, "Fac", ramp, "Fac")
    _link(tree, ramp, "Color", bsdf, "Base Color")
    bsdf.inputs["Roughness"].default_value = 0.80
    _bump_from_noise(tree, bsdf, strength=0.7, scale=30.0, loc=(-400, -300))
    return mat


def make_glass_window() -> bpy.types.Material:
    """Architectural glass — transmission 1.0, IOR 1.45, slight blue tint."""
    mat = _new_material("MAT_Window_Glass")
    tree = mat.node_tree
    bsdf = _principled(tree)
    bsdf.inputs["Base Color"].default_value       = (0.82, 0.92, 0.98, 1.0)
    bsdf.inputs["Roughness"].default_value        = 0.0
    bsdf.inputs["Metallic"].default_value         = 0.0
    bsdf.inputs["Transmission Weight"].default_value = 1.0
    bsdf.inputs["IOR"].default_value              = 1.45
    mat.use_backface_culling = False
    mat.blend_method = "BLEND"
    return mat


def make_window_frame() -> bpy.types.Material:
    """Painted aluminum window frame."""
    mat = _new_material("MAT_Window_Frame")
    tree = mat.node_tree
    bsdf = _principled(tree)
    bsdf.inputs["Base Color"].default_value = (0.92, 0.91, 0.90, 1.0)
    bsdf.inputs["Metallic"].default_value   = 0.3
    bsdf.inputs["Roughness"].default_value  = 0.45
    return mat


def make_door_frame() -> bpy.types.Material:
    """Door frame — painted white wood."""
    mat = _new_material("MAT_Door_Frame")
    tree = mat.node_tree
    bsdf = _principled(tree)
    bsdf.inputs["Base Color"].default_value = (0.95, 0.94, 0.92, 1.0)
    bsdf.inputs["Roughness"].default_value  = 0.55
    return mat


def make_door_panel() -> bpy.types.Material:
    """Door panel — warm painted wood."""
    mat = _new_material("MAT_Door_Panel")
    tree = mat.node_tree
    bsdf = _principled(tree)
    ramp = _noise_color(tree, scale=2.0, detail=6.0,
                        color_a=(0.50, 0.34, 0.22, 1.0),
                        color_b=(0.58, 0.40, 0.26, 1.0))
    _link(tree, ramp, "Color", bsdf, "Base Color")
    bsdf.inputs["Roughness"].default_value = 0.55
    _bump_from_noise(tree, bsdf, strength=0.3, scale=50.0, loc=(-400, -300))
    return mat


def make_door_handle() -> bpy.types.Material:
    """Brass door knob."""
    mat = _new_material("MAT_Door_Handle")
    tree = mat.node_tree
    bsdf = _principled(tree)
    bsdf.inputs["Base Color"].default_value = (0.78, 0.62, 0.18, 1.0)
    bsdf.inputs["Metallic"].default_value   = 0.92
    bsdf.inputs["Roughness"].default_value  = 0.12
    return mat


def make_hardwood_floor() -> bpy.types.Material:
    """Warm oak hardwood floor with grain along planks."""
    mat = _new_material("MAT_Hardwood_Floor")
    tree = mat.node_tree
    bsdf = _principled(tree)
    mapping = _tex_coord_mapping(tree, scale=(6.0, 1.0, 1.0))
    # Plank grain via wave
    wave = _node(tree, "ShaderNodeTexWave", (-400, 100))
    wave.wave_type = "BANDS"
    wave.inputs["Scale"].default_value      = 30.0
    wave.inputs["Distortion"].default_value = 4.0
    wave.inputs["Detail"].default_value     = 6.0
    _link(tree, mapping, "Vector", wave, "Vector")
    noise = _node(tree, "ShaderNodeTexNoise", (-400, -100))
    noise.inputs["Scale"].default_value = 80.0
    _link(tree, mapping, "Vector", noise, "Vector")
    mix = _node(tree, "ShaderNodeMixRGB", (-200, 0))
    mix.blend_type = "OVERLAY"
    mix.inputs["Fac"].default_value = 0.55
    mix.inputs["Color1"].default_value = (0.72, 0.48, 0.24, 1.0)  # warm oak
    _link(tree, wave,  "Color", mix, "Color2")
    _link(tree, mix,   "Color", bsdf, "Base Color")
    bsdf.inputs["Roughness"].default_value = 0.38
    _bump_from_noise(tree, bsdf, strength=0.15, scale=60.0, loc=(-400, -300))
    return mat


def make_tile_floor() -> bpy.types.Material:
    """White/gray floor tile with grout lines."""
    mat = _new_material("MAT_Tile_Floor")
    tree = mat.node_tree
    bsdf = _principled(tree)
    mapping = _tex_coord_mapping(tree, scale=(4.0, 4.0, 1.0))
    # Grout pattern via noise (Musgrave merged into Noise in Blender 4.1+)
    noise = _node(tree, "ShaderNodeTexNoise", (-400, 100))
    noise.inputs["Scale"].default_value   = 30.0
    noise.inputs["Detail"].default_value  = 2.0
    noise.inputs["Roughness"].default_value = 0.9
    _link(tree, mapping, "Vector", noise, "Vector")
    ramp = _node(tree, "ShaderNodeValToRGB", (-200, 100))
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color    = (0.75, 0.74, 0.72, 1.0)  # grout
    e1 = ramp.color_ramp.elements.new(0.05)
    e1.color = (0.94, 0.93, 0.91, 1.0)  # tile
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color    = (0.96, 0.95, 0.93, 1.0)
    _link(tree, noise, "Fac",  ramp, "Fac")
    _link(tree, ramp,  "Color", bsdf, "Base Color")
    bsdf.inputs["Roughness"].default_value = 0.28
    bsdf.inputs["Specular IOR Level"].default_value = 0.5
    _bump_from_noise(tree, bsdf, strength=0.08, scale=30.0, loc=(-400, -300))
    return mat


def make_carpet_floor() -> bpy.types.Material:
    """Carpet — fabric-like, rough, slight bump."""
    mat = _new_material("MAT_Carpet_Floor")
    tree = mat.node_tree
    bsdf = _principled(tree)
    ramp = _noise_color(tree, scale=80.0, detail=14.0, roughness=0.9,
                        color_a=(0.30, 0.28, 0.42, 1.0),
                        color_b=(0.38, 0.36, 0.52, 1.0))
    _link(tree, ramp, "Color", bsdf, "Base Color")
    bsdf.inputs["Roughness"].default_value = 0.98
    bsdf.inputs["Sheen Weight"].default_value = 0.8
    _bump_from_noise(tree, bsdf, strength=0.4, scale=200.0)
    return mat


def make_grass_ground() -> bpy.types.Material:
    """Procedural grass — natural muted green with soil variation."""
    mat = _new_material("MAT_Grass_Ground")
    tree = mat.node_tree
    bsdf = _principled(tree)
    mapping = _tex_coord_mapping(tree, scale=(0.15, 0.15, 0.15))
    noise_a = _node(tree, "ShaderNodeTexNoise", (-400, 100))
    noise_a.inputs["Scale"].default_value   = 12.0
    noise_a.inputs["Detail"].default_value  = 10.0
    noise_a.inputs["Roughness"].default_value = 0.7
    _link(tree, mapping, "Vector", noise_a, "Vector")
    ramp = _node(tree, "ShaderNodeValToRGB", (-200, 100))
    # Muted, natural grass tones — not neon
    ramp.color_ramp.elements[0].color = (0.06, 0.13, 0.03, 1.0)  # dark muted grass
    ramp.color_ramp.elements[1].color = (0.14, 0.24, 0.07, 1.0)  # medium muted grass
    _link(tree, noise_a, "Fac", ramp, "Fac")
    _link(tree, ramp, "Color", bsdf, "Base Color")
    bsdf.inputs["Roughness"].default_value = 0.98
    bsdf.inputs["Metallic"].default_value  = 0.0
    _bump_from_noise(tree, bsdf, strength=0.5, scale=20.0, loc=(-400, -300))
    return mat


def make_soil_ground() -> bpy.types.Material:
    """Soil/dirt around building perimeter."""
    mat = _new_material("MAT_Soil")
    tree = mat.node_tree
    bsdf = _principled(tree)
    ramp = _noise_color(tree, scale=4.0, detail=8.0,
                        color_a=(0.28, 0.18, 0.10, 1.0),
                        color_b=(0.38, 0.26, 0.14, 1.0))
    _link(tree, ramp, "Color", bsdf, "Base Color")
    bsdf.inputs["Roughness"].default_value = 0.98
    _bump_from_noise(tree, bsdf, strength=0.4, scale=15.0)
    return mat


# ── Floor material selector ───────────────────────────────────────────────────

def _floor_material_for_room(room: dict) -> bpy.types.Material:
    label = (room.get("label") or "").lower()
    if "bath" in label or "kitchen" in label or "utility" in label:
        return make_tile_floor()
    if "bedroom" in label or "office" in label or "living" in label:
        return make_hardwood_floor()
    if "garage" in label:
        return make_concrete_wall()
    return make_carpet_floor()


# ── Material assignment ───────────────────────────────────────────────────────

def _assign(obj: bpy.types.Object, mat: bpy.types.Material):
    if obj.data is None or not hasattr(obj.data, "materials"):
        return
    if len(obj.data.materials) == 0:
        obj.data.materials.append(mat)
    else:
        obj.data.materials[0] = mat


def apply_materials(scene_data: dict, wall_material: str = "stucco",
                    roof_material: str = "asphalt") -> None:
    """
    Apply PBR materials to all objects in the scene.

    Args:
        scene_data:    scene_data dict (used for room labels).
        wall_material: "stucco" | "brick" | "concrete"
        roof_material: "asphalt" | "metal" | "clay"
    """
    t0 = time.time()
    log.info("=== Materials Engine START ===")

    # ── Pre-build material library ────────────────────────────────────────────
    wall_mat_dispatch = {
        "stucco":   make_stucco_wall,
        "brick":    make_brick_wall,
        "concrete": make_concrete_wall,
    }
    roof_mat_dispatch = {
        "asphalt": make_asphalt_shingles,
        "metal":   make_metal_roof,
        "clay":    make_clay_tile_roof,
    }

    mat_wall    = wall_mat_dispatch.get(wall_material, make_stucco_wall)()
    mat_roof    = roof_mat_dispatch.get(roof_material, make_asphalt_shingles)()
    mat_floor   = make_hardwood_floor()
    mat_glass   = make_glass_window()
    mat_wframe  = make_window_frame()
    mat_dframe  = make_door_frame()
    mat_door    = make_door_panel()
    mat_handle  = make_door_handle()
    mat_ground  = make_grass_ground()
    mat_concrete= make_concrete_wall()

    rooms = scene_data.get("rooms", [])
    room_mats = [_floor_material_for_room(r) for r in rooms]

    assigned = 0
    for obj in bpy.data.objects:
        name  = obj.name.lower()
        otype = obj.get("type", "")

        if "wall" in name:
            _assign(obj, mat_wall);    assigned += 1
        elif "floor" in name:
            # Try to match room index
            for i, r in enumerate(rooms):
                if str(i) in name:
                    _assign(obj, room_mats[i]); assigned += 1; break
            else:
                _assign(obj, mat_floor); assigned += 1
        elif "roof" in name:
            _assign(obj, mat_roof);    assigned += 1
        elif "ground" in name:
            _assign(obj, mat_ground);  assigned += 1
        elif otype == "window_glass" or "glass" in name:
            _assign(obj, mat_glass);   assigned += 1
        elif otype == "frame" or "frame" in name:
            if "window" in name:
                _assign(obj, mat_wframe); assigned += 1
            else:
                _assign(obj, mat_dframe); assigned += 1
        elif otype == "door" or ("door" in name and "frame" not in name and "handle" not in name):
            _assign(obj, mat_door);    assigned += 1
        elif "handle" in name:
            _assign(obj, mat_handle);  assigned += 1
        elif obj.type == "MESH" and not obj.data.materials:
            # Catch-all: assign stucco so nothing is left gray
            _assign(obj, mat_wall);    assigned += 1

    elapsed = round(time.time() - t0, 2)
    log.info(f"=== Materials DONE in {elapsed}s | {assigned} objects assigned ===")
