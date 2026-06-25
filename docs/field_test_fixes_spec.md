# Axis Performance — Roof Workflow Field-Test Fix Spec

> Paste this whole document back to start the fix pass. Work top-to-bottom by
> priority. Think like a roofing contractor: the goal is a **fully functional,
> accurate, precise** tool that feels like a multi-million-dollar app. Every fix
> needs an honest acceptance check, not just "it compiles."

---

## P0 — Accuracy-critical (do first, with the most care)

### P0-1. Auto-detect still locks onto the WRONG house
**Contractor symptom:** Auto-detect traces the neighbor's house / driveway / yard
instead of the subject property. This is the single most important thing to fix.

**Likely root causes (verify):**
- `suggest_facets` crops/centers but the AI can still *see* neighbors inside the
  crop, and on a dense lot the geocoded center isn't perfectly on the roof.
- Google Solar suppression only kicks in where Solar has coverage; with no Solar,
  it's pure AI vision on the cropped tile → wrong house.
- Center-crop (`_center_crop`, frac 0.5) and the localizer halo can still include
  an adjacent roof.

**Desired fix (strongest approach):**
- Use a **hard geometric mask**, not just a crop. Get the subject building polygon
  from **Google Solar** (segment bbox union) or the **OSM footprint** fallback
  (`/runs/{id}/footprint`), convert to image fractions, and **black out every
  pixel outside that polygon (+ a small eave margin)** before sending the tile to
  the facet vision model. The AI then physically cannot trace a neighbor/driveway.
- When neither Solar nor a footprint is available, fall back to the current
  center-crop but tighten and clearly flag low confidence.
- Keep the existing vegetation + off-building + Solar-overlap guards as a second
  line of defense.

**Acceptance criteria:**
- On a dense neighborhood test address, auto-detect returns facets only on the
  subject roof; neighbor roofs/driveways never appear as suggestions.
- If the subject can't be isolated, it says so honestly instead of guessing.

---

### P0-2. Facet TYPE labels are wrong/missing + "reference images for the AI"
**Contractor symptom:** It doesn't label the specific facet type, and when it does
it's often wrong (calls a hip a gable, etc.).

**Two-part fix:**
1. **Reference-image few-shot (the user's idea — build it so users NEVER upload
   references).** Curate a small, fixed set of **annotated reference roof images**
   (a clean gable, a hip, an L-shaped/complex, a flat, a shed, a dormer) stored
   **server-side in the repo/bucket**. Send them to the vision model as in-context
   examples on every facet/type call (Gemini accepts multiple images), each
   captioned with the correct type. This teaches "what each type looks like from
   above" without any contractor upload.
   - Make it a toggle/const so cost/latency is controllable; cache the reference
     image bytes in memory so they're loaded once.
2. **Tighten the type taxonomy + reconcile with Solar.** Cross-check the AI's
   `facet_type` against Solar's `slope_direction`/geometry where available; a
   plane Solar says faces a given way + the facet's own orientation should
   constrain gable-front vs hip-left, etc.

**Acceptance criteria:**
- Suggested facets carry a correct, specific type the majority of the time on
  test roofs (gable vs hip especially).
- No contractor upload of reference images is ever required.

---

### P0-3. Manual labeling assumes every SHARED line is a ridge
**Contractor symptom:** When two facets share an edge, it auto-labels it "ridge."
But shared edges can be **ridge, hip, OR valley**, and it's often wrong.

**Root cause (verify in `suggest_edge_labels`):** the deterministic shared-edge
classifier likely defaults shared → `ridge` without checking geometry.

**Desired fix:** classify a shared edge by geometry:
- **Ridge** — two planes rise to meet at the top; the shared edge is at/near the
  high point, roughly horizontal, planes slope *away* on both sides.
- **Hip** — shared edge is *sloped* (diagonal), planes meet at an outward corner.
- **Valley** — shared edge is sloped and planes meet at an *inward* corner (water
  collects); concave junction.
Use the two facets' orientations + the edge angle + pitch to decide, with a
confidence. Never blanket-default to ridge.

**Acceptance criteria:** on a hip roof, the diagonal shared edges label as hips;
on an L-shaped roof the inner junction labels as a valley; ridges only where
planes actually peak.

---

## P1 — Core functionality

### P1-1. "Apply to facets" (ground-photo pitch) feels like it does nothing
**Symptom:** Tapping "Apply to facets" after a ground photo appears to do nothing.

**Root cause (verify):** the handler maps `facets` → sets pitch, but if there are
**no facets yet** (pitch applied before detection) nothing visibly happens; or the
change isn't reflected in the measurements/summary.

