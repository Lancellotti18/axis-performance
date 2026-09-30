"""Run the auto-measure steps (engine -> align -> corrected tap -> Axis payload)
on saved Data Layers + the run's own tile, and draw the result the way the
editor will. /out needs dsm.tif mask.tif rgb.tif tile.img; the tap and tile
geometry are passed as arguments: x y lat lng tile_lat zoom."""
import sys; sys.path.insert(0, "/app")
import numpy as np, cv2
from app.services.solar_layers_service import read_geotiff, assemble
from app.services.roof_from_dsm import extract_roof
from app.services import imagery_align
from app.services.auto_measure import pixel_mappers, building_bounds, seed_for, build_payload
O = "/out"
x, y, lat, lng, tlat, zoom = map(float, sys.argv[1:7]); zoom = int(zoom)
SP = {"x": x, "y": y, "lat": lat, "lng": lng}; W, H = 2048, 1366
ls = assemble(read_geotiff(open(f"{O}/dsm.tif","rb").read()), read_geotiff(open(f"{O}/mask.tif","rb").read()),
              read_geotiff(open(f"{O}/rgb.tif","rb").read()), lat, lng, {})
tile = cv2.imdecode(np.fromfile(f"{O}/tile.img", np.uint8), cv2.IMREAD_COLOR)[..., ::-1]
m = extract_roof(ls.dsm, ls.mask, ls.px_m, ls.seed_rc)
tp, gp = pixel_mappers(ls, SP, tile_w=tile.shape[1], tile_h=tile.shape[0], width_px=W, height_px=H, zoom=zoom, lat=tlat)
al = imagery_align.align_offset(tile, tp, imagery_align.roof_line_image(ls.dsm), gp, building_bounds(m, ls, SP))
print("alignment:", al)
shift = (al["east_m"], al["north_m"]) if al else (0.0, 0.0)
seed = seed_for(ls, SP, shift); same = m.labels[seed] >= 0
print("corrected tap on the same building:", bool(same))
if not same:
    m = extract_roof(ls.dsm, ls.mask, ls.px_m, seed); print("re-measured:", m.available, m.reason)
facets, edges = build_payload(m, ls, SP, width_px=W, height_px=H, zoom=zoom, lat=tlat, shift_en=shift)
print("facets:", [(f["facet_label"], f["pitch"]) for f in facets], "| totals", m.totals())
out = tile.copy(); Hi, Wi = tile.shape[:2]
col = {"eave": (0,190,255), "rake": (255,150,0), "ridge": (220,0,220), "hip": (255,0,120), "valley": (0,90,255),
       "wall_intersection": (255,255,0), "unlabeled": (255,255,255)}
lab = {f["facet_label"]: f for f in facets}
for e in edges:
    P = lab[e["facet_label"]]["polygon"]
    a, b = P[e["vertex_index_start"]], P[e["vertex_index_end"]]
    cv2.line(out, (int(a[0]*Wi), int(a[1]*Hi)), (int(b[0]*Wi), int(b[1]*Hi)), col[e["edge_type"]], 2)
cx, cy = int(x*Wi), int(y*Hi)
crop = out[max(0,cy-230):cy+260, max(0,cx-200):cx+200]
cv2.imwrite(f"{O}/editor_view.png", cv2.resize(crop, (crop.shape[1]*2, crop.shape[0]*2))[..., ::-1])
print("wrote editor_view.png")
