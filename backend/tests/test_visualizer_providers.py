"""The image provider chain, and the two things that broke it in production.

The 2026-09-27 health check reported the visualizer down to ONE provider:
Gemini image returned 429 (Google set free-tier images to 0/min in Dec 2025)
and Replicate SDXL failed with "NSFW content detected" on a house photo.
"""
import asyncio
import inspect

import pytest

from app.services import visualizer_service as vs


def test_sdxl_no_longer_runs_the_nsfw_classifier():
    """A roof photo is not NSFW. A false positive there failed the prediction
    outright and cost the last working fallback."""
    src = inspect.getsource(vs._replicate_img2img)
    assert '"disable_safety_checker": True' in src


def test_kontext_is_tried_before_sdxl():
    src = inspect.getsource(vs._generate_image)
    assert src.index("_replicate_kontext") < src.index("_replicate_img2img"), \
        "the photo editor must be preferred over the general image generator"


def test_every_replicate_call_reads_the_key_at_call_time():
    """settings can be empty at startup on Render — the module says so at the
    top, and the SDXL path was still reading settings directly."""
    for fn in (vs._replicate_img2img, vs._replicate_kontext,
               vs._replicate_upload, vs._replicate_poll):
        assert "settings.REPLICATE_API_KEY" not in inspect.getsource(fn), fn.__name__


def test_no_text_to_image_fallback_exists():
    """A text-only render would invent a different house and put it in front of
    a homeowner as their own."""
    src = inspect.getsource(vs._generate_image)
    assert "raise ValueError" in src


# ── The tolerant Kontext request ──────────────────────────────────────────

class _Resp:
    def __init__(self, status, body=None, text=""):
        self.status_code, self._b, self.text = status, body or {}, text

    def json(self):
        return self._b

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.text)


class _Client:
    """Records each POST payload so we can assert what was retried."""
    posts: list = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, headers=None, json=None, files=None):
        if url.endswith("/files"):
            return _Resp(200, {"urls": {"get": "https://r/img.png"}})
        _Client.posts.append(json)
        # Refuse every optional input once, to prove each is dropped in turn.
        inp = json["input"]
        for k in vs._KONTEXT_OPTIONAL:
            if k in inp:
                return _Resp(422, text=f"{k} is not permitted with an input image")
        return _Resp(200, {"id": "pred1"})

    async def get(self, url, headers=None):
        return _Resp(200, {"status": "succeeded", "output": ["https://r/out.png"]})


def test_kontext_drops_inputs_replicate_refuses_instead_of_failing(monkeypatch):
    """The model's schema needs an API key to read and the key is only on
    Render, so an unknown input must degrade, not take the provider down."""
    _Client.posts = []
    monkeypatch.setattr(vs.httpx, "AsyncClient", _Client)
    monkeypatch.setenv("REPLICATE_API_KEY", "r_test")
    out = asyncio.run(vs._replicate_kontext(b"\xff\xd8\xff" + b"x" * 500,
                                            "image/jpeg", "charcoal shingles"))
    assert out == "https://r/out.png"
    # It kept retrying with fewer optional inputs, and the last try had none.
    assert len(_Client.posts) == len(vs._KONTEXT_OPTIONAL) + 1
    assert not any(k in _Client.posts[-1]["input"] for k in vs._KONTEXT_OPTIONAL)
    # The two inputs that are NOT optional must survive every retry.
    for sent in _Client.posts:
        assert sent["input"]["prompt"] and sent["input"]["input_image"]


def test_kontext_sends_an_instruction_not_sdxl_prompt_scaffolding(monkeypatch):
    _Client.posts = []
    monkeypatch.setattr(vs.httpx, "AsyncClient", _Client)
    monkeypatch.setenv("REPLICATE_API_KEY", "r_test")
    asyncio.run(vs._replicate_kontext(b"\xff\xd8\xff" + b"x" * 500,
                                      "image/jpeg", "dark gray metal roof"))
    prompt = _Client.posts[0]["input"]["prompt"]
    assert "dark gray metal roof" in prompt
    assert "negative" not in _Client.posts[0]["input"], \
        "Kontext takes an instruction; a negative prompt is SDXL's shape"
