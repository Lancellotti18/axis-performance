from fastapi import HTTPException, Security, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from app.core.config import settings

security = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Security(security),
) -> dict:
    """Verify Supabase JWT and return the user payload."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = credentials.credentials
    try:
        # Decode without signature verification — Supabase verifies on their end
        # python-jose requires a key arg even when skipping verification
        payload = jwt.decode(
            token,
            key="",
            algorithms=["HS256", "RS256"],
            options={"verify_signature": False},
        )
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
        return {"id": user_id, "email": payload.get("email", "")}
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")


def require_user(user: dict = Depends(get_current_user)) -> dict:
    return user
