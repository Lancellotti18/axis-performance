"""Supabase JWT verification.

Supabase signs access tokens one of two ways, and a project can be on either:

  * **Asymmetric signing keys** (ES256 / RS256). The token header carries a
    `kid` and the PUBLIC keys are published at the project's JWKS endpoint.
    Newer projects default here. Nothing secret is needed to verify — which
    is strictly better, because this backend then holds no signing material.

  * **A shared secret** (HS256), the older `SUPABASE_JWT_SECRET`.

Assuming HS256 was a real outage: this account's project issues ES256, so no
value of SUPABASE_JWT_SECRET could ever verify a token. The moment enforcement
was turned on every authenticated request 401'd and the app went dark until
enforcement was turned back off. Both schemes are now supported, chosen from
the token's own header rather than assumed.

Modes:

1. **Strict** (AUTH_ENFORCE_SIGNATURE=true, and a usable key source):
   signature is verified; invalid tokens → 401. This is the real lock.

2. **Shadow** (AUTH_ENFORCE_SIGNATURE=false): signature is verified; on
   failure we log and still accept via the unsigned decode. Use this to prove
   verification works BEFORE flipping to strict — it is what would have caught
   the ES256 mismatch without any downtime.

3. **Legacy** (no key source at all): no verification, logged on every
   request, so local dev without config still runs.
"""
import logging
import threading
import time
from typing import Optional

import httpx
from fastapi import HTTPException, Security, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError

from app.core.config import settings

logger = logging.getLogger(__name__)
security = HTTPBearer(auto_error=False)

_ALGORITHMS = ["HS256"]
_ASYM_ALGORITHMS = ("ES256", "ES384", "ES512", "RS256", "RS384", "RS512")

# Public keys, cached. Refreshed on a TTL and immediately on an unknown `kid`,
# so a key rotation costs one extra fetch rather than an outage.
_JWKS_TTL = 3600
_jwks_cache: dict = {"keys": {}, "fetched_at": 0.0}
_jwks_lock = threading.Lock()


def _jwks_url() -> str:
    base = (settings.SUPABASE_URL or "").rstrip("/")
    return f"{base}/auth/v1/.well-known/jwks.json" if base else ""


def _fetch_jwks(force: bool = False) -> dict:
    """{kid: jwk}. Best-effort: on failure keep whatever is cached."""
    url = _jwks_url()
    if not url:
        return {}
    with _jwks_lock:
        fresh = (time.time() - _jwks_cache["fetched_at"]) < _JWKS_TTL
        if _jwks_cache["keys"] and fresh and not force:
            return _jwks_cache["keys"]
        try:
            r = httpx.get(url, timeout=6.0)
            r.raise_for_status()
            keys = {k["kid"]: k for k in (r.json().get("keys") or []) if k.get("kid")}
            if keys:
                _jwks_cache["keys"] = keys
                _jwks_cache["fetched_at"] = time.time()
        except Exception as e:
            # Never fail the request because the key server blinked; the caller
            # falls through to the shared secret or to shadow behaviour.
            logger.warning("JWKS fetch failed from %s: %s", url, e)
        return _jwks_cache["keys"]


def _verify_asymmetric(token: str, kid: str, alg: str) -> Optional[dict]:
    """Verify against the project's published public key for this `kid`."""
    keys = _fetch_jwks()
    key = keys.get(kid)
    if key is None:
        # Unknown kid usually means the project rotated its keys — refetch once
        # before treating the token as bad.
        keys = _fetch_jwks(force=True)
        key = keys.get(kid)
    if key is None:
        return None
    return jwt.decode(token, key, algorithms=[alg], audience="authenticated")


def auth_key_source() -> str:
    """Which verification path is available — reported by /health."""
    if _jwks_url():
        return "jwks" if _fetch_jwks() else ("secret" if settings.SUPABASE_JWT_SECRET else "none")
    return "secret" if settings.SUPABASE_JWT_SECRET else "none"


def _decode_unverified(token: str) -> dict:
    # Shadow / legacy mode: disable every verifier. python-jose otherwise
    # enforces `exp`, `nbf`, `iat`, and `aud` even when the signature check
    # is off — so a slightly-stale Supabase token would still 401 despite
    # the signature not being checked.
    return jwt.decode(
        token,
        key="",
        algorithms=["HS256", "RS256"],
        options={
            "verify_signature": False,
            "verify_exp": False,
            "verify_nbf": False,
            "verify_iat": False,
            "verify_aud": False,
        },
    )


def _decode_verified(token: str, secret: str) -> dict:
    # Supabase sets aud="authenticated" on user access tokens.
    return jwt.decode(
        token,
        key=secret,
        algorithms=_ALGORITHMS,
        audience="authenticated",
    )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Security(security),
) -> dict:
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = credentials.credentials
    secret = settings.SUPABASE_JWT_SECRET
    enforce = settings.AUTH_ENFORCE_SIGNATURE

    # Let the token say how it was signed. Assuming HS256 is what took the app
    # down: an ES256 token can never verify against a shared secret, however
    # correct that secret is.
    header: dict = {}
    try:
        header = jwt.get_unverified_header(token)
    except Exception:
        pass
    alg = header.get("alg") or ""
    kid = header.get("kid")

    can_verify = bool(secret) or (alg in _ASYM_ALGORITHMS and bool(kid) and bool(_jwks_url()))

    if can_verify:
        try:
            if alg in _ASYM_ALGORITHMS and kid:
                payload = _verify_asymmetric(token, kid, alg)
                if payload is None:
                    raise JWTError(f"no published key for kid {kid}")
            elif secret:
                payload = _decode_verified(token, secret)
            else:
                raise JWTError(f"no key available for alg {alg or 'unknown'}")
        except JWTError as e:
            if enforce:
                logger.warning("JWT verification failed (strict, alg=%s): %s", alg, e)
                raise HTTPException(status_code=401, detail="Invalid token")
            # Shadow mode: record the failure, but don't block — fall through
            # to the legacy decode so nothing breaks until we flip enforce on.
            logger.warning(
                "JWT verification failed (shadow mode, request allowed, alg=%s): %s", alg, e
            )
            try:
                payload = _decode_unverified(token)
            except JWTError:
                raise HTTPException(status_code=401, detail="Invalid token")
    else:
        # Legacy mode — no usable key source. Log once per request so the gap
        # is visible in production logs.
        logger.warning(
            "No JWT key source available (alg=%s, jwks=%s, secret=%s) — accepting "
            "unverified token. Set SUPABASE_URL (for published keys) or "
            "SUPABASE_JWT_SECRET, then AUTH_ENFORCE_SIGNATURE=true.",
            alg or "unknown", bool(_jwks_url()), bool(secret),
        )
        try:
            payload = _decode_unverified(token)
        except JWTError:
            raise HTTPException(status_code=401, detail="Invalid token")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    return {"id": user_id, "email": payload.get("email", "")}


def require_user(user: dict = Depends(get_current_user)) -> dict:
    return user
