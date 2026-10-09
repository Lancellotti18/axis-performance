"""Transactional email: the promo welcome and the promo-ended note.

Sent through Resend's HTTP API (https://resend.com). Inert until
RESEND_API_KEY is set: every email is logged instead of sent, so the promo
flow can ship and be tested before an email provider is configured.

Tone follows the outreach rules Ryan settled on: written as one person ("I",
never "we"), plain, no hype.
"""
from __future__ import annotations

import html
import logging
from typing import Optional

logger = logging.getLogger(__name__)

RESEND_URL = "https://api.resend.com/emails"


def configured() -> bool:
    from app.core.config import settings
    return bool(settings.RESEND_API_KEY)


def send(to: str, subject: str, text: str) -> bool:
    """Send one plain email. Returns True only if the provider accepted it.
    Never raises: a failed email must not fail the request that triggered it."""
    from app.core.config import settings
    if not to or "@" not in to:
        return False
    if not settings.RESEND_API_KEY:
        logger.info("email (not sent, RESEND_API_KEY unset) to=%s subject=%r", to, subject)
        return False
    try:
        import httpx
        body = {"from": settings.EMAIL_FROM, "to": [to], "subject": subject, "text": text,
                "html": "<div style=\"font-family:Arial,sans-serif;font-size:15px;line-height:1.5\">"
                        + html.escape(text).replace("\n", "<br>") + "</div>"}
        if settings.EMAIL_REPLY_TO:
            body["reply_to"] = settings.EMAIL_REPLY_TO
        r = httpx.post(RESEND_URL, json=body, timeout=15,
                       headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}"})
        if r.status_code >= 300:
            logger.warning("email to %s failed: %s %s", to, r.status_code, r.text[:200])
            return False
        return True
    except Exception as e:
        logger.warning("email to %s failed: %s", to, e)
        return False


def _site() -> str:
    from app.core.config import settings
    return (settings.FRONTEND_URL or "https://axisroofingperformance.com").rstrip("/")


def promo_welcome(company: Optional[str], reports: int, days: int, until_text: str) -> tuple[str, str]:
    """(subject, text) for the email sent right after a code is redeemed."""
    who = f" for {company}" if company else ""
    return (
        "You're in - your Axis trial is active",
        f"Hi there,\n\n"
        f"Thank you for redeeming your code{who}. Your account is set up and your trial is active.\n\n"
        f"What you have:\n"
        f"- {reports} free roof reports\n"
        f"- Full access to Axis for {days} days, until {until_text}\n"
        f"- Founding member status, so today's pricing stays locked in for you when you subscribe\n\n"
        f"To get started, log in, enter the address of a roof you're bidding, confirm the house, "
        f"and Axis measures it and builds the report and material list.\n\n"
        f"{_site()}/dashboard\n\n"
        f"If anything is unclear or doesn't look right, reply to this email - it comes straight to me.\n\n"
        f"Ryan Lancellotti\n"
        f"Axis Performance - Wilmington, NC\n\n"
        f"Axis Performance is a product of RW AI Infrastructure LLC, Wilmington, NC",
    )


def promo_ended(reports_used: int) -> tuple[str, str]:
    """(subject, text) for the email sent once a trial ends."""
    used = (f"You ran {reports_used} report{'s' if reports_used != 1 else ''} during it. "
            if reports_used else "")
    return (
        "Thank you for trying Axis",
        f"Hi there,\n\n"
        f"Thank you for trying Axis - your free trial has now ended. {used}"
        f"I hope it saved you some time on your bids.\n\n"
        f"To keep measuring roofs, building reports and material lists, choose a plan here:\n\n"
        f"{_site()}/dashboard\n\n"
        f"As a founding member, the pricing you see today stays locked in for as long as "
        f"you're subscribed.\n\n"
        f"If you have questions, or something didn't work the way you expected, just reply - "
        f"I read every one.\n\n"
        f"Ryan Lancellotti\n"
        f"Axis Performance - Wilmington, NC\n\n"
        f"Axis Performance is a product of RW AI Infrastructure LLC, Wilmington, NC",
    )
