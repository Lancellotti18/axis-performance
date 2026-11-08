"""Geometry + numbers for the homepage's sample report (home-v3.html).

A made-up house built from overlapping roof blocks. The roof surface is the
highest block plane at each point, so facets, ridges, hips and valleys all
come out of real plane geometry and every number in the sample report agrees
with every other. Run: python3 scripts/sample_report_geometry.py > out.json
"""
import json, math
from shapely.geometry import Polygon, LineString, box
from shapely.ops import unary_union

# (name, kind, x0, y0, x1, y1, pitch rise per 12). y grows toward the street.
BLOCKS = [
    ("main",   "hip",   0, 0, 64, 34, 6),
    ("wing",   "gable", 24, 20, 42, 58, 8),   # front gable, ridge runs front-back
    ("garage", "gable_x", 48, 10, 84, 34, 6), # side gable, ridge runs east-west
    ("rear",   "gable", 8, -12, 26, 10, 6),   # rear bump, ridge runs front-back
]

def planes(b):
    name, kind, x0, y0, x1, y1, p = b
    s = p / 12
    # each plane: height = s * distance from its eave edge; edges as (a,b,c) with h = a*x+b*y+c
    out = {}
    if kind in ("hip", "gable"):
        out["W"] = (s, 0, -s * x0); out["E"] = (-s, 0, s * x1)
    if kind in ("hip", "gable_x"):
        out["N"] = (0, s, -s * y0); out["S"] = (0, -s, s * y1)
    return out

def plane_region(b, key):
    """Where this plane is the lowest of its block's planes (straight skeleton)."""
    name, kind, x0, y0, x1, y1, p = b
    fp = box(x0, y0, x1, y1)
    pl = planes(b)
    reg = fp
    a = pl[key]
    for k2, c in pl.items():
        if k2 == key: continue
        reg = reg.intersection(halfplane_le(a, c, fp))
    return reg

BIG = 1000
def halfplane_le(a, c, clip):
    """Region where plane a <= plane c, clipped."""
    # (a0-c0)x + (a1-c1)y + (a2-c2) <= 0
    A, B, C = a[0]-c[0], a[1]-c[1], a[2]-c[2]
    if abs(A) < 1e-12 and abs(B) < 1e-12:
        return clip if C <= 1e-9 else Polygon()
    # build a large polygon on the <= side
    n = math.hypot(A, B); ux, uy = A/n, B/n; d = -C/n   # line: ux*x+uy*y = d
    px, py = ux*d, uy*d; tx, ty = -uy, ux
    pts = [(px+tx*BIG, py+ty*BIG), (px-tx*BIG, py-ty*BIG),
           (px-tx*BIG-ux*BIG, py-ty*BIG-uy*BIG), (px+tx*BIG-ux*BIG, py+ty*BIG-uy*BIG)]
    return Polygon(pts).intersection(clip)

def h(pl, x, y): return pl[0]*x + pl[1]*y + pl[2]

facets = []  # (block_idx, key, plane, polygon)
raw = [(i, k, planes(b)[k], plane_region(b, k)) for i, b in enumerate(BLOCKS) for k in planes(b)]
for i, k, pl, reg in raw:
    vis = reg
    for j, k2, pl2, reg2 in raw:
        if j == i: continue
        inter = reg2.intersection(vis)
        if inter.is_empty: continue
        # ties (coplanar planes) go to the earlier block, so a shared plane is drawn once
        pl2t = pl2 if j < i else (pl2[0], pl2[1], pl2[2] - 1e-6)
        vis = vis.difference(inter.intersection(halfplane_le(pl, pl2t, inter.buffer(1))))
    vis = vis.buffer(0)
    if vis.area > 1.0:
        facets.append([i, k, pl, vis])

# merge coplanar neighbours from different blocks
merged = []
for f in facets:
    for m in merged:
        if all(abs(f[2][t]-m[2][t]) < 1e-9 for t in range(3)) and f[3].distance(m[3]) < 1e-6:
            m[3] = unary_union([m[3], f[3]]).buffer(0.05, join_style=2).buffer(-0.05, join_style=2); m[4].add(f[0]); break
    else:
        merged.append([f[0], f[1], f[2], f[3], {f[0]}])

footprint = unary_union([box(*b[2:6]) for b in BLOCKS])

