from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from app.core.config import settings
import stripe

router = APIRouter()
stripe.api_key = settings.STRIPE_SECRET_KEY

PRICE_IDS = {
    "starter": "price_starter_id",
    "pro": "price_pro_id",
    "enterprise": "price_enterprise_id",
}


class SubscribePayload(BaseModel):
    plan: str
    user_id: str
    email: str


@router.get("/plans")
async def get_plans():
    return [
        {"id": "starter", "name": "Starter", "price": 49, "upload_limit": 5},
        {"id": "pro", "name": "Pro", "price": 149, "upload_limit": None},
        {"id": "enterprise", "name": "Enterprise", "price": 499, "upload_limit": None},
    ]


@router.post("/subscribe")
async def subscribe(payload: SubscribePayload):
    if payload.plan not in PRICE_IDS:
        raise HTTPException(status_code=400, detail="Invalid plan")
    session = stripe.checkout.Session.create(
        payment_method_types=["card"],
        line_items=[{"price": PRICE_IDS[payload.plan], "quantity": 1}],
        mode="subscription",
        success_url="http://localhost:3000/dashboard?subscribed=true",
        cancel_url="http://localhost:3000/pricing",
        metadata={"user_id": payload.user_id},
    )
    return {"checkout_url": session.url}


@router.post("/portal")
async def billing_portal(customer_id: str):
    session = stripe.billing_portal.Session.create(
        customer=customer_id,
        return_url="http://localhost:3000/dashboard",
    )
    return {"portal_url": session.url}
