"""The street photo is how a contractor confirms which house they are measuring,
so a photo of the neighbour's house is worse than no photo. These pin the two
calls to the same camera and the honesty fields that let the UI say when the
photo is doubtful."""
import pytest

from app.api.v1 import roofing_v2 as rv
from app.core.config import settings
from app.services import footprint_service


class _Resp:
    def __init__(self, payload=None, content=b"\xff\xd8jpeg"):
        self._payload = payload
        self.content = content
        self.headers = {"content-type": "image/jpeg"}

    def json(self):
        return self._payload

    def raise_for_status(self):
        pass


def _fake_client(calls, pano_lat, pano_lng):
    class Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params=None):
            calls.append((url, dict(params or {})))
            if url.endswith("/metadata"):
                return _Resp({"status": "OK", "pano_id": "PANO123", "date": "2019-05",
                              "location": {"lat": pano_lat, "lng": pano_lng}})
            return _Resp()
    return Client


async def _run(monkeypatch, pano_lat, pano_lng, lat=34.2000, lng=-77.9000):
    import httpx
    calls = []
    rv._SV_CACHE.clear()
    monkeypatch.setattr(settings, "GOOGLE_SOLAR_API_KEY", "k", raising=False)
    monkeypatch.setattr(httpx, "AsyncClient", _fake_client(calls, pano_lat, pano_lng))

    async def fake_fp(a, b):
        ring = [{"lat": lat + dy, "lng": lng + dx}
                for dy, dx in ((0, 0), (0, 0.0001), (0.0001, 0.0001), (0.0001, 0))]
        return {"available": True, "confident": True, "ring": ring}
    monkeypatch.setattr(footprint_service, "get_building_footprint", fake_fp)

    out = await rv.street_view(lat=lat, lng=lng, user={"id": "u"})
    return out, calls


@pytest.mark.asyncio
async def test_image_is_pinned_to_the_panorama_the_heading_was_computed_from(monkeypatch):
    out, calls = await _run(monkeypatch, 34.19985, -77.89990)
    (meta_url, meta), (img_url, img) = calls
    assert meta_url.endswith("/metadata")
    # Both calls must pick from the same pool of cameras...
    assert meta["source"] == "outdoor"
    # ...and the image must come from exactly that camera, not a re-pick.
    assert img["pano"] == "PANO123"
    assert "location" not in img
    assert out["available"] and out["date"] == "2019-05"
    assert "pano=PANO123" in out["pano_url"]


@pytest.mark.asyncio
async def test_a_camera_on_the_next_street_is_flagged(monkeypatch):
    close, _ = await _run(monkeypatch, 34.19985, -77.89990)       # ~15 m
    assert close["far"] is False

    far, _ = await _run(monkeypatch, 34.20080, -77.90000)         # ~90 m
    assert far["far"] is True
    assert far["distance_m"] > rv._SV_FAR_METRES
