# Usage (from backend/): docker run --rm -v "$PWD":/app -v ~/buildai/backend/.env:/env/.env:ro \
#   -v <dir with runs.json>:/data -w /app axis-backend-test python scripts/validate_coverage.py
# runs.json = roof_measurement_runs rows (select id,total_plan_sqft,total_roof_sqft,confidence,
#   satellite_lat,satellite_zoom,subject_point,measurement_scope) fetched with the service key."""Tune trace-coverage thresholds on real runs. Read-only against Supabase;
one Solar call per run (~$0.01 each). Never prints the key."""
import asyncio, json, os, sys

for line in open("/env/.env"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

sys.path.insert(0, "/app")
from app.services import solar_service                       # noqa: E402
from app.services.geometry_service import metres_between     # noqa: E402
from app.services.report_validators import trace_coverage, imagery_resolution  # noqa: E402

runs = [r for r in json.load(open("/data/runs.json"))
        if (r.get("total_plan_sqft") or 0) > 0
        and isinstance(r.get("subject_point"), dict) and r["subject_point"].get("lat") is not None]


async def main():
    print(f"{'run':8} {'z':>2} {'traced':>7} {'g_foot':>7} {'dist':>5} {'ratio':>6}  {'conf now':>8} -> {'new':>5}  note")
    rows = []
    for r in runs:
        sp = r["subject_point"]
        s = await solar_service.get_building_insights(float(sp["lat"]), float(sp["lng"]))
        if not s.get("available"):
            print(f"{r['id'][:8]} no solar: {s.get('reason','')[:70]}")
            continue
        c = s.get("center") or {}
        dist = metres_between(float(sp["lat"]), float(sp["lng"]), float(c["lat"]), float(c["lng"]))
        ref = {"ground_sqft": s.get("whole_roof_ground_sqft"), "roof_sqft": s.get("whole_roof_area_sqft"),
               "distance_m": dist}
        cov = trace_coverage(r, ref)
        res = imagery_resolution(r.get("satellite_lat"), r.get("satellite_zoom"))
        new = r.get("confidence") or 0
        if cov and cov.cap is not None:
            new = min(new, cov.cap)
        if res and res.coarse and not (cov and cov.cap is None):
            new = min(new, 0.70)
        ratio = r["total_plan_sqft"] / s["whole_roof_ground_sqft"] if s.get("whole_roof_ground_sqft") else None
        note = "ASPEN (truth ~2062 footprint)" if r["id"].startswith("e420330e") else ""
        if cov is None:
            note += " [not judged]"
        print(f"{r['id'][:8]} {r.get('satellite_zoom') or '?':>2} {r['total_plan_sqft']:7.0f} "
              f"{s.get('whole_roof_ground_sqft') or 0:7.0f} {dist:5.1f} "
              f"{(ratio if ratio else 0):6.2f}  {(r.get('confidence') or 0):8.2f} -> {new:5.2f}  {note}")
        rows.append({"id": r["id"], "ratio": ratio, "dist": dist})
    ok = [x["ratio"] for x in rows if x["ratio"] and x["dist"] <= 30]
    if ok:
        ok.sort()
        print("\nratios (trusted building):", [round(x, 2) for x in ok])

asyncio.run(main())
