"""Free-trial requests from the homepage.

Replaces "new accounts get a free report": there is no automatic free report
any more (Ryan, 2026-10-08), so a visitor who wants to try Axis leaves their
details, Ryan gets an email he can reply to, creates a code on /founders and
sends it back. The visitor gets a thank-you straight away.

Public and unauthenticated, so it is guarded like the other public forms: a
honeypot field, a per-visitor hourly limit, and a global hourly cap so a flood
cannot burn the email quota. Nothing is stored; the email IS the record.
"""
from __future__ import annotations

import logging
import re
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from app.core.ratelimit import rate_ok

logger = logging.getLogger(__name__)
router = APIRouter()

_EMAIL = re.compile(r"^[^@\s<>\"']{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$")


def _clean(v: str) -> str:
    # One line of plain text: no header or line injection into the emails.
    return re.sub(r"[\r\n\t]+", " ", v or "").strip()


class TrialRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    email: str = Field(..., min_length=5, max_length=254)
    company: str = Field(..., min_length=1, max_length=120)
    phone: str = Field(..., min_length=7, max_length=32)
    website: Optional[str] = Field(None, max_length=200)   # honeypot: people never see it

    @field_validator("name", "company", "phone")
    @classmethod
    def _one_line(cls, v: str) -> str:
        v = _clean(v)
        if not v:
            raise ValueError("required")
        return v

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        if len(re.sub(r"\D", "", v)) < 7 or not re.fullmatch(r"[0-9+()\-. x]+", v):
            raise ValueError("enter a phone number")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = _clean(v)
        if not _EMAIL.match(v):
            raise ValueError("enter a valid email address")
        return v


def _visitor(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()[:64] or "?"
    return (request.client.host if request.client else "?") or "?"


@router.post("/trial")
async def request_trial(body: TrialRequest, request: Request) -> dict:
    if body.website:
        return {"ok": True}                                    # swallow bots quietly
    if not rate_ok(f"trial-{_visitor(request)}", max_per_hour=3):
        raise HTTPException(status_code=429, detail="Too many requests — please try again later.")
    if not rate_ok("trial-all", max_per_hour=40):
        raise HTTPException(status_code=429, detail="We're getting a lot of requests — please try again shortly.")

    from app.core.config import settings
    from app.services import email_service as es

    subject, text = es.trial_request_owner(body.name, body.email, body.company, body.phone)
    # Replying to Ryan's copy goes straight to the person who asked.
    if not es.send(settings.INQUIRY_TO, subject, text, reply_to=body.email):
        logger.warning("trial request NOT delivered to the owner: %s / %s", body.company, body.email)
        raise HTTPException(status_code=503,
                            detail="We couldn't send that just now. Please email lance@rwinfrastructure.com.")
    subject, text = es.trial_request_thanks(body.name)
    es.send(body.email, subject, text)
    return {"ok": True}
