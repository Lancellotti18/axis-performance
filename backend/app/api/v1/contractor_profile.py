from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.core.auth import require_user
from app.core.supabase import get_supabase

router = APIRouter()

# NOTE: the {user_id} path segment is kept for URL compatibility with older
# frontends, but it is IGNORED — the authenticated token decides whose
# profile is read or written. Profiles hold license numbers, phone, email,
# and branding; none of that is public.


class ContractorProfile(BaseModel):
    company_name: Optional[str] = ""
    license_number: Optional[str] = ""
    phone: Optional[str] = ""
    email: Optional[str] = ""
    address: Optional[str] = ""
    city: Optional[str] = ""
    state: Optional[str] = ""
    zip_code: Optional[str] = ""
    # White-label: rendered at the top of generated reports.
    logo_url: Optional[str] = ""


@router.get("/{user_id}")
async def get_contractor_profile(user_id: str, user: dict = Depends(require_user)):
    db = get_supabase()
    result = db.table("contractor_profiles").select("*").eq("user_id", user["id"]).limit(1).execute()
    if not result.data:
        return {}
    return result.data[0]


@router.post("/{user_id}")
async def save_contractor_profile(user_id: str, payload: ContractorProfile, user: dict = Depends(require_user)):
    db = get_supabase()
    data = {
        "user_id": user["id"],
        **{k: v for k, v in payload.dict().items() if v is not None},
        "updated_at": "now()",
    }
    result = db.table("contractor_profiles").upsert(data, on_conflict="user_id").execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to save profile")
    return result.data[0]


# ---------------------------------------------------------------------------
# Logo upload + deterministic professional prep
# ---------------------------------------------------------------------------
# Deliberately NOT generative: an AI that "redraws" a company logo will mangle
# letterforms in someone's trademark. Deterministic prep gets the professional
# look safely: trim dead space, center on a clean canvas with even padding,
# constrain size, preserve transparency, high-quality resample.

from fastapi import File, UploadFile
from app.core.supabase import get_supabase as _get_sb


def _prep_logo(raw: bytes) -> bytes:
    import io
    from PIL import Image, ImageOps

    im = Image.open(io.BytesIO(raw))
    im = im.convert("RGBA")

    # Trim uniform border: use alpha if meaningful, else difference from the
    # corner color (handles white-background JPG logos).
    alpha = im.getchannel("A")
    if alpha.getextrema()[0] < 250:          # real transparency present
        bbox = alpha.getbbox()
    else:
        from PIL import ImageChops
        bg = Image.new("RGBA", im.size, im.getpixel((0, 0)))
        bbox = ImageChops.difference(im, bg).getbbox()
    if bbox:
        im = im.crop(bbox)

    # Even padding (6% of the longer side) + size constraint, LANCZOS resample.
    pad = max(8, int(max(im.size) * 0.06))
    canvas = Image.new("RGBA", (im.width + 2 * pad, im.height + 2 * pad), (0, 0, 0, 0))
    canvas.paste(im, (pad, pad), im)
    if canvas.width > 1200:
        ratio = 1200 / canvas.width
        canvas = canvas.resize((1200, max(1, int(canvas.height * ratio))), Image.LANCZOS)

    out = io.BytesIO()
    canvas.save(out, format="PNG", optimize=True)
    return out.getvalue()


@router.post("/{user_id}/logo")
async def upload_logo(user_id: str, file: UploadFile = File(...), user: dict = Depends(require_user)):
    """Upload a logo image; Axis preps it (trim, center, pad, constrain,
    transparency-safe) and saves the URL to the profile for reports/proposals."""
    raw = await file.read()
    if not raw or len(raw) < 64:
        raise HTTPException(status_code=400, detail="The file was empty — try again.")
    if len(raw) > 8_000_000:
        raise HTTPException(status_code=400, detail="Logo too large — keep it under 8 MB.")
    try:
        cleaned = _prep_logo(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="Couldn't read that image — use a PNG or JPG of your logo.")

    db = _get_sb()
    bucket = db.storage.from_("blueprints")
    key = f"logos/{user['id']}.png"
    try:
        bucket.upload(key, cleaned, {"content-type": "image/png", "upsert": "true"})
        signed = bucket.create_signed_url(key, 31_536_000)
        url = None
        if isinstance(signed, dict):
            url = (signed.get("signedURL") or signed.get("signedUrl")
                   or signed.get("signed_url") or signed.get("url"))
        if url and url.startswith("/"):
            from app.core.config import settings
            url = settings.SUPABASE_URL.rstrip("/") + url
        if not url:
            raise RuntimeError("no signed url")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not store the logo: {str(e)[:100]}")

    db.table("contractor_profiles").upsert(
        {"user_id": user["id"], "logo_url": url, "updated_at": "now()"}, on_conflict="user_id",
    ).execute()
    return {"ok": True, "logo_url": url}