def slope_factor(pl): return math.sqrt(1 + pl[0]**2 + pl[1]**2)
def pitch_of(pl): return round(math.hypot(pl[0], pl[1]) * 12)

def simplify(poly):
    if poly.geom_type != "Polygon":
        poly = max(poly.geoms, key=lambda g: g.area)
    # a negative-then-positive buffer removes zero-width spikes left by the plane cuts
    poly = poly.buffer(-0.05, join_style=2).buffer(0.05, join_style=2)
    if poly.geom_type != "Polygon":
        poly = max(poly.geoms, key=lambda g: g.area)
    return poly.simplify(0.05)

# letter facets, biggest first
merged.sort(key=lambda m: -m[3].area)
out_facets = []
for n, m in enumerate(merged):
    poly = simplify(m[3])
    c = poly.representative_point()
    out_facets.append({"id": chr(65+n), "pitch": pitch_of(m[2]),
                       "plan_sqft": poly.area, "sqft": poly.area * slope_factor(m[2]),
                       "pts": [list(map(lambda v: round(v, 2), p)) for p in poly.exterior.coords[:-1]],
                       "label": [round(c.x, 2), round(c.y, 2)], "plane": m[2], "blocks": sorted(m[4])})

def roof_h(x, y):
    best = 0
    for f in out_facets:
        if Polygon(f["pts"]).buffer(0.05).contains(LineString([(x, y), (x, y)]).centroid):
            best = max(best, h(f["plane"], x, y))
    return best

# edges: walk each facet boundary segment, classify
segs = {}
for f in out_facets:
    pts = f["pts"]
    for a, b in zip(pts, pts[1:] + pts[:1]):
        key = tuple(sorted([tuple(a), tuple(b)]))
        segs.setdefault(key, []).append(f)

lines = []
fp_bound = footprint.boundary
for (a, b), fs in segs.items():
    L = math.dist(a, b)
    if L < 0.3: continue
    ha = h(fs[0]["plane"], *a); hb = h(fs[0]["plane"], *b)
    seg = LineString([a, b])
    if len(fs) == 1:
        if fp_bound.buffer(0.05).contains(seg):
            typ = "eave" if abs(ha) < 0.05 and abs(hb) < 0.05 else "rake"
        else:
            continue  # partial overlap of segments; handled from the other side
    else:
        f1, f2 = fs[0], fs[1]
        same_block = bool(set(f1["blocks"]) & set(f2["blocks"]))
        if same_block:
            typ = "ridge" if abs(ha - hb) < 0.05 else "hip"
        else:
            typ = "valley"
    l3 = math.sqrt(L**2 + (ha - hb)**2)
    lines.append({"type": typ, "a": list(a), "b": list(b), "ft": l3})

# split-segment fallback: facet edges that cover another facet's edge only partly
covered = {}
for f in out_facets:
    poly = Polygon(f["pts"])
    for g in out_facets:
        if g is f: continue
        inter = poly.boundary.intersection(Polygon(g["pts"]).boundary)
        if inter.length > 0.3 and not any(
                LineString([l["a"], l["b"]]).buffer(0.05).contains(inter) for l in lines):
            for part in getattr(inter, "geoms", [inter]):
                if part.length < 0.3 or part.geom_type != "LineString": continue
                (a, b) = part.coords[0], part.coords[-1]
                key = tuple(sorted([a, b]))
                if key in covered: continue
                covered[key] = 1
                ha, hb = h(f["plane"], *a), h(f["plane"], *b)
                same = bool(set(f["blocks"]) & set(g["blocks"]))
                typ = ("ridge" if abs(ha-hb) < 0.05 else "hip") if same else "valley"
                lines.append({"type": typ, "a": list(a), "b": list(b),
                              "ft": math.sqrt(part.length**2 + (ha-hb)**2)})

tot = {t: round(sum(l["ft"] for l in lines if l["type"] == t)) for t in ["ridge", "hip", "valley", "eave", "rake"]}
area = sum(f["sqft"] for f in out_facets)
print(json.dumps({"facets": [{k: v for k, v in f.items() if k != "plane"} for f in out_facets],
                  "lines": lines, "totals": tot, "sqft": area, "squares": area / 100,
                  "bounds": footprint.bounds}, indent=1))
