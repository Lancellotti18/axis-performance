"""Builds the clickable 6-page sample report in public/home-v3.html from the
geometry in sample_report_geometry.py, so every number on every page agrees.
Run from frontend/:  python3 scripts/build_sample_report.py
"""
import json, math, re, subprocess, sys
from pathlib import Path

here = Path(__file__).parent
d = json.loads(subprocess.check_output([sys.executable, str(here / "sample_report_geometry.py")]))
F, L, T = d["facets"], d["lines"], d["totals"]
x0, y0, x1, y1 = d["bounds"]
PAD = 7
VB = f"{x0-PAD} {y0-PAD} {x1-x0+2*PAD} {y1-y0+2*PAD}"
COL = {"ridge": "#d9653b", "hip": "#16234a", "valley": "#3e8a74", "eave": "#16234a", "rake": "#16234a"}
DASH = {"hip": "2.2 1.8", "rake": "0.6 1.6"}
sqft = d["sqft"]; sq = d["squares"]
pitches = {}
for f in F: pitches[f["pitch"]] = pitches.get(f["pitch"], 0) + f["sqft"]
main_pitch = max(pitches, key=pitches.get)
WASTE = 0.10
sq_w = sq * (1 + WASTE)

def poly(f, fill, stroke="#fff", sw=0.35):
    pts = " ".join(f"{x:.2f},{y:.2f}" for x, y in f["pts"])
    return f'<polygon points="{pts}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round"/>'

def line(l, w=0.9):
    (ax, ay), (bx, by) = l["a"], l["b"]
    dash = f' stroke-dasharray="{DASH[l["type"]]}"' if l["type"] in DASH else ""
    cap = ' stroke-linecap="round"' if l["type"] == "rake" else ""
    return f'<line x1="{ax:.2f}" y1="{ay:.2f}" x2="{bx:.2f}" y2="{by:.2f}" stroke="{COL[l["type"]]}" stroke-width="{w}"{dash}{cap}/>'

def svg(inner, label):
    return (f'<svg viewBox="{VB}" role="img" aria-label="{label}" font-family="IBM Plex Mono,monospace">{inner}</svg>')

# ---- aerial (page 1): facets lit from the north-west over a lawn
aer = [f'<rect x="{x0-PAD}" y="{y0-PAD}" width="{x1-x0+2*PAD}" height="{y1-y0+2*PAD}" fill="#7f9a62"/>',
       f'<rect x="{x0-PAD}" y="{y1+2}" width="{x1-x0+2*PAD}" height="{PAD}" fill="#9a9a94"/>',  # street
       f'<rect x="29" y="{y1}" width="8" height="3" fill="#c9c6bd"/>']  # walk
for cx, cy, r in [(-3, -9, 6), (78, 0, 7), (86, 46, 5), (6, 46, 6), (60, 50, 4.5), (36, -16, 5)]:
    aer.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="#55703f"/><circle cx="{cx-1.2}" cy="{cy-1.2}" r="{r*0.6}" fill="#668452"/>')
geo = subprocess.check_output([sys.executable, "-c", f"""
import json, sys; sys.path.insert(0, {str(here)!r})
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    import sample_report_geometry as g
print(json.dumps([[f['id'], f.get('plane')] for f in g.out_facets]))
"""])
planes = {fid: pl for fid, pl in json.loads(geo)}
for f in F:
    a, b, _ = planes[f["id"]]
    n = math.hypot(a, b) or 1
    # the roof rises along (a,b); it faces the opposite way. Light comes from the NW (-1,-1).
    face = (-a / n, -b / n)
    lit = (face[0] * -0.707 + face[1] * -0.707)
    g = int(118 + 46 * lit)
    aer.append(poly(f, f"rgb({g},{g-4},{g-10})", "#4a4744", 0.25))
for l in L:
    if l["type"] in ("ridge", "hip"):
        (ax, ay), (bx, by) = l["a"], l["b"]
        aer.append(f'<line x1="{ax}" y1="{ay}" x2="{bx}" y2="{by}" stroke="#d8d4cc" stroke-width="0.5"/>')
aerial = svg("".join(aer), "Aerial view of the sample house")

