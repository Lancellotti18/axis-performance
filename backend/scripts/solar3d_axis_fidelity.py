"""End-to-end check: engine -> Axis outlines -> totals computed by Axis's OWN
geometry functions (the ones put_facets / put_edges / _aggregate_run use).
Same /out layout as solar3d_compare.py."""
import sys, json; sys.path.insert(0, "/app")
from app.services.solar_layers_service import read_geotiff, assemble
from app.services.roof_from_dsm import extract_roof
from app.services.auto_measure import build_payload
from app.services import geometry_service as geo
O = "/out"; LAT, LNG = 40.0949358, -76.3227374
dsm = read_geotiff(open(f"{O}/dsm.tif","rb").read()); mask = read_geotiff(open(f"{O}/mask.tif","rb").read())
ls = assemble(dsm, mask, None, LAT, LNG, {})
m = extract_roof(ls.dsm, ls.mask, ls.px_m, ls.seed_rc)
W, H, Z = 2048, 1366, 20
sp = {"x": 0.47, "y": 0.41, "lat": LAT, "lng": LNG}          # tap somewhere off-centre
facets, edges = build_payload(m, ls, sp, width_px=W, height_px=H, zoom=Z, lat=LAT)
# --- exactly what put_facets / put_edges store ---
frows, erows, fid = [], [], {}
for i, f in enumerate(facets):
    plan = geo.polygon_plan_area_sqft(f["polygon"], LAT, Z, W, H)
    frows.append({"id": f"f{i}", "facet_label": f["facet_label"], "polygon": f["polygon"], "pitch": f["pitch"],
                  "plan_area_sqft": plan, "true_area_sqft": plan * geo.slope_multiplier(f["pitch"])})
    fid[f["facet_label"]] = frows[-1]
for e in edges:
    fac = fid[e["facet_label"]]; poly = fac["polygon"]
    pl = geo.edge_plan_length_ft(poly[e["vertex_index_start"]], poly[e["vertex_index_end"]], LAT, Z, W, H)
    erows.append({"facet_id": fac["id"], "vertex_index_start": e["vertex_index_start"], "vertex_index_end": e["vertex_index_end"],
                  "edge_type": e["edge_type"], "plan_length_ft": pl,
                  "slope_adjusted_ft": geo.slope_adjusted_edge_length_ft(pl, fac["pitch"], e["edge_type"]),
                  "shared_with_facet": fid[e["shared_with_facet_label"]]["id"] if e["shared_with_facet_label"] else None,
                  "user_confirmed": False})
T = geo.edge_totals_by_type(erows, frows)
sq = sum(f["true_area_sqft"] for f in frows) / 100
eng = m.totals()
aspen = {"squares":25.37,"eave":118.7,"rake":151.5,"ridge":85.8,"valley":45.2,"hip":0.0}
print(f"facets {len(frows)}  pitches {[f['pitch'] for f in frows]}")
print(f"{'':8}{'Aspen':>8}{'engine':>9}{'AS AXIS':>9}{'axis vs Aspen':>15}")
print(f"{'squares':8}{aspen['squares']:8.2f}{eng['squares']:9.2f}{sq:9.2f}{(sq-aspen['squares'])/aspen['squares']*100:+14.1f}%")
for k, ek in (("eave","eaves_ft"),("rake","rakes_ft"),("ridge","ridges_ft"),("valley","valleys_ft"),("hip","hips_ft")):
    a = aspen[k]; v = float(T.get(k, 0.0))
    d = f"{(v-a)/a*100:+14.1f}%" if a else f"{v:14.1f} ft"
    print(f"{k:8}{a:8.1f}{eng[ek]:9.1f}{v:9.1f}{d}")
print("other:", {k: round(float(v),1) for k, v in T.items() if k not in ("eave","rake","ridge","valley","hip")})
