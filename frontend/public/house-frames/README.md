# House frame sequence

This directory holds the pre-rendered scroll-driven frame sequence used by the
cinematic landing page (`/`). When the user scrolls, the canvas in
`HouseScrollScene` advances through these frames to create the rotation +
build-up animation.

## File naming

```
frame-0001.jpg
frame-0002.jpg
...
frame-NNNN.jpg
```

- Zero-padded to **4 digits** (`frame-0001` through `frame-9999`).
- **JPG preferred** over PNG — much smaller for photographic content. Use
  quality 80–85; the eye barely sees the difference at the speeds frames
  flicker by.
- Sequential, no gaps. A missing frame is silently skipped (the canvas
  falls back to the nearest loaded frame), but big gaps cause visible jumps.

## Frame count

The default `totalFrames={240}` in `src/app/page.tsx` assumes a 240-frame
sequence. Pick any count that fits your render — typical values:

| Frames | Scroll feel    | Asset weight (avg) |
| ------ | -------------- | ------------------ |
| 120    | Snappy         | ~12 MB             |
| 180    | Smooth         | ~18 MB             |
| 240    | Cinematic      | ~25 MB             |
| 360    | Ultra-smooth   | ~36 MB             |

If you have a different count, update the `totalFrames` prop on the
`<HouseScrollScene>` element in `src/app/page.tsx`.

## Recommended source dimensions

- **1920 × 1080** (16:9) or **1920 × 1200** (16:10) — fills modern desktops.
- The canvas renders with `object-fit: cover` semantics, so any aspect
  ratio works; just don't undersize for desktop (>1600px wide preferred).

## Narrative beats (suggested)

The landing page fades content cards in at these scroll-progress ranges,
so it helps if your render hits these beats:

| Progress  | Card heading            | Suggested visual               |
| --------- | ----------------------- | ------------------------------ |
| 0–18%     | Hero title (no card)    | House sitting still, lit       |
| 20–40%    | Blueprint Analysis      | Blueprint lines appear over house frame |
| 42–62%    | Materials & Cost        | Walls / framing snap into place |
| 64–82%    | Compliance              | Roof + finishes complete       |
| 84–100%   | Permit Filing           | Final hero shot, lights on, glow |

## Quick test

After dropping in your frames:

```bash
cd frontend
npm run dev
```

Open `http://localhost:3000`, scroll, and watch the canvas advance. If you
see a single static image instead of a sequence, the file naming is off
(double-check the `frame-NNNN.jpg` format).

## Performance notes

- The component priority-loads every 8th frame first, then fills in the
  rest progressively. The first frame renders nearly instantly even on
  slow connections.
- Total payload matters more than per-frame size — keep the whole
  sequence under ~40 MB for snappy mobile loads.
