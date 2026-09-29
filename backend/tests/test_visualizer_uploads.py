"""The Roof Visualizer accepts what a contractor's phone or scanner produces.

It used to allow exactly three MIME types and trust the browser's word for
which one it had, so an iPhone photo — offered by the page's own picker — was
refused with "File must be a JPG, PNG, or WebP image". These build real files
in each format and push them through the endpoint.
"""
import asyncio
import io

import pytest
from fastapi import HTTPException
from PIL import Image


def _photo(fmt: str, size=(640, 480)) -> bytes:
    im = Image.new("RGB", size, (120, 90, 60))
    # Some texture, so compressed formats are not suspiciously tiny.
    for x in range(0, size[0], 7):
        for y in range(0, size[1], 5):
            im.putpixel((x, y), ((x * 3) % 255, (y * 5) % 255, 40))
    buf = io.BytesIO()
    if fmt == "HEIF":
        import pillow_heif
        pillow_heif.register_heif_opener()
    im.save(buf, format=fmt)
    return buf.getvalue()


def _pdf(pages=2) -> bytes:
    import fitz
    doc = fitz.open()
    for i in range(pages):
        page = doc.new_page(width=612, height=792)
        page.insert_image(fitz.Rect(50, 50, 562, 434), stream=_photo("PNG"))
        page.insert_text((60, 470), f"Inspection photo, page {i + 1}")
    out = doc.tobytes()
    doc.close()
    return out


class _Upload:
    """Stand-in for UploadFile. content_type is deliberately wrong or empty in
    places, because browsers really do send that — the bytes must decide."""
    def __init__(self, data: bytes, content_type: str = ""):
        self._d, self.content_type = data, content_type

    async def read(self):
        return self._d


def _call(data: bytes, content_type: str = "", monkeypatch=None):
    from app.api.v1 import visualizer
    seen = {}

    async def fake_generate(**kw):
        seen.update(kw)
        return {"generated_image_url": "https://x/after.png", "cost_estimate": {}}

    monkeypatch.setattr("app.services.visualizer_service.generate_visualization",
                        fake_generate)
    out = asyncio.run(visualizer.generate_home_visualization(
        file=_Upload(data, content_type), description="charcoal shingles",
        city="Wilmington", state="nc", user={"id": "u1"}))
    return out, seen


@pytest.mark.parametrize("fmt,declared", [
    ("JPEG", "image/jpeg"),
    ("PNG", "image/png"),
    ("WEBP", "image/webp"),
    ("HEIF", ""),                 # Chrome sends no type for HEIC
    ("HEIF", "image/heic"),
    ("GIF", "image/gif"),
    ("BMP", "image/bmp"),
    ("TIFF", "image/tiff"),
    ("JPEG", "image/pjpeg"),      # older Windows apps
    ("PNG", "application/octet-stream"),
])
def test_common_image_formats_are_accepted(fmt, declared, monkeypatch):
    out, seen = _call(_photo(fmt), declared, monkeypatch)
    # The generator always receives a decoded JPEG, whatever came in.
    assert seen["content_type"] == "image/jpeg"
    assert seen["image_bytes"][:3] == b"\xff\xd8\xff"
    assert out["source_image_url"].startswith("data:image/jpeg;base64,")
    assert out["source_from_pdf"] is False


def test_a_pdf_uses_its_first_page(monkeypatch):
    out, seen = _call(_pdf(pages=3), "application/pdf", monkeypatch)
    assert seen["image_bytes"][:3] == b"\xff\xd8\xff"
    assert out["source_from_pdf"] is True
    im = Image.open(io.BytesIO(seen["image_bytes"]))
    assert max(im.size) <= 2048, "rasterised pages must be downscaled"


def test_a_huge_phone_photo_is_downscaled(monkeypatch):
    _, seen = _call(_photo("JPEG", size=(4032, 3024)), "image/jpeg", monkeypatch)
    assert max(Image.open(io.BytesIO(seen["image_bytes"])).size) == 2048


def test_a_non_image_is_refused_with_a_readable_message(monkeypatch):
    with pytest.raises(HTTPException) as e:
        _call(b"this is not an image at all " * 100, "image/jpeg", monkeypatch)
    assert e.value.status_code == 422
    assert "PDF" in e.value.detail and "HEIC" in e.value.detail


def test_an_empty_file_is_refused(monkeypatch):
    with pytest.raises(HTTPException) as e:
        _call(b"\xff\xd8\xff", "image/jpeg", monkeypatch)
    assert e.value.status_code == 422


def test_the_roofing_ground_photo_path_still_expands_pdfs_per_page():
    """roofing_v2 now delegates to the shared converter; its behaviour — one
    image per page, capped — must not change."""
    from app.api.v1.roofing_v2 import _normalize_to_images
    images, truncated = _normalize_to_images(_pdf(pages=3))
    assert len(images) == 3 and truncated is False
