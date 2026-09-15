"""Every API route is authenticated unless it is on the public allowlist.

The point of this test is not to check the routers once — it is to make adding
an unauthenticated route a test failure rather than a silent deploy. That is how
`POST /api/v1/billing/portal?customer_id=...` sat mounted and wide open: it took
a Stripe customer id with no auth and returned that customer's billing-portal
URL, and nothing anywhere would have told us.

To add a genuinely public route, add it to PUBLIC below **with the reason it
cannot carry a JWT**. If you cannot write that reason, it is not a public route.
"""
from __future__ import annotations

from fastapi.routing import APIRoute

from app.main import app
from app.core.auth import get_current_user, require_user

# Public by necessity. Each of these is reached by someone who has no account:
# a homeowner following a link, or a browser image request that cannot attach a
# bearer token. Every one is gated by an unguessable token or widget key, except
# the tile proxy, which is gated by an SSRF host allowlist instead.
PUBLIC = {
    # A homeowner books from the report link they were emailed.
    ("POST", "/api/v1/appointments/book/{report_token}"),
    # Instant-quote widget, embedded on the contractor's public site.
    ("GET", "/api/v1/instant-quote/w/{widget_key}"),
    ("POST", "/api/v1/instant-quote/w/{widget_key}/locate"),
    ("POST", "/api/v1/instant-quote/w/{widget_key}/quote"),
    ("POST", "/api/v1/instant-quote/w/{widget_key}/lead"),
    ("POST", "/api/v1/instant-quote/w/{widget_key}/event"),
    # The homeowner's own instant report + colour choice.
    ("GET", "/api/v1/instant-quote/report/{token}"),
    ("POST", "/api/v1/instant-quote/report/{token}/select-color"),
    # Shared photo and proposal links.
    ("GET", "/api/v1/project-photos/public/{token}"),
    ("GET", "/api/v1/roof-proposals/public/{token}"),
    ("POST", "/api/v1/roof-proposals/public/{token}/accept"),
    # Same-origin satellite tile proxy: an <img crossorigin> request cannot
    # carry a JWT. Locked to allowlisted tile hosts (SSRF guard) instead.
    ("GET", "/api/v1/roofing/v2/imagery/proxy"),
    # The public pricing page, read by someone deciding whether to sign up —
    # they have no account yet, so they cannot carry a token. Returns only the
    # plan table that is already printed on the marketing site; no user data,
    # no Stripe object, nothing that varies by caller.
    ("GET", "/api/v1/billing/plans"),
    # Stripe posting an event. It has no Axis account and cannot carry a
    # bearer token; it authenticates by signing the payload instead, which the
    # handler verifies before trusting a byte. A missing signing secret makes
    # the endpoint refuse everything rather than accept unverifiable events.
    ("POST", "/api/v1/billing/webhook"),
}

AUTH_CALLS = {get_current_user, require_user}


def _is_authenticated(route: APIRoute) -> bool:
    """True when this route resolves an auth dependency, at any nesting depth."""
    seen, stack = set(), list(route.dependant.dependencies)
    while stack:
        dep = stack.pop()
        if id(dep) in seen:
            continue
        seen.add(id(dep))
        if dep.call in AUTH_CALLS:
            return True
        stack.extend(dep.dependencies)
    return False


def _api_routes():
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        if not route.path.startswith("/api/"):
            continue
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            yield method, route.path, route


def test_no_unauthenticated_routes_outside_the_allowlist():
    offenders = [
        f"{method} {path}"
        for method, path, route in _api_routes()
        if not _is_authenticated(route) and (method, path) not in PUBLIC
    ]
    assert not offenders, (
        "These routes are reachable without authentication. Add auth, or add them "
        "to PUBLIC with the reason they cannot carry a JWT:\n  "
        + "\n  ".join(sorted(offenders))
    )


def test_allowlist_has_no_stale_entries():
    """A public route that was deleted or secured must leave the allowlist too,
    so PUBLIC keeps describing the real surface instead of drifting into fiction."""
    live = {(m, p) for m, p, r in _api_routes() if not _is_authenticated(r)}
    stale = PUBLIC - live
    assert not stale, f"PUBLIC lists routes that are no longer public or present: {sorted(stale)}"


def test_billing_exposes_no_unauthenticated_customer_lookup():
    """The original sin, pinned so it cannot return.

    This used to assert billing was not mounted at all, which was right while
    the router was abandoned scaffolding. Billing is being built now, so the
    blanket ban is replaced by the specific property that made the old router
    dangerous: POST /billing/portal took a Stripe customer_id as a parameter,
    with no auth, and handed back that customer's billing-portal URL. Anyone
    could mint one for anyone.

    The rule is therefore: no billing route may accept a customer or
    subscription identifier from the caller. A contractor's Stripe ids are
    looked up from their authenticated user id, never trusted from the request.
    """
    billing = [r for r in app.routes
               if isinstance(r, APIRoute) and r.path.startswith("/api/v1/billing")]
    assert billing, "billing router is not mounted — did the prefix change?"

    caller_supplied_ids = {"customer_id", "subscription_id", "stripe_customer_id",
                           "stripe_subscription_id"}
    offenders = []
    for route in billing:
        names = {p.name for p in route.dependant.query_params}
        names |= {p.name for p in route.dependant.path_params}
        leaked = names & caller_supplied_ids
        if leaked:
            offenders.append(f"{route.path} takes {sorted(leaked)}")
    assert not offenders, (
        "billing routes must derive Stripe ids from the authenticated user, "
        f"never accept them from the caller: {offenders}"
    )


def test_every_money_moving_billing_route_is_authenticated():
    """Only reads may be public. Anything that could create a charge, a
    subscription or a Stripe object must carry auth — a webhook is the sole
    exception, and it authenticates by signature instead."""
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        if not route.path.startswith("/api/v1/billing"):
            continue
        if route.path.endswith("/webhook"):
            continue   # verified by Stripe signature, not a bearer token
        if "GET" in route.methods and (route.methods == {"GET", "HEAD"} or route.methods == {"GET"}):
            continue   # reads are covered by the allowlist test above
        assert _is_authenticated(route), (
            f"{sorted(route.methods)} {route.path} can move money without auth"
        )
