"""Homepage free-trial requests: Ryan gets a reply-able email, the visitor gets
a thank-you, and the public form is guarded against bots and floods."""
import asyncio

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.v1 import inquiry
from app.core import ratelimit
from app.services import email_service as es


class _Req:
    def __init__(self, ip="1.2.3.4"):
        self.headers = {"x-forwarded-for": ip}
        self.client = None


GOOD = dict(name="Kevin Smith", email="kevin@alpharoofs.com", company="Alpha Roofing",
            phone="(910) 555-0123")


@pytest.fixture
def sent(monkeypatch):
    ratelimit._BUCKETS.clear()
    out = []
    monkeypatch.setattr(es, "send", lambda to, subject, text, reply_to=None:
                        out.append((to, subject, text, reply_to)) or True)
    return out


def _post(ip="1.2.3.4", **kw):
    return asyncio.run(inquiry.request_trial(inquiry.TrialRequest(**{**GOOD, **kw}), _Req(ip)))


def test_ryan_gets_the_details_and_can_reply_straight_to_them(sent):
    assert _post()["ok"] is True
    to, subject, text, reply_to = sent[0]
    assert to == "lance@rwinfrastructure.com"
    assert "Alpha Roofing" in subject
    for v in GOOD.values():
        assert v in text
    assert reply_to == "kevin@alpharoofs.com"


def test_the_visitor_gets_the_thank_you(sent):
    _post()
    to, subject, text, _ = sent[1]
    assert to == "kevin@alpharoofs.com"
    assert "Hi Kevin" in text
    assert "find the axis your business turns on" in text
    assert "in touch" in text


def test_a_bot_filling_the_hidden_field_sends_nothing(sent):
    assert _post(website="http://spam.example")["ok"] is True
    assert sent == []


def test_one_visitor_is_limited(sent):
    for _ in range(3):
        _post()
    with pytest.raises(HTTPException) as e:
        _post()
    assert e.value.status_code == 429


def test_line_breaks_cannot_be_smuggled_into_the_emails(sent):
    _post(company="Alpha\r\nBcc: victim@example.com")
    assert "\n" not in sent[0][1] and "\r" not in sent[0][1]


@pytest.mark.parametrize("field,value", [("email", "not-an-email"), ("phone", "call me"),
                                         ("name", "   "), ("email", "a@b.c\nx")])
def test_bad_input_is_refused(field, value):
    with pytest.raises(ValidationError):
        inquiry.TrialRequest(**{**GOOD, field: value})


def test_an_undelivered_request_tells_the_visitor(monkeypatch):
    ratelimit._BUCKETS.clear()
    monkeypatch.setattr(es, "send", lambda *a, **k: False)
    with pytest.raises(HTTPException) as e:
        _post()
    assert e.value.status_code == 503
