"""API Key management — CRUD for external system authentication."""

import secrets
from typing import Annotated

import bcrypt
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.core.database import get_db
from app.models.api_key import ApiKey
from app.core.utils import to_iso

logger = structlog.get_logger(__name__)

router = APIRouter()

AdminUser = Annotated[dict, Depends(require_role("admin"))]


# ─── Schemas ───

class ApiKeyCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, description="Key 名称，如 MES系统")
    rate_limit_per_minute: int = Field(0, ge=0, description="每分钟上限，0=系统默认")
    rate_limit_per_hour: int = Field(0, ge=0, description="每小时上限，0=系统默认")
    rate_limit_per_day: int = Field(0, ge=0, description="每日上限，0=系统默认")


class ApiKeyUpdate(BaseModel):
    name: str | None = None
    rate_limit_per_minute: int | None = Field(None, ge=0)
    rate_limit_per_hour: int | None = Field(None, ge=0)
    rate_limit_per_day: int | None = Field(None, ge=0)


class ApiKeyOut(BaseModel):
    id: int
    name: str
    key_prefix: str
    key_value: str | None = None
    user_id: int
    is_active: bool
    rate_limit_per_minute: int = 0
    rate_limit_per_hour: int = 0
    rate_limit_per_day: int = 0
    last_used_at: str | None
    created_at: str
    updated_at: str

    model_config = {"from_attributes": True}


class ApiKeyCreated(BaseModel):
    """Returned only on creation — includes the full key (shown once)."""
    id: int
    name: str
    key_prefix: str
    key: str = Field(..., description="完整 API Key，仅显示一次")


# ─── Endpoints ───

@router.get("", response_model=list[ApiKeyOut])
async def list_api_keys(
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """List all API keys."""
    result = await db.execute(
        select(ApiKey).order_by(ApiKey.created_at.desc())
    )
    keys = result.scalars().all()
    return [_to_out(k) for k in keys]


@router.post("", response_model=ApiKeyCreated, status_code=201)
async def create_api_key(
    body: ApiKeyCreate,
    user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Create a new API key. The full key is returned only once."""
    # Generate key: ak- + 32 random hex chars
    raw_key = f"ak-{secrets.token_hex(16)}"
    prefix = raw_key[:10]  # "ak-" + 7 chars
    key_hash = bcrypt.hashpw(raw_key.encode(), bcrypt.gensalt()).decode()

    api_key = ApiKey(
        name=body.name,
        key_prefix=prefix,
        key_hash=key_hash,
        key_value=raw_key,
        user_id=user["id"],
        rate_limit_per_minute=body.rate_limit_per_minute,
        rate_limit_per_hour=body.rate_limit_per_hour,
        rate_limit_per_day=body.rate_limit_per_day,
    )
    db.add(api_key)
    await db.commit()
    await db.refresh(api_key)

    logger.info("api_key_created", name=body.name, prefix=prefix, user=user["username"])

    return ApiKeyCreated(
        id=api_key.id,
        name=api_key.name,
        key_prefix=prefix,
        key=raw_key,
    )


@router.patch("/{key_id}", response_model=ApiKeyOut)
async def update_api_key(
    key_id: int,
    body: ApiKeyUpdate,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Update API key settings (name, rate limits)."""
    api_key = await db.get(ApiKey, key_id)
    if not api_key:
        raise HTTPException(status_code=404, detail="API Key 不存在")

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(api_key, field, value)
    await db.commit()
    await db.refresh(api_key)
    return _to_out(api_key)


@router.patch("/{key_id}/revoke", response_model=ApiKeyOut)
async def revoke_api_key(
    key_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Revoke (deactivate) an API key."""
    api_key = await db.get(ApiKey, key_id)
    if not api_key:
        raise HTTPException(status_code=404, detail="API Key 不存在")

    api_key.is_active = False
    await db.commit()
    await db.refresh(api_key)

    logger.info("api_key_revoked", id=key_id, name=api_key.name)
    return _to_out(api_key)


@router.delete("/{key_id}", status_code=204)
async def delete_api_key(
    key_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Permanently delete an API key."""
    api_key = await db.get(ApiKey, key_id)
    if not api_key:
        raise HTTPException(status_code=404, detail="API Key 不存在")

    await db.delete(api_key)
    await db.commit()

    logger.info("api_key_deleted", id=key_id, name=api_key.name)


# ─── Helpers ───

def _to_out(k: ApiKey) -> ApiKeyOut:
    return ApiKeyOut(
        id=k.id,
        name=k.name,
        key_prefix=k.key_prefix,
        key_value=k.key_value,
        user_id=k.user_id,
        is_active=k.is_active,
        rate_limit_per_minute=k.rate_limit_per_minute,
        rate_limit_per_hour=k.rate_limit_per_hour,
        rate_limit_per_day=k.rate_limit_per_day,
        last_used_at=to_iso(k.last_used_at),
        created_at=to_iso(k.created_at),
        updated_at=to_iso(k.updated_at),
    )
