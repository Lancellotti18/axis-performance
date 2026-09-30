"""Run the Solar 3D engine on saved Data Layers files (dsm.tif, mask.tif, rgb.tif, meta.json
in /out) and compare with a reference report. Usage (Docker, from backend/):
  docker run --rm -v "$PWD":/app -v <dir with the tifs>:/out -w /app axis-backend-test python scripts/solar3d_compare.py
The reference numbers and the tapped lat/lng are hard-coded for 339 Buch Ave (Aspen/RoofSnap).
Fetching the tifs: see the dataLayers call in app/services/solar_layers_service.py."""import sys, json, time; sys.path.insert(0, "/app")
import numpy as np, cv2
from app.services.solar_layers_service import read_geotiff, assemble
from app.services.roof_from_dsm import extract_roof
O = "/out"
dsm = read_geotiff(open(f"{O}/dsm.tif","rb").read()); mask = read_geotiff(open(f"{O}/mask.tif","rb").read())
rgb = read_geotiff(open(f"{O}/rgb.tif","rb").read())
meta = json.load(open(f"{O}/meta.json")); d = meta.get("imageryDate") or {}
meta["imagery_date"] = f"{d.get('year')}-{d.get('month')}-{d.get('day')}"
ls = assemble(dsm, mask, rgb, 40.0949358, -76.3227374, meta)
print("layers:", ls.available, ls.reason or "", "| seed", ls.seed_rc, "| px", ls.px_m, "| notes", ls.notes)
t = time.time(); m = extract_roof(ls.dsm, ls.mask, ls.px_m, ls.seed_rc); dt = time.time() - t
print(f"engine: available={m.available} {m.reason or ''} ({dt:.1f}s)")
if not m.available: raise SystemExit
T = m.totals()
print("quality:", m.quality)
print("facets:", [(f.id, f.pitch_12, round(f.plan_m2,1), f.azimuth_deg, round(f.rms_m,3)) for f in m.facets])
print("TOTALS:", json.dumps(T))
aspen = {"squares":25.37,"eaves_ft":118.7,"rakes_ft":151.5,"ridges_ft":85.8,"valleys_ft":45.2,"hips_ft":0.0}
axis_old = {"squares":17.06,"eaves_ft":124.9,"rakes_ft":55.8,"ridges_ft":63.2,"valleys_ft":0.0,"hips_ft":26.2}
print(f"\n{'':10}{'Aspen':>8}{'old trace':>11}{'3D engine':>11}{'3D vs Aspen':>13}")
for k in ("squares","eaves_ft","rakes_ft","ridges_ft","valleys_ft","hips_ft"):
    a, o, n = aspen[k], axis_old[k], T[k]
    err = f"{(n-a)/a*100:+.1f}%" if a else f"{n:.1f} (want 0)"
    print(f"{k:10}{a:8.2f}{o:11.2f}{n:11.2f}{err:>13}")
# overlay
img = np.ascontiguousarray(ls.rgb[..., :3]).copy()
rng = np.random.default_rng(3)
lab = m.labels
for f in m.facets:
    col = rng.integers(60, 255, 3)
    sel = lab == f.id
    img[sel] = (0.55 * img[sel] + 0.45 * col).astype(np.uint8)
colours = {"eave":(0,200,255),"rake":(255,160,0),"ridge":(255,0,0),"hip":(255,0,255),"valley":(0,90,255),"wall_intersection":(255,255,0),"unlabeled":(200,200,200)}
for e in m.edges:
    p0 = tuple(int(round(v)) for v in e.p0); p1 = tuple(int(round(v)) for v in e.p1)
    cv2.line(img, p0, p1, colours.get(e.kind,(255,255,255)), 2)
r, c = ls.seed_rc
cv2.drawMarker(img, (c, r), (255,255,255), cv2.MARKER_CROSS, 18, 2)
big = cv2.resize(img, (img.shape[1]*2, img.shape[0]*2), interpolation=cv2.INTER_NEAREST)
cv2.imwrite(f"{O}/overlay.png", big[..., ::-1])
cv2.imwrite(f"{O}/photo.png", cv2.resize(np.ascontiguousarray(ls.rgb[..., :3]), (img.shape[1]*2, img.shape[0]*2))[..., ::-1])
print("wrote overlay.png")
