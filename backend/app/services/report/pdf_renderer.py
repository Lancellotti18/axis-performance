"""
APIR PDF renderer — Jinja2 template + WeasyPrint HTML→PDF.

Renders the 12-page APIR report from a fully-assembled PropertyMeasurements
plus the dict of pre-rendered SVG diagrams (from app.services.report.diagrams).

Two entry points:
  render_html  — produces the HTML string (no PDF). Useful for browser
                 preview and for the orchestrator's diagnostic logs.
  render_pdf   — produces PDF bytes. WeasyPrint requires Pango+Cairo
                 native libs on the host; Render auto-installs these.
"""
from __future__ import annotations

import logging
import math
import pathlib
from typing import Optional

import jinja2

from app.schemas.apir import PropertyMeasurements
from app.services.report.diagrams.svg_primitives import (
    format_area, format_linear, format_pct, format_squares,
)

logger = logging.getLogger(__name__)


TEMPLATE_DIR = pathlib.Path(__file__).parent / "templates"
TEMPLATE_NAME = "apir_report.html.j2"


# ─────────────────────────────────────────────────────────────────────────
# Jinja environment with the APIR formatters
# ─────────────────────────────────────────────────────────────────────────

def _jinja_env() -> jinja2.Environment:
    env = jinja2.Environment(
        loader=jinja2.FileSystemLoader(str(TEMPLATE_DIR)),
        autoescape=jinja2.select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )

    def _linear(v):
        try:
            return format_linear(float(v))
        except (TypeError, ValueError):
            return "—"

    def _area(v):
        try:
            return format_area(float(v))
        except (TypeError, ValueError):
            return "—"

    def _squares(v):
        try:
            return format_squares(float(v))
        except (TypeError, ValueError):
            return "—"

    def _pct(v):
        try:
            return format_pct(float(v))
        except (TypeError, ValueError):
            return "—"

    def _ui(v):
        """Integer with thousands separators, e.g. 1325 → '1,325'."""
        try:
            return f"{int(round(float(v))):,}"
        except (TypeError, ValueError):
            return "—"

    env.filters["linear"] = _linear
    env.filters["area"] = _area
    env.filters["squares"] = _squares
    env.filters["pct"] = _pct
    env.filters["ui"] = _ui
    return env


# ─────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────

def render_html(
    measurements: PropertyMeasurements,
    diagrams: dict[str, str],
) -> str:
    """
    Render the APIR template to an HTML string.
    measurements: fully-assembled PropertyMeasurements
    diagrams: pre-rendered SVG strings keyed by name (facet_plan,
              pitch_view_full, pitch_view_compact, footprint, soffit,
              measurement_key, elev_front, elev_right, elev_left, elev_back)
    """
    env = _jinja_env()
    template = env.get_template(TEMPLATE_NAME)
    diagrams = _normalize_diagram_keys(diagrams)
    return template.render(
        measurements=measurements,
        diagrams=diagrams,
    )


def render_pdf(
    measurements: PropertyMeasurements,
    diagrams: dict[str, str],
    *,
    base_url: Optional[str] = None,
) -> bytes:
    """
    Render the APIR template to PDF bytes via WeasyPrint.

    base_url: passed to WeasyPrint so relative URLs (e.g. data:// or
              local file paths in diagrams/photos) resolve correctly.
              For S3-hosted photos this can stay None.
    """
    # Local import — WeasyPrint loads native libs at import time; we only
    # pay that cost when we're actually rendering.
    try:
        from weasyprint import HTML
    except ImportError as e:
        raise RuntimeError(
            "WeasyPrint is not installed. Add weasyprint>=66.0 to "
            "requirements.txt and ensure libpango + libcairo are present."
        ) from e

    html_str = render_html(measurements, diagrams)
    pdf_bytes = HTML(string=html_str, base_url=base_url).write_pdf()
    logger.info(
        "rendered APIR PDF: %s bytes for job %s",
        len(pdf_bytes), measurements.job.job_id,
    )
    return pdf_bytes


# ─────────────────────────────────────────────────────────────────────────
# Diagram-dict normalization
# ─────────────────────────────────────────────────────────────────────────

REQUIRED_DIAGRAM_KEYS = (
    "facet_plan", "pitch_view_full", "pitch_view_compact",
    "footprint", "soffit", "measurement_key",
    "elev_front", "elev_right", "elev_left", "elev_back",
)


def _normalize_diagram_keys(diagrams: dict[str, str]) -> dict[str, str]:
    """
    Make sure every key the template references exists, falling back to
    a small placeholder SVG so a missing diagram never crashes WeasyPrint.
    Real callers should always pass every key — this is the safety net.
    """
    placeholder = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" '
        'width="100" height="60">'
        '<rect width="100" height="60" fill="#F5F5F5" stroke="#CCC"/>'
        '<text x="50" y="35" text-anchor="middle" '
        'font-family="Inter, sans-serif" font-size="9" fill="#888">'
        'diagram unavailable</text></svg>'
    )
    out = dict(diagrams) if diagrams else {}
    for k in REQUIRED_DIAGRAM_KEYS:
        if k not in out or not out[k]:
            out[k] = placeholder
    return out
