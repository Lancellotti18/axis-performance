"""Exclusive leads: what a browsing contractor may see, and what is for sale.

Find Roofs used to hand over every prospect in a county — owner name, mailing
address, coordinates — to anyone with an account. This module is the line
between browsing and buying:

  * `public_row` is what an unbought lead looks like. No address, no owner, no
    coordinates. The score and the age band are the things Axis adds and the
    things being sold; the underlying parcel record stays with the county.
  * `token_for` gives each parcel an opaque, stable handle so the app can say
    "buy that one" without the API ever naming the parcel.
  * `sellable` is the dud filter. A lead that fails it is never offered, which
    is cheaper for everyone than selling it and handling the complaint.

Worth being clear-eyed about what this does and does not protect: these are
public county records, and anyone can query the same ArcGIS endpoints directly
for free. Stripping the response does not make the data secret. What a buyer is
actually paying for is the scoring and the exclusivity — the guarantee, enforced
by a unique index, that nobody else is sold the same parcel.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

TOKEN_PREFIX = "lp_"
# A sale inside this window means the roof decision is already made or the new
# owner has barely moved in. Ryan's rule: filter these out before sale.
RECENT_SALE_MONTHS = 2


def _secret() -> bytes:
    from app.core.config import settings
    return (settings.SECRET_KEY or "").encode() or b"axis-leads"


def token_for(county: str, pin: str) -> str:
    """An opaque handle for one parcel.

    Deterministic, so the same parcel keeps the same token between searches and
    an already-sold lead can be filtered out by token. One-way, so the response
    never carries the county's own parcel id: handing that over would be handing
    over the lookup key to the full record for free.
    """
    mac = hmac.new(_secret(), f"{county}|{pin}".encode(), hashlib.sha256).digest()
    return TOKEN_PREFIX + base64.urlsafe_b64encode(mac)[:22].decode()


def valid_token(token: Optional[str]) -> bool:
    return bool(token) and str(token).startswith(TOKEN_PREFIX) and len(str(token)) == len(TOKEN_PREFIX) + 22


def match_token(county: str, token: str, rows: Iterable[dict]) -> Optional[dict]:
    """Find the parcel a token refers to, comparing in constant time.

    The caller re-queries the county first, so a purchase is always settled
    against data fetched seconds ago rather than whatever the browser was
    holding. That matters for the dud filter: a house that sold last week must
    not be sold as a lead because someone's tab was open yesterday.
    """
    for r in rows:
        pin = r.get("pin")
        if pin is None:
            continue
        if hmac.compare_digest(token_for(county, str(pin)), str(token)):
            return r
    return None


def sellable(row: dict) -> tuple[bool, str]:
    """May this parcel be offered for sale? (ok, reason_if_not)

    Duds are prevented here rather than refunded later. The county's own
    residential filter already runs in the query; this catches what it cannot.
    """
    if not row.get("address"):
        return False, "no street address on the record"
    sold_months = row.get("sold_months")
    if sold_months is not None and sold_months <= RECENT_SALE_MONTHS:
        return False, "sold within the last two months"
    return True, ""


def public_row(county: str, row: dict) -> dict:
    """An unbought lead, with every identifying field removed.

    Deliberately omits address, owner, owner_mail, lat and lng. Stripping these
    in the response — not in the UI — is the whole point: a hidden column in a
    React component is still sitting in the browser's network tab.
    """
    return {
        "token": token_for(county, str(row["pin"])),
        "city": row.get("city"),
        "zip": row.get("zip"),
        "year_built": row.get("year_built"),
        "owner_occupied": row.get("owner_occupied"),
        "score": row.get("score"),
        "tier": row.get("tier"),
        "confidence": row.get("confidence"),
        "why": row.get("why"),
        "owned": False,
    }


def owned_row(county: str, row: dict) -> dict:
    """A lead this account has already paid for: everything, plus its token."""
    return {**row, "token": token_for(county, str(row["pin"])), "owned": True}


def snapshot_of(row: dict) -> dict:
    """What gets frozen into purchased_leads.snapshot at the moment of sale.

    Counties rewrite their data. A contractor must still be able to see what
    they actually paid for a year from now, so the row carries its own copy
    rather than a pointer into someone else's database.
    """
    keep = ("address", "city", "zip", "owner", "owner_mail", "owner_occupied",
            "year_built", "sold_year", "sold_months", "tax_value", "lat", "lng",
            "score", "tier", "confidence", "why")
    return {k: row.get(k) for k in keep if row.get(k) is not None}


def taken_pins(db, county: str, me: Optional[str] = None) -> tuple[set[str], set[str]]:
    """(pins nobody else may buy, pins THIS account already owns).

    A pending row counts as taken: the reservation is what stops two
    contractors paying for the same parcel. Failed and refunded purchases fall
    out of the partial unique index and so return to the pool here too.
    """
    try:
        rows = (db.table("purchased_leads")
                .select("prospect_pin,user_id,status")
                .eq("source_county", county)
                .in_("status", ["pending", "succeeded"])
                .execute().data) or []
    except Exception as e:                      # a lead list is better than a 500
        logger.warning("could not read purchased leads for %s: %s", county, e)
        return set(), set()
    taken = {str(r["prospect_pin"]) for r in rows}
    mine = {str(r["prospect_pin"]) for r in rows
            if me and str(r.get("user_id")) == str(me) and r.get("status") == "succeeded"}
    return taken, mine
