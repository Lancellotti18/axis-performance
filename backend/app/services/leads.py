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
import re
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


_SALE_SENTENCE = re.compile(r"\s*Recently sold \([^)]*\)[^.]*\.")


def _why_without_sale(why: Optional[str]) -> str:
    """The scoring sentence, minus the part that names the sale year.

    `_score` appends "Recently sold (2024) — new owners often re-roof." That is
    a useful reason to buy, and also a precise filter for matching a listing
    against the county's public layer. Buyers get it back on the leads they own.
    """
    return _SALE_SENTENCE.sub("", why or "").strip()


def thumb_jitter(token: str) -> tuple[float, float]:
    """A small, stable offset for a lead's roof-view crop.

    The roof tile comes from a public, unauthenticated imagery endpoint, so an
    exact bbox could be reproduced for any candidate parcel and byte-compared
    until it matched — turning the roof view into a lookup of which parcel a
    listing is. Offsetting the centre by a few metres, deterministically per
    token so the image is stable between loads, breaks that comparison while
    keeping the house in frame.

    This raises the cost of correlating a listing to an address; it does not
    make it impossible, and the underlying records are public either way.
    """
    mac = hashlib.sha256((token + "|thumb").encode()).digest()
    # Two signed offsets in roughly +/-15 m, well inside the ~66 m half-frame.
    dx = (mac[0] / 255.0 - 0.5) * 0.00028
    dy = (mac[1] / 255.0 - 0.5) * 0.00028
    return dx, dy


def public_row(county: str, row: dict) -> dict:
    """An unbought lead, with every identifying field removed.

    Deliberately omits address, owner, owner_mail, lat and lng. Stripping these
    in the response — not in the UI — is the whole point: a hidden column in a
    React component is still sitting in the browser's network tab.
    """
    return {
        "token": token_for(county, str(row["pin"])),
        "city": row.get("city"),
        # No ZIP and no sale year. Both narrow the candidate set for anyone
        # trying to work out WHICH parcel a listing is by cross-referencing the
        # county's own free layer, which is the one thing the stripping is for.
        "year_built": row.get("year_built"),
        "owner_occupied": row.get("owner_occupied"),
        "score": row.get("score"),
        "tier": row.get("tier"),
        "confidence": row.get("confidence"),
        "why": _why_without_sale(row.get("why")),
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


# ── Reporting a bad lead ───────────────────────────────────────────────────
# Only reasons that can be weighed against the county's own record. "Nobody
# answered" and "not interested" are the job, not a defect.
CLAIM_REASONS = ("not_a_home", "sold_before_purchase", "record_wrong")
CLAIM_WINDOW_DAYS = 7
CLAIMS_PER_MONTH = 3
# A sale this long before the purchase is what makes owner data stale enough to
# count. Anything older is just a house that changed hands once.
STALE_SALE_MAX_MONTHS = 12


def verify_claim(reason: str, snapshot: dict, current: Optional[dict],
                 purchase_age_months: float, checked: bool = True) -> tuple[bool, dict]:
    """Does the county's record NOW corroborate this claim? (verified, evidence)

    `checked` says whether the county actually answered. That distinction is
    the whole safety of this function: "I looked and the parcel is gone" is
    evidence, while "I could not look" is not, and conflating them turns every
    county outage into free leads.

    Only a contradiction between what was sold and what the county says today
    counts. Anything this cannot settle goes to a human rather than being
    waved through or refused — a wrong automatic refusal is worse than a
    slower answer.
    """
    ev: dict = {"reason": reason, "county_checked": checked,
                "found_in_county": current is not None,
                "purchase_age_months": round(purchase_age_months, 1)}

    if not checked:
        ev["note"] = "the county service could not be reached, so nothing is proven either way"
        return False, ev

    if reason == "not_a_home":
        # The parcel no longer comes back from the county's residential query.
        ev["note"] = ("absent from the county's residential results"
                      if current is None else "still listed as residential")
        return current is None, ev

    if current is None:
        ev["note"] = "parcel not in the county's current results, so the claim can't be checked"
        return False, ev

    if reason == "record_wrong":
        for field in ("address", "owner"):
            was, now = snapshot.get(field), current.get(field)
            if was and now and str(was).strip().upper() != str(now).strip().upper():
                ev.update({"field": field, "sold_as": was, "county_now": now})
                return True, ev
        ev["note"] = "address and owner still match what was sold"
        return False, ev

    if reason == "sold_before_purchase":
        sold_months = current.get("sold_months")
        if sold_months is None:
            ev["note"] = "this county doesn't publish sale dates"
            return False, ev
        months_before = sold_months - purchase_age_months
        ev.update({"sold_months_ago": sold_months,
                   "months_before_purchase": round(months_before, 1),
                   "sold_year_at_sale": snapshot.get("sold_year"),
                   "sold_year_now": current.get("sold_year")})

        # The claim is that the owner on the record was already out of date when
        # the lead was sold. That is only true if the county has since published
        # a sale it was not showing at the time — if the same sale was already
        # on the record, the buyer could see it and bought anyway.
        #
        # Without this test the window would start exactly where the pre-sale
        # filter stops (sellable() refuses a sale inside RECENT_SALE_MONTHS),
        # so every lead sold 3-12 months ago would be both sold as good and
        # auto-certified as a dud.
        sale_is_news = (snapshot.get("sold_year") != current.get("sold_year")
                        or (snapshot.get("sold_months") is None and sold_months is not None))
        if not sale_is_news:
            ev["note"] = ("the same sale was already on the record when this lead was sold, "
                          "so it was visible at purchase")
            return False, ev
        if months_before <= 0:
            ev["note"] = "the sale is dated after the purchase"
            return False, ev
        if months_before > STALE_SALE_MAX_MONTHS:
            ev["note"] = "the sale is too old to have made the record stale"
            return False, ev
        return True, ev

    ev["note"] = "unknown reason"
    return False, ev