**Desired fix:**
- If facets exist: apply pitch to all, **persist**, bump the geometry stamp so
  measurements visibly recompute, and show a clear confirmation.
- If no facets yet: store the pitch as **pending** and auto-apply it the moment
  facets are created (or disable the button with "detect/draw facets first").
- Make the effect visible — the per-facet pitch + recomputed area should change
  on screen.

**Acceptance criteria:** tapping Apply visibly updates every facet's pitch and the
area/squares totals, and survives a reload.

---

### P1-2. Flashing says "label roof-to-wall edges" — WHERE, and why isn't it automatic?
**Symptom:** After uploading ground photos, flashing still says to label
roof-to-wall edges. Contractor doesn't know where to do that and expected the
ground photo to do it automatically.

**Reality to preserve (and explain in UI):** the ground photo *detects* the
condition; the **linear footage** comes from a roof edge, so one tap is needed to
say *which* edge. That tap can't be removed — but the UX must make it obvious.

**Desired fix:**
- In the **Flashing** panel empty state, add a real button: **"Label roof-to-wall
  edges →"** that jumps to / expands the Roof-to-wall panel and auto-opens the
  photo-detected candidate edges (already built) so it's one tap.
- Make the candidate edges visually obvious (highlight on the editor if feasible).
- Reword so the contractor understands: *photo found it → tap the edge → flashing
  fills in.*

**Acceptance criteria:** from the flashing empty state, a contractor can reach and
confirm the wall edge in ≤2 taps, and flashing then populates.

---

### P1-3. Ground-photo confidence shows "medium" — confusing
**Symptom:** After uploading a clear photo it says pitch confidence "medium" with
no explanation of what that means or how to improve it.

**Desired fix:**
- Tooltip/inline: "How sure the AI is about the pitch read — a square-on gable-end
  shot gives 'high.' 'Medium' is usable; verify it."
- Improve the prompt so a clean, square-on gable end yields **high** more often.
- Show the contractor how to upgrade it (re-shoot the gable straight-on).

**Acceptance criteria:** the confidence word is explained in-product and a good
gable photo reads "high."

---

### P1-4. Zoom 22 never actually applies
**Symptom:** Requested zoom 22 but the tile is lower; z22 "never works."

**Root cause (verify in `imagery_service`):** Esri (or the chosen provider) may not
serve z22 at the address, so it falls back to z20/21; or `_logical_scale`/eff-zoom
caps it.

**Desired fix:** either source higher-zoom imagery where available (Mapbox/MapTiler
at z21–22), or **stop advertising "22"** and show the true max-available zoom with
an honest label ("best available: z20"). Never imply a zoom the tile isn't at, and
make sure measurements use the true `feet_per_pixel`.

**Acceptance criteria:** the zoom shown equals the tile's real zoom; if 22 isn't
available the UI says so plainly.

---

## P2 — UX / cleanup / clarity

### P2-1. Remove the "Center on house" button
It does nothing useful → remove the button and (optionally) the
`autoCenterOnHouse` path from `roof-v2/page.tsx`. Don't leave dead UI.

### P2-2. Siding tracing is messy — clicks don't "lock in"
**Symptom:** While tracing siding, clicking is imprecise; points don't land where
intended; hard to use.

**Desired fix:**
- Verify the pointer→image coordinate mapping under zoom/pan is exact (clicks must
  land precisely where the cursor is).
- Add **snapping**: snap new points to nearby strong image edges/corners (reuse the
  roof snap-to-edge idea), and snap-to-close on the first point.
- Add a **zoom magnifier / larger hit targets** and clearer point handles.

**Acceptance criteria:** a contractor can trace a wall quickly with points landing
exactly where clicked, snapping to obvious wall corners.

### P2-3. Explain (and justify) what Siding is for
Document + in-product: siding measures **exterior wall square footage** from
elevation photos, for contractors who also quote **siding replacement, wraps,
house-wrap, or exterior paint**, and for **insurance/exterior** scopes. If it's not
core to roofing, mark it clearly **optional** so it doesn't clutter the main flow.

---

## Global bar (applies to every fix)
- **Accurate + precise:** numbers must be trustworthy or honestly flagged.
- **Premium feel:** clear guidance, no dead buttons, no silent failures, obvious
  next step at every screen.
- **Honest degradation:** when the tool can't be sure (no Solar, low zoom, blurry
  photo), say so instead of guessing confidently.
- **Don't touch** the manual facet editor's drawing/measurement experience — it's
  the trusted fallback; only ever add to it.
