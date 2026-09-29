"""Turn whatever a contractor uploads into images the rest of Axis can use.

Phones produce HEIC, office scanners produce PDF, older tools produce BMP,
TIFF or GIF. Every image endpoint used to keep its own allow-list, and they
drifted: the ground-photo upload took all of these while the Roof Visualizer
rejected an iPhone photo outright with "must be a JPG, PNG, or WebP". One
converter, shared, so an upload that works in one place works in all of them.

Format is decided from the BYTES, never the browser's Content-Type, which is
missing or wrong often enough (an empty type for HEIC on Chrome, image/pjpeg
from older Windows apps) to reject perfectly good files.
"""
from __future__ import annotations

import io
from typing import Optional

# Long edge after conversion. Phone photos are 4000px+; nothing downstream
# (vision models, image generation) benefits from more than this, and it keeps
# uploads and base64 responses a sensible size.
MAX_EDGE_PX = 2048

# PDFs are rasterised at this DPI — enough to read a gable end or a site photo
# embedded in an inspection report without producing a 40 MB bitmap.
PDF_DPI = 200


def is_pdf(raw: bytes) -> bool:
    return raw[:5] == b"%PDF-"


def normalize_image(raw: bytes) -> tuple[Optional[bytes], str]:
    """Any single image Pillow can read (plus HEIC/HEIF) -> (jpeg_bytes, mime).

    Returns (None, '') only when the bytes are not a readable image.
    """
    try:
        from PIL import Image

        # HEIC/HEIF is the iPhone default. Best-effort: everything else still
        # works if the plugin is missing.
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except Exception:
            pass

        im = Image.open(io.BytesIO(raw))
        im = im.convert("RGB")
        if max(im.size) > MAX_EDGE_PX:
            im.thumbnail((MAX_EDGE_PX, MAX_EDGE_PX))
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=88)
        return out.getvalue(), "image/jpeg"
    except Exception:
        # Pillow could not decode it. Pass through only if the magic bytes are
        # already a format every downstream consumer accepts.
        if raw[:3] == b"\xff\xd8\xff":
            return raw, "image/jpeg"
        if raw[:8] == b"\x89PNG\r\n\x1a\n":
            return raw, "image/png"
        if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
            return raw, "image/webp"
        return None, ""


def normalize_to_images(raw: bytes, max_pages: int) -> tuple[list[tuple[bytes, str]], bool]:
    """Expand an upload into a list of usable images.

    PDF   -> one image per page, rasterised, capped at `max_pages`.
    image -> a single-element list.

    Returns (images, truncated) where `truncated` means a PDF had more pages
    than the cap. An empty list means nothing in the file was readable.
    """
    if is_pdf(raw):
        try:
            import fitz  # PyMuPDF
            doc = fitz.open(stream=raw, filetype="pdf")
            total = doc.page_count
            images: list[tuple[bytes, str]] = []
            scale = PDF_DPI / 72
            for i in range(min(total, max_pages)):
                pix = doc.load_page(i).get_pixmap(matrix=fitz.Matrix(scale, scale))
                norm, mt = normalize_image(pix.tobytes("png"))
                if norm is not None:
                    images.append((norm, mt))
            doc.close()
            return images, total > max_pages
        except Exception:
            return [], False

    norm, mt = normalize_image(raw)
    return ([(norm, mt)] if norm is not None else []), False
