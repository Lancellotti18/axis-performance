# Ground-Photo × Satellite Fusion — Design Sketch (NOT built yet)

Goal: improve facet auto-detect **accuracy and trust** by using a ground photo
as a *prior / validator* on top of the satellite geometry — NOT by asking one
model to fuse two viewpoints geometrically (that's unreliable; see "Rejected").

## What each input is good for

| Signal | Satellite (top-down) | Ground photo (eye-level) |
|---|---|---|
| Roof outline / polygons | ✅ only source | ❌ no footprint |
| Ridge/hip/valley layout | ✅ | ⚠️ one side only |
| **Pitch** | ❌ foreshortened | ✅ best source |
| Chimneys/vents/dormers | ⚠️ easy to miss | ✅ clear |
| Roof shape class | ⚠️ | ✅ |
| Stories / wall height | ❌ | ✅ |

They are complementary. The ground photo is strong exactly where satellite is
weak (pitch, penetrations, shape class) and blind where satellite is strong
(2D geometry).

## Architecture: staged fusion (recommended)

```
ground photo ──► [Vision call #1] ──► RoofFactSheet (structured JSON, below)
                                            │
satellite crop ─► [Vision call #2: facets] ─┤  ← already exists (suggest_facets)
                                            ▼
                              reconcile in code:
                                - seed each facet.predicted_pitch from fact sheet
                                - soft sanity-check facet COUNT vs expected_facets
                                - flag chimneys/penetrations to the penetrations step
                                            ▼
                                  suggestions shown to contractor
```

The two model calls never have to register viewpoints against each other. Each
does what it's good at; we combine the **structured outputs** in code. Degrades
cleanly: no ground photo → skip stage 1, behave exactly as today.

## RoofFactSheet schema (output of vision call #1)

```jsonc
{
  "roof_shape": "gable",          // gable | hip | complex | flat | shed | unknown
  "expected_facets": 2,           // integer hint, NOT authoritative geometry
  "dominant_pitch": "8/12",       // best single pitch estimate for the roof
  "pitch_confidence": 0.6,        // 0..1 — low for one-elevation photos
  "stories": 2,                   // integer or null
  "penetrations": {               // counts the contractor can verify
    "chimneys": 1,
    "plumbing_vents": 2,
    "skylights": 0
  },
  "dominant_material": "asphalt-shingle", // asphalt-shingle | metal | tile | flat-membrane | unknown
  "visible_sides": ["front"],     // which elevations this photo actually shows
  "notes": "2-story gable, brick chimney on the left ridge; front pitch ~8/12."
}
```

## How each field is used (reconcile step)

- `dominant_pitch` + `pitch_confidence` → **seed `facet.predicted_pitch`**
  instead of the hardcoded `6/12`. This is the highest-value win: pitch drives
  `true_area = plan_area / cos(pitch_angle)`, squares, and the material total.
  Only override the per-facet default when `pitch_confidence >= 0.5`.
- `roof_shape` + `expected_facets` → **soft sanity check** on the satellite
  result. If satellite returns 7 facets but the photo clearly shows a simple
  gable (expected 2), lower confidence / warn — do NOT auto-delete.
- `penetrations` → handed to the existing penetrations-suggest step as priors.
- `visible_sides` → the honesty guard: with only `["front"]` we can seed a
  *dominant* pitch but must NOT claim per-side pitch. Per-facet pitch only
  becomes trustworthy with photos from multiple elevations.

## Rejected approach: single multimodal "look at both" call

Passing both images in one prompt and asking the model to map "the gable I see
from the ground" to "this satellite polygon" requires viewpoint registration
the model is not reliable at — no shared coordinate frame, and one photo shows
only 1–2 sides. It produces confident but unverifiable mappings. Keep the calls
separate and reconcile structured outputs in code.

## Build order when we pick this up

1. Vision call #1 → `RoofFactSheet` (new `_analyze_roof_factsheet()` helper).
2. Plumb the existing run's ground photo(s) into `suggest_facets`.
3. Reconcile: pitch seeding first (biggest win), then the count sanity check.
4. Surface in the UI: show the fact sheet summary + which facets were
   pitch-seeded vs defaulted.
