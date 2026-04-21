"""Supabase JWT verification.

Runs in one of three modes depending on config:

1. **Strict** (AUTH_ENFORCE_SIGNATURE=true, SUPABASE_JWT_SECRET set):
   signature is verified; invalid tokens → 401. This is the real lock.

2. **Shadow** (AUTH_ENFORCE_SIGNATURE=false, SUPABASE_JWT_SECRET set):
   signature is verified; on failure we log a warning but still accept the
   token by falling back to the unsigned decode. Use this to discover which
   callers (if any) are sending bad tokens *before* flipping to strict.

3. **Legacy** (SUPABASE_JWT_SECRET unset): no verification, logs a warning
   on every request. Same behavior as before — kept so local dev without
   the secret still works.
"""
import logging
from fastapi import HTTPException, Security, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError

from app.core.config import settings

logger = logging.getLogger(__name__)
security = HTTPBearer(auto_error=False)

# Supabase signs access tokens with HS256 by default. RS256 is only used for
# third-party JWTs, which we don't issue.
_ALGORITHMS = ["HS256"]


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

    if secret:
        try:
            payload = _decode_verified(token, secret)
        except JWTError as e:
            if enforce:
                logger.warning("JWT verification failed (strict): %s", e)
                raise HTTPException(status_code=401, detail="Invalid token")
            # Shadow mode: record the failure, but don't block — fall through
            # to the legacy decode so nothing breaks until we flip enforce on.
            logger.warning(
                "JWT verification failed (shadow mode, request allowed): %s", e
            )
            try:
                payload = _decode_unverified(token)
            except JWTError:
                raise HTTPException(status_code=401, detail="Invalid token")
    else:
        # Legacy mode — no secret configured. Log once per request so the gap
        # is visible in production logs.
        logger.warning(
            "SUPABASE_JWT_SECRET not set — accepting unverified token. "
            "Set the secret and AUTH_ENFORCE_SIGNATURE=true in production."
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
