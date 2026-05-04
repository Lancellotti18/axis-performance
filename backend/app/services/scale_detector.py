"""Detects the drawing scale from OCR results and scale bar imagery."""
import re
import numpy as np


def detect_scale(ocr_results: dict, image: np.ndarray) -> float:
    """Returns pixels_per_foot ratio. Falls back to a sheet-size guess when no
    scale string is parsed — kept for backwards compatibility with code paths
    that need a number. New code should use detect_scale_with_source() so it
    can distinguish a real measurement from a fallback guess."""
    px_per_ft, _ = detect_scale_with_source(ocr_results, image)
    return px_per_ft


def detect_scale_with_source(ocr_results: dict, image: np.ndarray):
    """Returns (pixels_per_foot, source) where source is 'ocr' for a scale
    string parsed off the drawing or 'fallback' for the sheet-size guess.
    Callers that want to trust the measurement (e.g. authoritative sqft
    override) should only do so when source == 'ocr'."""
    scale_strings = ocr_results.get("scale_strings", [])
    for text in scale_strings:
        pixels_per_foot = parse_scale_string(text)
        if pixels_per_foot:
            return pixels_per_foot, "ocr"

    height, width = image.shape[:2]
    return width / (42 * 4), "fallback"


def parse_scale_string(text: str) -> float | None:
    """
    Parse strings like:
    - '1/4" = 1\'-0"'  (quarter inch = one foot)
    - '1:50'
    - '1/8" = 1\'-0"'
    """
    # 1/4" = 1'-0" style
    match = re.search(r'(\d+)/(\d+)["\s]+=\s*(\d+)[\'"]', text)
    if match:
        numerator = int(match.group(1))
        denominator = int(match.group(2))
        feet = int(match.group(3))
        # At 72 DPI: (numerator/denominator) inches = feet feet
        inches_on_paper = numerator / denominator
        pixels_on_paper = inches_on_paper * 72
        return pixels_on_paper / feet

    # 1:50 style
    match = re.search(r'1\s*:\s*(\d+)', text)
    if match:
        ratio = int(match.group(1))
        # At 72 DPI: 1 inch = ratio inches real = ratio/12 feet
        return 72 / (ratio / 12)

    return None
