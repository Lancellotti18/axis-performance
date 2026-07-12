"""Speed-to-lead SMS via Twilio's REST API (plain httpx, no SDK dependency).

78% of homeowners hire the first contractor who responds — this closes the
gap by texting the contractor the moment a scored lead lands, and sending
the homeowner a confirmation so the conversation is already warm.

Entirely env-gated: if TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
TWILIO_FROM_NUMBER aren't all set, every function is a silent no-op that
returns False. SMS must NEVER break or slow lead capture — callers should
fire-and-forget (asyncio.create_task) or swallow failures.

Compliance notes (TCPA/CTIA):
- The homeowner text is a single transactional reply to their own quote
  request (they submitted their number asking to be contacted) — not
  marketing, no recurring cadence. Includes the business name.
- The contractor text goes to the account owner about their own lead.
"""
from __future__ import annotations

import logging
import re

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

_TWILIO_URL = "https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"


def sms_configured() -> bool:
    return bool(
        settings.TWILIO_ACCOUNT_SID
        and settings.TWILIO_AUTH_TOKEN
        and settings.TWILIO_FROM_NUMBER
    )


def _normalize_phone(raw: str | None) -> str | None:
    """Best-effort E.164 for US numbers; returns None if it can't be one."""
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 10:
        return "+1" + digits
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    if raw.strip().startswith("+") and 8 <= len(digits) <= 15:
        return "+" + digits
    return None


async def send_sms(to: str | None, body: str) -> bool:
    """Send one SMS. Returns True on 2xx from Twilio, False otherwise.
    Never raises."""
    if not sms_configured():
        return False
    to_e164 = _normalize_phone(to)
    if not to_e164 or not body:
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                _TWILIO_URL.format(sid=settings.TWILIO_ACCOUNT_SID),
                auth=(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN),
                data={
                    "From": settings.TWILIO_FROM_NUMBER,
                    "To": to_e164,
                    "Body": body[:1500],
                },
            )
        if resp.status_code // 100 == 2:
            return True
        logger.warning("twilio send failed (%s): %s", resp.status_code, resp.text[:200])
        return False
    except Exception as e:
        logger.warning("twilio send errored: %s", e)
        return False


async def notify_new_lead(
    *,
    contractor_phone: str | None,
    homeowner_phone: str | None,
    company_name: str,
    lead_name: str,
    address: str,
    score: int | None,
    price_low: float | None,
    price_high: float | None,
    frontend_url: str | None = None,
    report_token: str | None = None,
) -> dict:
    """The speed-to-lead pair: alert the contractor, confirm to the homeowner.
    Returns {"contractor": bool, "homeowner": bool} — purely informational."""
    results = {"contractor": False, "homeowner": False}
    if not sms_configured():
        return results

    base = (frontend_url or settings.FRONTEND_URL).rstrip("/")

    score_bit = f" — score {score}/100" if score is not None else ""
    price_bit = (
        f" (saw ${price_low:,.0f}–${price_high:,.0f})"
        if price_low and price_high else ""
    )
    link_bit = f"\nReport: {base}/r/{report_token}" if report_token else ""
    contractor_msg = (
        f"🎯 New Axis lead{score_bit}: {lead_name}, {address}{price_bit}."
        f"{link_bit}\nReply fast — most homeowners hire the first responder."
    )
    results["contractor"] = await send_sms(contractor_phone, contractor_msg)

    homeowner_msg = (
        f"Hi {lead_name.split(' ')[0]}, this is {company_name}. We got your "
        f"roof quote request for {address} and will call you shortly. "
        f"Questions in the meantime? Just reply here."
    )
    results["homeowner"] = await send_sms(homeowner_phone, homeowner_msg)
    return results