# ---- length diagram (page 2)
ld = [poly(f, "#e4e9f4") for f in F] + [line(l) for l in L]
for l in L:
    if l["ft"] < 12: continue
    (ax, ay), (bx, by) = l["a"], l["b"]
    mx, my = (ax + bx) / 2, (ay + by) / 2
    ang = math.degrees(math.atan2(by - ay, bx - ax))
    if ang > 90: ang -= 180
    if ang < -90: ang += 180
    # nudge the label off the line, to the side away from the facet bulk
    nx, ny = -(by - ay), (bx - ax); nn = math.hypot(nx, ny) or 1
    off = 1.6
    ld.append(f'<text x="{mx + nx/nn*off:.2f}" y="{my + ny/nn*off + 0.7:.2f}" font-size="2.3" fill="{COL[l["type"]]}" '
              f'text-anchor="middle" transform="rotate({ang:.1f} {mx + nx/nn*off:.2f} {my + ny/nn*off + 0.7:.2f})" '
              f'paint-order="stroke" stroke="#fff" stroke-width="0.7">{round(l["ft"])}\'</text>')
length = svg("".join(ld), "Length diagram: every roof line labelled with its length")

# ---- pitch diagram (page 3)
PC = {6: "#cbd5ea", 8: "#7f93c4"}
pd = []
for f in F:
    pd.append(poly(f, PC.get(f["pitch"], "#cbd5ea"), "#16234a", 0.45))
for f in F:
    x, y = f["label"]
    pd.append(f'<text x="{x}" y="{y-0.6}" font-size="3" text-anchor="middle" fill="#16234a" font-weight="600">{f["id"]}</text>'
              f'<text x="{x}" y="{y+2.6}" font-size="2.3" text-anchor="middle" fill="#16234a">{f["pitch"]}/12</text>')
pitch = svg("".join(pd), "Pitch diagram: each plane shaded by steepness")

def n(v, dp=0): return f"{v:,.{dp}f}"
rows_f = "".join(f"<tr><td>{f['id']}</td><td>{f['pitch']}/12</td><td class=r>{n(f['sqft'])}</td></tr>" for f in F)
cnt = {t: sum(1 for l in L if l["type"] == t) for t in T}
rows_l = "".join(f"<tr><td><i class='sw {t}'></i>{t.capitalize()}s</td><td class=r>{cnt[t]}</td><td class=r>{T[t]} ft</td></tr>"
                 for t in ["ridge", "hip", "valley", "eave", "rake"])
eaves_rakes = T["eave"] + T["rake"]; ridge_hip = T["ridge"] + T["hip"]
mat = [
    ("Shingles", f"{math.ceil(sq_w*3)} bundles", f"{sq_w:.1f} sq incl. 10% waste"),
    ("Starter strip", f"{math.ceil(eaves_rakes/105)} bundles", f"{eaves_rakes} ft of eaves + rakes"),
    ("Hip &amp; ridge cap", f"{math.ceil(ridge_hip/33)} bundles", f"{ridge_hip} ft of ridges + hips"),
    ("Synthetic underlayment", f"{math.ceil(sq_w/10)} rolls", "10 sq per roll"),
    ("Ice &amp; water shield", f"{math.ceil(T['valley']/66)} rolls", f"{T['valley']} ft of valleys"),
    ("Drip edge", f"{math.ceil(eaves_rakes/10)} pieces", "10 ft lengths"),
    ("Pipe boots", "3", "from penetrations"),
    ("Roof vents", "4", "from penetrations"),
]
rows_m = "".join(f"<tr><td>{a}</td><td class=r><b>{b}</b></td><td class=m>{c}</td></tr>" for a, b, c in mat)

def page(i, title, body):
    return (f'<article class="rp" data-title="{title}" aria-label="Page {i} of 6: {title}"'
            f'{" hidden" if i > 1 else ""}>{body}</article>')

