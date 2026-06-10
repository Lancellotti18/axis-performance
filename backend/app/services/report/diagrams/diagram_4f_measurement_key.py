"""
Diagram 4f — Measurement Key.

Static reference illustration: a simplified isometric house silhouette with
5 numbered callouts pointing to labeled exterior components (corners,
roofline edges, wall/window junctions, gable edges, eave cross-section).

This is the only diagram that doesn't take measurement data — it's the same
on every report. We emit it once on Page 4 of the APIR PDF.

Implementation is a single SVG string built by concatenating positioned
elements. No transforms, no math beyond pixel placement.
"""
from __future__ import annotations

from app.services.report.diagrams.svg_primitives import (
    FONT_FAMILY, svg_document, text,
)


def render_measurement_key() -> str:
    """Return the static measurement-key SVG."""
    height = 380
    body: list[str] = []
    body.append(
        f'<rect x="0" y="0" width="680" height="{height}" fill="#FFFFFF"/>'
    )
    body.append(text(340, 32, "MEASUREMENT KEY",
                     font_size=14, weight="700", fill="#1B3A6B"))
    body.append(text(340, 50, "Terminology used throughout this report",
                     font_size=10, fill="#666666"))

    # ─── House silhouette (left half of the diagram) ──────────────────
    # Simplified two-pitch hip with one window. Cabinet-oblique-ish.
    body.append('<g class="house" transform="translate(50, 80)">')
    # Front wall (gray)
    body.append('<polygon points="0,140 200,140 200,260 0,260" '
                'fill="#D8D8D0" stroke="#888888" stroke-width="0.8"/>')
    # Front roof slope (parallelogram receding to the right)
    body.append('<polygon points="0,140 200,140 240,80 40,80" '
                'fill="#A8A8A0" stroke="#666666" stroke-width="0.8"/>')
    # Right gable end (triangle)
    body.append('<polygon points="200,140 240,80 240,200 200,260" '
                'fill="#C0C0B8" stroke="#888888" stroke-width="0.8"/>')
    # Eave overhang
    body.append('<polygon points="-6,140 206,140 206,148 -6,148" '
                'fill="#F0F0E8" stroke="#AAA" stroke-width="0.4"/>')
    # Soffit under eave
    body.append('<polygon points="-6,148 206,148 206,152 -6,152" '
                'fill="#E0E0D8" stroke="#AAA" stroke-width="0.4"/>')
    # Fascia (vertical strip at eave edge)
    body.append('<rect x="-6" y="138" width="2" height="14" fill="#D0D0C8"/>')
    body.append('<rect x="206" y="138" width="2" height="14" fill="#D0D0C8"/>')
    # Frieze board (between wall top and soffit) — already covered by overhang
    # A single window
    body.append('<rect x="60" y="180" width="40" height="50" '
                'fill="#FFFFFF" stroke="#1A5FA8" stroke-width="0.8"/>')
    body.append('<line x1="80" y1="180" x2="80" y2="230" '
                'stroke="#1A5FA8" stroke-width="0.4"/>')
    body.append('<line x1="60" y1="205" x2="100" y2="205" '
                'stroke="#1A5FA8" stroke-width="0.4"/>')
    body.append('</g>')

    # ─── Callout circles + leader lines ───────────────────────────────
    callouts = [
        # (number, callout_cx, callout_cy, leader_to_x, leader_to_y, label_text)
        (1, 380, 340, 280, 340,
         "Outside corner length (red) / Inside corner length (blue)"),
        (2, 380, 158, 290, 178,
         "Rakes fascia (purple) / Eaves fascia — gutters (yellow)"),
        (3, 380, 280, 140, 200,
         "Vertical trim (orange) / Level starter (teal)"),
        (4, 380, 200, 280, 140,
         "Sloped trim (green)"),
        (5, 380, 230, 60, 230,
         "Eaves fascia (yellow) / Soffit (blue) / Frieze board (brown)"),
    ]
    body.append('<g class="callouts" font-family="' + FONT_FAMILY + '">')
    for num, cx, cy, lx, ly, lbl in callouts:
        # Leader line first (behind circle)
        body.append(
            f'<line x1="{cx}" y1="{cy}" x2="{lx + 50}" y2="{ly}" '
            f'stroke="#555555" stroke-width="0.5" stroke-dasharray="3,2"/>'
        )
        body.append(
            f'<circle cx="{cx}" cy="{cy}" r="10" '
            f'fill="#1B3A6B" stroke="#0E2440" stroke-width="0.5"/>'
        )
        body.append(text(
            cx, cy + 4, str(num), font_size=10, weight="700", fill="#FFFFFF",
        ))
        # Label to the right
        body.append(
            f'<text x="{cx + 18}" y="{cy + 4}" '
            f'font-family="{FONT_FAMILY}" font-size="10" '
            f'fill="#1A1A1A">{lbl}</text>'
        )
    body.append('</g>')

    return svg_document("".join(body), height)
