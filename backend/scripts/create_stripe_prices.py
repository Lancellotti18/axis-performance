"""Create the Stripe products and prices for every Axis plan.

Amounts come from app/core/plans.py, never typed here. A price typed by hand
into the Stripe dashboard is a second source of truth, and the failure mode is
charging someone an amount the product does not think they are on — the same
class of drift that left a $49 Solo on the public pricing page while the code
said $299.

Idempotent. Products use deterministic ids and prices use lookup keys, so
re-running finds what exists instead of creating duplicates. Stripe prices are
immutable, so a changed amount creates a NEW price and the old one is
deactivated — existing subscribers keep the price they signed up at, which is
what you want and what a naive "update the price" would silently break.

    python scripts/create_stripe_prices.py            # create/verify
    python scripts/create_stripe_prices.py --dry-run  # show, change nothing
"""
from __future__ import annotations

import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

# Load backend/.env without printing anything from it.
_env = pathlib.Path(__file__).resolve().parents[1] / ".env"
if _env.exists():
    for line in _env.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

from app.core.plans import PLANS, UNLIMITED  # noqa: E402

DRY = "--dry-run" in sys.argv


def main() -> int:
    key = (os.environ.get("STRIPE_SECRET_KEY") or "").strip()
    if not key:
        print("STRIPE_SECRET_KEY is not set in backend/.env")
        return 1
    if not key.startswith("sk_test_"):
        print("Refusing to run: this is not a test key. Creating live prices by "
              "accident is not something you can quietly undo.")
        return 1

    import stripe
    stripe.api_key = key
    print(f"Stripe test mode — {len(PLANS)} plans x 2 intervals\n")

    results: dict[str, str] = {}
    for plan in PLANS.values():
        product_id = f"axis_{plan.key}"
        reports = "unlimited" if plan.reports == UNLIMITED else f"{plan.reports} reports"
        crews = "unlimited crews" if plan.crews == UNLIMITED else f"{plan.crews} crews"
        description = f"{reports} a month, {crews}. Every Axis tool included."

        try:
            product = stripe.Product.retrieve(product_id)
            if not DRY and (product.name != plan.name or product.description != description):
                product = stripe.Product.modify(product_id, name=plan.name,
                                                description=description)
                print(f"  {plan.key}: product updated")
            else:
                print(f"  {plan.key}: product exists")
        except stripe.error.InvalidRequestError:
            if DRY:
                print(f"  {plan.key}: WOULD CREATE product {product_id}")
                product = None
            else:
                product = stripe.Product.create(
                    id=product_id, name=plan.name, description=description,
                    metadata={"axis_plan_key": plan.key},
                )
                print(f"  {plan.key}: product created")

        for interval, amount in (("month", plan.monthly_usd), ("year", plan.annual_usd)):
            lookup = f"axis_{plan.key}_{interval}"
            cents = amount * 100
            existing = stripe.Price.list(lookup_keys=[lookup], limit=1).data
            match = existing[0] if existing else None

            if match and match.unit_amount == cents and match.active:
                print(f"    {interval:5} ${amount:>5} -> {match.id} (exists)")
                results[lookup] = match.id
                continue

            if DRY:
                verb = "WOULD REPRICE" if match else "WOULD CREATE"
                print(f"    {interval:5} ${amount:>5} -> {verb}")
                continue

            if match:
                # Prices are immutable. Transferring the lookup key to a new
                # price leaves existing subscribers on the old one — they keep
                # the amount they agreed to, and only new signups get the new.
                stripe.Price.modify(match.id, active=False, lookup_key=None)
                print(f"    {interval:5} ${amount:>5} -> old price {match.id} retired")

            price = stripe.Price.create(
                product=product_id, unit_amount=cents, currency="usd",
                recurring={"interval": interval},
                lookup_key=lookup, transfer_lookup_key=True,
                metadata={"axis_plan_key": plan.key, "axis_interval": interval},
            )
            print(f"    {interval:5} ${amount:>5} -> {price.id} (created)")
            results[lookup] = price.id

    if DRY:
        print("\nDry run — nothing was created.")
        return 0

    print("\n" + "=" * 62)
    print("Add these to Render (Environment), then redeploy:\n")
    for plan_key in PLANS:
        for interval in ("month", "year"):
            pid = results.get(f"axis_{plan_key}_{interval}")
            if pid:
                print(f"  STRIPE_PRICE_{plan_key.upper()}_{interval.upper()}={pid}")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
