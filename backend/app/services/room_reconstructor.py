"""Reconstructs room polygons from wall line segments."""
import cv2
import numpy as np
import math
from typing import List


def reconstruct_rooms(image: np.ndarray, pixels_per_foot: float, detections: dict) -> List[dict]:
    """Extract room polygons using contour analysis on wall lines."""
    rooms = []

    # Detect walls via edge detection + line detection
    edges = cv2.Canny(image, 50, 150, apertureSize=3)
    kernel = np.ones((3, 3), np.uint8)
    dilated = cv2.dilate(edges, kernel, iterations=2)

    # Find contours (room outlines)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_area = (pixels_per_foot * 5) ** 2  # minimum 5x5 foot room
    room_names = ["Room 1", "Room 2", "Room 3", "Room 4", "Room 5",
                  "Room 6", "Room 7", "Room 8", "Room 9", "Room 10"]
    room_idx = 0

    for contour in contours:
        area_px = cv2.contourArea(contour)
        if area_px < min_area:
            continue

        # Convert pixel area to square feet
        sqft = area_px / (pixels_per_foot ** 2)
        if sqft < 25 or sqft > 10000:  # filter unrealistic sizes
            continue

        # Get bounding rect for dimensions
        x, y, w, h = cv2.boundingRect(contour)
        width_ft = w / pixels_per_foot
        height_ft = h / pixels_per_foot

        rooms.append({
            "name": room_names[room_idx % len(room_names)],
            "sqft": round(sqft, 1),
            "dimensions": {
                "width": round(width_ft, 1),
                "height": round(height_ft, 1)
            },
            "bbox": [int(x), int(y), int(x+w), int(y+h)],
        })
        room_idx += 1

    return rooms
