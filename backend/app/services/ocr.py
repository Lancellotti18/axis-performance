"""OCR service — extracts text, dimension strings, and room labels from blueprints."""
import cv2
import numpy as np
import re

try:
    from paddleocr import PaddleOCR
    ocr_engine = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
    USE_PADDLE = True
except ImportError:
    import pytesseract
    USE_PADDLE = False


def extract_text_and_dimensions(image: np.ndarray) -> dict:
    results = {"raw_text": [], "dimensions": [], "room_labels": [], "scale_strings": []}

    if USE_PADDLE:
        output = ocr_engine.ocr(image, cls=True)
        if output and output[0]:
            for line in output[0]:
                text = line[1][0].strip()
                results["raw_text"].append(text)
                _classify_text(text, results)
    else:
        text = pytesseract.image_to_string(image)
        for line in text.split("\n"):
            line = line.strip()
            if line:
                results["raw_text"].append(line)
                _classify_text(line, results)

    return results


def _classify_text(text: str, results: dict):
    # Dimension pattern: 12'-6", 12'6", 12.5', 2400mm
    dim_pattern = r"\d+[\'-]\s*\d*[\"]?"
    if re.search(dim_pattern, text):
        results["dimensions"].append(text)

    # Scale pattern
    scale_pattern = r"(\d+/\d+|\d+)\s*[\"\'=]?\s*=\s*\d+[\'-]"
    if re.search(scale_pattern, text, re.IGNORECASE) or "scale" in text.lower():
        results["scale_strings"].append(text)

    # Room labels (common room names)
    room_keywords = ["bedroom", "bathroom", "kitchen", "living", "dining",
                     "garage", "office", "laundry", "closet", "hall", "entry", "bath", "bed"]
    if any(kw in text.lower() for kw in room_keywords):
        results["room_labels"].append(text)