pages = [
 page(1, "Cover &amp; summary", f'''
  <div class="rp-cover"><div class="rp-logo">YOUR LOGO</div><div><b>Roof Measurement Report</b><span>Sample property · Wilmington, NC</span></div></div>
  <div class="rp-fig">{aerial}</div>
  <div class="rp-stats">
    <div><b>{sq:.1f}</b><span>squares ({n(sqft)} sq ft)</span></div>
    <div><b>{main_pitch}/12</b><span>main pitch</span></div>
    <div><b>{len(F)}</b><span>roof planes</span></div>
    <div><b>{ridge_hip} ft</b><span>ridges + hips</span></div>
    <div><b>{T["valley"]} ft</b><span>valleys</span></div>
    <div><b>{eaves_rakes} ft</b><span>eaves + rakes</span></div>
  </div>'''),
 page(2, "Length diagram", f'''<p class="rp-cap">Every roof line, labelled with its measured length.</p>
  <div class="rp-fig">{length}</div>
  <div class="legend"><span><i style="border-color:#d9653b"></i>Ridge</span><span><i class="hip"></i>Hip</span>
  <span><i style="border-color:#3e8a74"></i>Valley</span><span><i style="border-color:#16234a"></i>Eave</span><span><i class="rake"></i>Rake</span></div>'''),
 page(3, "Pitch diagram", f'''<p class="rp-cap">Each roof plane, shaded by steepness and labelled with its pitch.</p>
  <div class="rp-fig">{pitch}</div>
  <div class="legend"><span><i class="blk" style="background:#cbd5ea"></i>6/12</span><span><i class="blk" style="background:#7f93c4"></i>8/12</span></div>'''),
 page(4, "Roof summary &amp; lines", f'''
  <div class="rp-two"><table class="rp-t"><thead><tr><th>Plane</th><th>Pitch</th><th class=r>Sq ft</th></tr></thead>
  <tbody>{rows_f}<tr class="tot"><td>Total</td><td></td><td class=r>{n(sqft)}</td></tr></tbody></table>
  <div><table class="rp-t"><thead><tr><th>Line</th><th class=r>Count</th><th class=r>Length</th></tr></thead><tbody>{rows_l}</tbody></table>
  <table class="rp-t" style="margin-top:12px"><thead><tr><th>Flashing</th><th class=r>Length</th></tr></thead><tbody>
  <tr><td>Drip edge</td><td class=r>{eaves_rakes} ft</td></tr><tr><td>Valley flashing</td><td class=r>{T["valley"]} ft</td></tr>
  <tr><td>Ridge vent / cap</td><td class=r>{ridge_hip} ft</td></tr></tbody></table></div></div>'''),
 page(5, "Penetrations &amp; materials", f'''
  <table class="rp-t"><thead><tr><th>Penetrations</th><th class=r>Count</th></tr></thead><tbody>
  <tr><td>Plumbing pipes</td><td class=r>3</td></tr><tr><td>Box vents</td><td class=r>4</td></tr></tbody></table>
  <table class="rp-t" style="margin-top:12px"><thead><tr><th>Material order</th><th class=r>Qty</th><th>Based on</th></tr></thead><tbody>{rows_m}</tbody></table>
  <p class="rp-cap">Quantities use your waste factor and product choices.</p>'''),
 page(6, "Method &amp; photos", f'''
  <ul class="rp-check">
   <li><b>Measured from 3D aerial data.</b> Each plane is fitted to Google's 3D surface model; pitch is read from the plane.</li>
   <li><b>Checked by the contractor.</b> Every line was reviewed before this report was made.</li>
   <li><b>Measurement completeness: 100%.</b> The whole roof outline is measured; nothing estimated.</li>
   <li><b>Imagery date</b> is printed on every real report, so you know how recent it is.</li>
  </ul>
  <div class="rp-photos"><div><span>Street view</span></div><div><span>Aerial photo</span></div></div>'''),
]

viewer = f'''<!-- SAMPLE-REPORT:START (generated by scripts/build_sample_report.py — edit the script, not this block) -->
    <figure class="sheet" id="sample" aria-roledescription="carousel" aria-label="Sample Axis report, 6 pages">
      <div class="bar"><b>AXIS<br>PERFORMANCE</b><span id="rpTitle">COVER &amp; SUMMARY · PAGE 1 OF 6</span></div>
      <div class="in">
        <div class="rp-top"><div><h3>Sample property</h3><p class="sub">Hip roof, front gable, side-gable garage · {sq:.1f} squares</p></div>
          <div class="rp-nav"><button type="button" id="rpPrev" aria-label="Previous page">&#8249;</button><button type="button" id="rpNext" aria-label="Next page">&#8250;</button></div></div>
        <div class="rp-view" id="rpView">{"".join(pages)}</div>
        <div class="rp-dots" role="tablist" aria-label="Report pages">{"".join(f'<button type="button" role="tab" aria-label="Page {i}" data-i="{i-1}"{" aria-selected=true" if i==1 else ""}></button>' for i in range(1,7))}</div>
        <p class="note">Sample report for a made-up house. Tap the arrows or swipe to see all 6 pages.</p>
      </div>
    </figure>
<!-- SAMPLE-REPORT:END -->'''

p = here.parent / "public" / "home-v3.html"
s = p.read_text()
if "<!-- SAMPLE-REPORT:START" in s:
    s = re.sub(r"<!-- SAMPLE-REPORT:START.*?<!-- SAMPLE-REPORT:END -->", lambda m: viewer, s, flags=re.S)
else:
    s = re.sub(r'    <figure class="sheet".*?</figure>', lambda m: viewer, s, count=1, flags=re.S)
p.write_text(s)
print(f"sample report: {sq:.2f} sq, {len(F)} planes, totals {T}")
