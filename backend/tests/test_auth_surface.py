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
    # Client portal — the customer's own share link.
    ("GET", "/api/v1/client-portal/public/{token}"),
    ("GET", "/api/v1/client-portal/public/{token}/messages"),
    ("POST", "/api/v1/client-portal/public/{token}/messages"),
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


def test_billing_router_is_not_mounted():
    """POST /billing/portal accepted any Stripe customer_id with no auth."""
    paths = {route.path for route in app.routes if isinstance(route, APIRoute)}
    assert not any(p.startswith("/api/v1/billing") for p in paths), (
        "billing is mounted again — it must have auth, real STRIPE_PRICE_* config "
        "and a signature-verified webhook before it goes back on the router."
    )
