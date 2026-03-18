"""Detects the drawing scale from OCR results and scale bar imagery."""
import re
import numpy as np


def detect_scale(ocr_results: dict, image: np.ndarray) -> float:
    """Returns pixels_per_foot ratio."""
    scale_strings = ocr_results.get("scale_strings", [])

    for text in scale_strings:
        pixels_per_foot = parse_scale_string(text)
        if pixels_per_foot:
            return pixels_per_foot

    # Fallback: estimate from image dimensions assuming standard page sizes
    height, width = image.shape[:2]
    # Assume typical 30x42" architectural D-size sheet at 72dpi
    return width / (42 * 4)  # rough fallback: 4 feet per inch of drawing


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
