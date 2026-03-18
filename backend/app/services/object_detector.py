"""YOLOv8 object detection for architectural symbols."""
import numpy as np
import logging

logger = logging.getLogger(__name__)

# Architectural symbol classes
ARCH_CLASSES = [
    "door", "window", "outlet", "switch", "panel",
    "toilet", "sink", "bathtub", "shower",
    "stair", "column", "beam", "fireplace"
]


def detect_objects(image: np.ndarray) -> dict:
    """Run YOLOv8 detection on blueprint image."""
    try:
        from ultralytics import YOLO
        model = YOLO("yolov8n.pt")  # will use custom model when trained
        results = model(image, verbose=False)
        return parse_yolo_results(results)
    except Exception as e:
        logger.warning(f"Object detection failed: {e}, using fallback")
        return _fallback_detection(image)


def parse_yolo_results(results) -> dict:
    detections = {cls: [] for cls in ARCH_CLASSES}
    for r in results:
        for box in r.boxes:
            cls_name = r.names[int(box.cls)]
            if cls_name in detections:
                detections[cls_name].append({
                    "bbox": box.xyxy[0].tolist(),
                    "confidence": float(box.conf),
                })
    return detections


def _fallback_detection(image: np.ndarray) -> dict:
    """Basic OpenCV-based detection when YOLO is unavailable."""
    import cv2
    detections = {cls: [] for cls in ARCH_CLASSES}

    # Detect door swing arcs using circle/arc detection
    circles = cv2.HoughCircles(
        image, cv2.HOUGH_GRADIENT, dp=1, minDist=20,
        param1=50, param2=30, minRadius=10, maxRadius=50
    )
    if circles is not None:
        for circle in circles[0]:
            detections["door"].append({
                "bbox": [float(circle[0]-circle[2]), float(circle[1]-circle[2]),
                         float(circle[0]+circle[2]), float(circle[1]+circle[2])],
                "confidence": 0.5,
            })

    return detections
