"""FastAPI dependency injection utilities."""

import logging
from datetime import datetime, timezone
from typing import Annotated

import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import verify_token

logger = logging.getLogger(__name__)
security = HTTPBearer()


async def _resolve_api_key(token: str, db: AsyncSession) -> dict:
    """Authenticate via API Key (ak-xxx prefix)."""
    from app.models.api_key import ApiKey
    from app.models.user import User

    # Find by prefix (first 8 chars after "ak-") for fast lookup
    prefix = token[:10]  # "ak-" + 7 chars
    result = await db.execute(
        select(ApiKey).where(ApiKey.key_prefix == prefix, ApiKey.is_active.is_(True))
    )
    candidates = result.scalars().all()

    matched_key = None
    for key in candidates:
        if bcrypt.checkpw(token.encode(), key.key_hash.encode()):
            matched_key = key
            break

    if not matched_key:
        logger.warning("api_key_rejected: prefix=%s (invalid or revoked)", prefix)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or revoked API key",
        )

    # Rate limit check
    from app.core.rate_limiter import check_rate_limit, RateLimitExceeded
    try:
        remaining = check_rate_limit(matched_key.id, {
            "minute": matched_key.rate_limit_per_minute,
            "hour": matched_key.rate_limit_per_hour,
            "day": matched_key.rate_limit_per_day,
        })
    except RateLimitExceeded as e:
        raise HTTPException(
            status_code=429,
            detail=f"API 调用频率超限（{e.window}: {e.limit}次/窗口）",
            headers={
                "Retry-After": str(e.retry_after),
                "X-RateLimit-Window": e.window,
                "X-RateLimit-Limit": str(e.limit),
                "X-RateLimit-Remaining": "0",
            },
        )

    # Token quota check
    if matched_key.token_quota == 0:
        raise HTTPException(status_code=429, detail="Token 配额为 0，禁止调用")
    if matched_key.token_quota > 0 and (matched_key.token_used or 0) >= matched_key.token_quota:
        raise HTTPException(
            status_code=429,
            detail=f"Token 用量已达配额上限（{matched_key.token_used}/{matched_key.token_quota}）",
            headers={"X-Token-Used": str(matched_key.token_used), "X-Token-Quota": str(matched_key.token_quota)},
        )

    # Update last_used_at (fire-and-forget, don't block)
    matched_key.last_used_at = datetime.now(timezone.utc)
    await db.commit()

    # Resolve user
    user = await db.get(User, matched_key.user_id)
    if not user or user.status != "active":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key owner account is disabled",
        )

    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "api_key_id": matched_key.id,
        "api_key_name": matched_key.name,
    }


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """Extract and validate the current user from JWT token or API Key."""
    token = credentials.credentials

    # API Key path: token starts with "ak-"
    if token.startswith("ak-"):
        return await _resolve_api_key(token, db)

    # JWT path (original behavior)
    try:
        payload = verify_token(token)
        return {
            "id": int(payload["sub"]),
            "username": payload["username"],
            "role": payload["role"],
        }
    except Exception as e:
        logger.warning("jwt_auth_failed: %s", str(e)[:200])
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )


def require_role(*allowed_roles: str):
    """Create a dependency that checks the user has one of the allowed roles."""

    async def _check(user: Annotated[dict, Depends(get_current_user)]) -> dict:
        if user["role"] not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{user['role']}' is not allowed. Required: {allowed_roles}",
            )
        return user

    return _check
