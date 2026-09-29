"""Full billing lifecycle, end to end. STRIPE TEST MODE ONLY.

Supersedes the _e2e.py fragment, which stopped at "subscribe returned a client
secret" — the half that cannot fail quietly. Everything that decides whether a
contractor who paid actually gets access happens AFTER that point: the card
clears, Stripe delivers a webhook, and the webhook writes the period bounds the
entitlement check reads. That is the stretch this exercises.

WHY IT RUNS AGAINST THE DEPLOYED BACKEND
Stripe has to be able to reach the webhook endpoint for any of this to be real,
and a localhost backend is not reachable from Stripe. So this drives the Render
backend and the Supabase project behind it. Consequences, stated plainly:

  - No real money can move. The key must be sk_test_ and this refuses to start
    otherwise. Test-mode charges are fabricated end to end.
  - Database writes ARE real. This creates an auth user, a subscriptions row, a
    payment_methods row and a Stripe customer in whatever project the
    environment points at. Every one of them is deleted in `cleanup()`, which
    runs even when an assertion fails.

It is gated behind AXIS_E2E_CONFIRM=1 so it can never run as a side effect of
something else.

    AXIS_E2E_CONFIRM=1 python _e2e_billing.py
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
import uuid

# ── Environment ───────────────────────────────────────────────────────────
# Both the Docker mount points this is normally run under and the repo layout,
# so it behaves the same whichever way it is invoked.

_HERE = pathlib.Path(__file__).resolve().parent


def _load(path) -> None:
    p = pathlib.Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


for _p in ("/w/.env", "/fe/.env.local",
           _HERE / ".env", _HERE.parent / ".env", _HERE.parent / "frontend/.env.local"):
    _load(_p)

API = os.environ.get("AXIS_E2E_API", "https://build-backend-jcp9.onrender.com").rstrip("/")

# ── Safety gates, BEFORE anything else is resolved ────────────────────────
# Deliberately ahead of the required-variable check: a missing env var must not
# be able to crash past a gate. A traceback is not a refusal.

if os.environ.get("AXIS_E2E_CONFIRM") != "1":
    sys.exit(
        "Refusing to run without AXIS_E2E_CONFIRM=1.\n"
        "This creates (and then deletes) a test user and subscription in the\n"
        f"Supabase project the environment points at, and drives {API}."
    )

_key = os.environ.get("STRIPE_SECRET_KEY", "")
if not _key.startswith("sk_test_"):
    sys.exit(
        "Refusing to run: STRIPE_SECRET_KEY is not an sk_test_ key "
        f"(got {_key[:8] + '…' if _key else 'nothing'}).\n"
        "This script confirms real payment intents. Against a live key that "
        "charges actual cards."
    )

if (os.environ.get("BILLING_ENFORCE") or "").strip().lower() in {"1", "true", "yes"}:
    sys.exit(
        "Refusing to run: BILLING_ENFORCE is on.\n"
        "This is a pre-enforcement sandbox check. With enforcement live it "
        "would be exercising the gate real contractors sit behind."
    )

# ── Required configuration, reported all at once ──────────────────────────

SUPA = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
SVC = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
ANON = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") or ""
STRIPE_KEY = _key

_missing = [n for n, v in (("SUPABASE_URL", SUPA),
                           ("SUPABASE_SERVICE_ROLE_KEY", SVC),
                           ("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON)) if not v]
if _missing:
    sys.exit("Missing required configuration: " + ", ".join(_missing) +
             "\nLooked in /w/.env, /fe/.env.local, backend/.env, .env and "
             "frontend/.env.local.")

import stripe  # noqa: E402  — after the key check, so an unsafe key fails first

stripe.api_key = STRIPE_KEY

sys.path.insert(0, "/w")
sys.path.insert(0, str(_HERE))
from app.core.plans import PLANS  # noqa: E402


# ── Plumbing ──────────────────────────────────────────────────────────────

svc = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
results: list[tuple[bool, str]] = []
trash: dict[str, str] = {}


def call(url, data=None, headers=None, method=None, timeout=180):
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode() if data is not None else None,
        headers=headers or {},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:300]}


def check(label: str, passed: bool, detail: str = "") -> bool:
    results.append((bool(passed), label))
    print(f"  {'PASS' if passed else 'FAIL'}  {label}{(' — ' + str(detail)) if detail else ''}")
    return bool(passed)


def section(name: str) -> None:
    print(f"\n{name}")


def sub_row(uid: str) -> dict:
    rows = call(f"{SUPA}/rest/v1/subscriptions?user_id=eq.{uid}&select=*", None, svc)[1]
    return rows[0] if rows else {}


def await_row(uid: str, predicate, what: str, timeout: int = 90):
    """Poll the subscriptions row until `predicate` holds.

    Stripe delivers webhooks asynchronously and Render may be cold, so this is
    a wait, not a sleep-and-hope. Returns (ok, row, seconds).
    """
    started = time.time()
    row = {}
    while time.time() - started < timeout:
        row = sub_row(uid)
        if predicate(row):
            return True, row, time.time() - started
        time.sleep(3)
    print(f"    timed out after {timeout}s waiting for {what}; row now: "
          f"status={row.get('status')!r} plan={row.get('plan_key')!r} "
          f"scheduled={row.get('scheduled_plan_key')!r}")
    return False, row, time.time() - started


def await_cards(uid: str, timeout: int = 45) -> list:
    """Poll payment_methods until the card webhook lands. Returns the rows."""
    started = time.time()
    rows = []
    while time.time() - started < timeout:
        rows = call(f"{SUPA}/rest/v1/payment_methods?user_id=eq.{uid}&select=*",
                    None, svc)[1] or []
        if rows:
            return rows
        time.sleep(3)
    print(f"    timed out after {timeout}s waiting for the card row")
    return rows


def cleanup() -> None:
    """Remove everything this run created. Runs even on failure."""
    section("CLEANUP")
    sub_id, cust_id, uid = trash.get("sub"), trash.get("customer"), trash.get("uid")
    if sub_id:
        try:
            stripe.Subscription.delete(sub_id)
            print(f"  cancelled Stripe subscription {sub_id}")
        except Exception as e:
            print(f"  could not cancel {sub_id}: {e}")
    if cust_id:
        try:
            stripe.Customer.delete(cust_id)
            print(f"  deleted Stripe customer {cust_id}")
        except Exception as e:
            print(f"  could not delete customer {cust_id}: {e}")
    if uid:
        for table in ("payment_methods", "overage_purchases", "entitlement_denials",
                      "subscriptions"):
            try:
                call(f"{SUPA}/rest/v1/{table}?user_id=eq.{uid}", None, svc, "DELETE")
            except Exception as e:
                print(f"  could not clear {table}: {e}")
        try:
            call(f"{SUPA}/auth/v1/admin/users/{uid}", None, svc, "DELETE")
            print(f"  deleted auth user {uid[:8]}…")
        except Exception as e:
            print(f"  could not delete auth user: {e}")


# ── The run ───────────────────────────────────────────────────────────────

def main() -> int:
    print(f"api      {API}")
    print(f"supabase {SUPA}")
    print(f"stripe   {STRIPE_KEY[:11]}… (test mode)\n")

    email = f"billing-e2e-{uuid.uuid4().hex[:8]}@example.com"
    pw = "TestPass!23456"
    s, body = call(f"{SUPA}/auth/v1/admin/users",
                   {"email": email, "password": pw, "email_confirm": True}, svc)
    uid = body.get("id")
    if not uid:
        print(f"could not create the test user: {s} {body}")
        return 1
    trash["uid"] = uid
    tok = call(f"{SUPA}/auth/v1/token?grant_type=password",
               {"email": email, "password": pw},
               {"apikey": ANON, "Content-Type": "application/json"})[1].get("access_token")
    if not tok:
        print("could not sign the test user in")
        return 1
    auth = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    print(f"test user {uid[:8]}… {email}")

    # ── Nothing here should be reachable without a token, and nothing should
    # accept a plan or interval the plan table does not define.
    section("VALIDATION")
    s, _ = call(f"{API}/api/v1/billing/subscribe", {"plan_key": "enterprise"}, auth)
    check("unknown plan rejected", s == 400, f"got {s}")
    s, _ = call(f"{API}/api/v1/billing/subscribe",
                {"plan_key": "solo", "interval": "decade"}, auth)
    check("bad interval rejected", s == 400, f"got {s}")
    s, _ = call(f"{API}/api/v1/billing/subscribe", {"plan_key": "solo"},
                {"Content-Type": "application/json"})
    check("unauthenticated rejected", s in (401, 403), f"got {s}")
    s, _ = call(f"{API}/api/v1/billing/change-plan", {"plan_key": "crew"}, auth)
    check("change-plan with no plan rejected", s == 409, f"got {s}")
    s, _ = call(f"{API}/api/v1/billing/cancel", None, auth, "POST")
    check("cancel with no plan rejected", s == 409, f"got {s}")

    # ── Public surfaces the pricing page depends on.
    section("PUBLIC CONFIG")
    s, cfg = call(f"{API}/api/v1/billing/config")
    check("config is public", s == 200, f"got {s}")
    check("publishable key served", bool(cfg.get("publishable_key")))
    check("test mode reported honestly", cfg.get("test_mode") is True, str(cfg.get("test_mode")))
    s, pl = call(f"{API}/api/v1/billing/plans")
    keys = [p.get("key") for p in pl.get("plans", [])]
    check("three plans listed", keys == ["solo", "crew", "fleet"], str(keys))
    check("no free tier", pl.get("free_tier") is False)
    priced = all(
        p.get("monthly_usd") == PLANS[p["key"]].monthly_usd
        and p.get("annual_usd") == PLANS[p["key"]].annual_usd
        for p in pl.get("plans", [])
    )
    check("prices match plans.py", priced)

    # ── Subscribe. Unpaid until the card clears.
    section("SUBSCRIBE (crew, monthly)")
    s, body = call(f"{API}/api/v1/billing/subscribe",
                   {"plan_key": "crew", "interval": "month"}, auth)
    if not check("subscribe returns 200", s == 200, f"got {s} {body}"):
        return 1
    check("payment required", body.get("requires_payment") is True)
    secret = body.get("client_secret") or ""
    check("client secret returned", secret.startswith("pi_"))
    sub_id = body.get("subscription_id")
    trash["sub"] = sub_id
    print(f"    subscription {sub_id}")

    remote = stripe.Subscription.retrieve(sub_id, expand=["latest_invoice"])
    trash["customer"] = remote.customer
    amount = (remote.latest_invoice.amount_due or 0) / 100
    check("amount charged matches plans.py", amount == PLANS["crew"].monthly_usd,
          f"Stripe ${amount:.0f} vs ${PLANS['crew'].monthly_usd}")
    check("incomplete until paid", remote.status == "incomplete", remote.status)

    row = sub_row(uid)
    check("row pre-recorded before payment", bool(row))
    check("plan_key recorded", row.get("plan_key") == "crew", str(row.get("plan_key")))
    check("not yet active", row.get("status") != "active", str(row.get("status")))

    # A refreshed checkout tab must not mint a second subscription — two live
    # payment intents for one plan is how somebody pays twice.
    s, again = call(f"{API}/api/v1/billing/subscribe",
                    {"plan_key": "crew", "interval": "month"}, auth)
    check("re-subscribe reuses the same subscription",
          s == 200 and again.get("subscription_id") == sub_id,
          f"got {s} {again.get('subscription_id')}")

    # ── Pay it. This is the line the old script stopped short of.
    section("PAYMENT")
    pi_id = secret.split("_secret_")[0]
    try:
        pi = stripe.PaymentIntent.confirm(pi_id, payment_method="pm_card_visa")
        check("test card accepted", pi.status == "succeeded", pi.status)
    except Exception as e:
        check("test card accepted", False, str(e)[:160])
        return 1

    # ── The webhook is the only thing that grants access. If it does not
    # arrive, a contractor has paid and is still locked out.
    section("WEBHOOK ACTIVATION")
    ok, row, secs = await_row(uid, lambda r: r.get("status") in ("active", "trialing"),
                              "status to become active")
    check("webhook flipped status to active", ok, f"{row.get('status')} after {secs:.0f}s")
    # The bug this guards: webhook payloads carry the period on the subscription
    # ITEM, not the top level. Reading only the top level wrote NULL periods, so
    # evaluate() saw a paying contractor with no active period and would have
    # denied them — behind an 'active' row saying all was well.
    check("current_period_start written", bool(row.get("current_period_start")),
          str(row.get("current_period_start")))
    check("current_period_end written", bool(row.get("current_period_end")),
          str(row.get("current_period_end")))
    check("interval recorded", row.get("billing_interval") == "month",
          str(row.get("billing_interval")))

    s, me = call(f"{API}/api/v1/billing/me", None, auth)
    check("/me reports the plan", me.get("has_plan") is True and
          (me.get("plan") or {}).get("key") == "crew",
          str((me.get("plan") or {}).get("key")))

    # save_default_payment_method='on_subscription' should have saved the card.
    cards = await_cards(uid)
    check("card saved from the subscription", bool(cards), f"{len(cards)} row(s)")
    if cards:
        check("last4 stored, PAN not", cards[0].get("last4") == "4242"
              and "number" not in cards[0], str(cards[0].get("last4")))
    s, pms = call(f"{API}/api/v1/billing/payment-methods", None, auth)
    check("card visible in Settings", s == 200 and len(pms.get("payment_methods", [])) >= 1,
          f"got {s}")

    # Now that a plan is active, subscribe must refuse rather than double-bill.
    s, _ = call(f"{API}/api/v1/billing/subscribe", {"plan_key": "solo"}, auth)
    check("second subscribe blocked while active", s == 409, f"got {s}")

    # ── Upgrades apply now; downgrades are scheduled.
    section("UPGRADE (crew -> fleet, immediate)")
    s, up = call(f"{API}/api/v1/billing/change-plan", {"plan_key": "fleet"}, auth)
    check("upgrade accepted", s == 200, f"got {s} {up}")
    check("effective immediately", up.get("effective") == "now", str(up.get("effective")))
    check("plan_key now fleet", sub_row(uid).get("plan_key") == "fleet",
          str(sub_row(uid).get("plan_key")))
    # Assert the AMOUNT, not the price id. The id lives only in the deployed
    # environment, so comparing to a local STRIPE_PRICE_FLEET_MONTH would be
    # comparing against None and passing for the wrong reason.
    item = stripe.Subscription.retrieve(sub_id)["items"]["data"][0]
    charged = (item["price"]["unit_amount"] or 0) / 100
    check("Stripe is charging the fleet amount", charged == PLANS["fleet"].monthly_usd,
          f"${charged:.0f} vs ${PLANS['fleet'].monthly_usd}")
    check("still a monthly price", item["price"]["recurring"]["interval"] == "month",
          item["price"]["recurring"]["interval"])

    section("DOWNGRADE (fleet -> solo, at period end)")
    s, down = call(f"{API}/api/v1/billing/change-plan", {"plan_key": "solo"}, auth)
    check("downgrade accepted", s == 200, f"got {s} {down}")
    check("scheduled, not immediate", down.get("effective") == "period_end",
          str(down.get("effective")))
    row = sub_row(uid)
    check("scheduled_plan_key recorded", row.get("scheduled_plan_key") == "solo",
          str(row.get("scheduled_plan_key")))
    # The whole point of scheduling: nothing shrinks inside a paid period.
    check("still on fleet until then", row.get("plan_key") == "fleet",
          str(row.get("plan_key")))
    check("change date is the period end",
          row.get("scheduled_change_at") == row.get("current_period_end"),
          f"{row.get('scheduled_change_at')} vs {row.get('current_period_end')}")

    # ── Cancel keeps access to the end of the paid period, and is reversible.
    section("CANCEL AND RESUME")
    s, c = call(f"{API}/api/v1/billing/cancel", None, auth, "POST")
    check("cancel accepted", s == 200, f"got {s}")
    check("access runs to the period end", bool(c.get("access_until")),
          str(c.get("access_until")))
    check("cancel_at_period_end set", sub_row(uid).get("cancel_at_period_end") is True)
    check("Stripe agrees it is cancelling",
          stripe.Subscription.retrieve(sub_id).cancel_at_period_end is True)
    check("status is not canceled outright", sub_row(uid).get("status") != "canceled",
          str(sub_row(uid).get("status")))

    s, _ = call(f"{API}/api/v1/billing/resume", None, auth, "POST")
    check("resume accepted", s == 200, f"got {s}")
    check("cancel_at_period_end cleared",
          sub_row(uid).get("cancel_at_period_end") is False)
    check("Stripe agrees it resumed",
          stripe.Subscription.retrieve(sub_id).cancel_at_period_end is False)

    # REGRESSION: a scheduled downgrade must survive an unrelated subscription
    # update. The webhook used to apply it on ANY customer.subscription.updated
    # event without checking that the period had advanced, and cancel/resume
    # both call Subscription.modify — which emits exactly that event. So the
    # downgrade scheduled above landed here, mid-period, and the contractor
    # lost the Fleet allowance they had already paid for. Fixed by
    # _scheduled_change_is_due(); this is the end-to-end guard on that fix.
    #
    # Give the webhook a moment to arrive before judging, or this passes only
    # because the event has not been delivered yet.
    time.sleep(12)
    row = sub_row(uid)
    check("scheduled downgrade NOT applied early",
          row.get("plan_key") == "fleet" and row.get("scheduled_plan_key") == "solo",
          f"plan={row.get('plan_key')} scheduled={row.get('scheduled_plan_key')} "
          f"— a mid-period update applied the downgrade")

    # ── One contractor must never touch another's card.
    section("CROSS-ACCOUNT ISOLATION")
    other = f"billing-e2e-other-{uuid.uuid4().hex[:6]}@example.com"
    ob = call(f"{SUPA}/auth/v1/admin/users",
              {"email": other, "password": pw, "email_confirm": True}, svc)[1]
    other_uid = ob.get("id")
    if other_uid:
        otok = call(f"{SUPA}/auth/v1/token?grant_type=password",
                    {"email": other, "password": pw},
                    {"apikey": ANON, "Content-Type": "application/json"})[1].get("access_token")
        oauth = {"Authorization": f"Bearer {otok}", "Content-Type": "application/json"}
        victim_card = cards[0]["id"] if cards else "00000000-0000-0000-0000-000000000000"
        s, _ = call(f"{API}/api/v1/billing/payment-methods/remove", {"id": victim_card}, oauth)
        check("cannot remove another account's card", s in (403, 404), f"got {s}")
        s, _ = call(f"{API}/api/v1/billing/payment-methods/default", {"id": victim_card}, oauth)
        check("cannot adopt another account's card", s in (403, 404), f"got {s}")
        still_there = call(
            f"{SUPA}/rest/v1/payment_methods?user_id=eq.{uid}&select=id", None, svc)[1]
        check("victim's card untouched", len(still_there) == len(cards))
        call(f"{SUPA}/auth/v1/admin/users/{other_uid}", None, svc, "DELETE")

    return 0


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    except KeyboardInterrupt:
        print("\ninterrupted")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"\nrun aborted: {e}")
    finally:
        cleanup()
        passed = sum(1 for ok, _ in results if ok)
        failed = [label for ok, label in results if not ok]
        print(f"\n{passed}/{len(results)} passed")
        if failed:
            print("failed:")
            for label in failed:
                print(f"  - {label}")
        sys.exit(1 if (failed or code) else 0)
