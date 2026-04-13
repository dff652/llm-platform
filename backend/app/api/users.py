"""User management API routes (admin only)."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.core.database import get_db
from app.schemas.user import (
    UserCreate,
    UserListResponse,
    UserOut,
    UserResetPassword,
    UserUpdate,
)
from app.services import user_service

router = APIRouter()

AdminUser = Annotated[dict, Depends(require_role("admin"))]


@router.get("", response_model=UserListResponse)
async def list_users(
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    role: str | None = None,
    keyword: str | None = None,
):
    users, total = await user_service.list_users(db, page, page_size, role, keyword)
    return UserListResponse(
        total=total,
        page=page,
        page_size=page_size,
        items=[UserOut.model_validate(u) for u in users],
    )


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def create_user(
    data: UserCreate,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    existing = await user_service.get_user_by_username(db, data.username)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"用户名 '{data.username}' 已存在",
        )
    user = await user_service.create_user(db, data)
    return UserOut.model_validate(user)


@router.get("/{user_id}", response_model=UserOut)
async def get_user(
    user_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    user = await user_service.get_user(db, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    return UserOut.model_validate(user)


@router.put("/{user_id}", response_model=UserOut)
async def update_user(
    user_id: int,
    data: UserUpdate,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    user = await user_service.update_user(db, user_id, data)
    if user is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    return UserOut.model_validate(user)


@router.post("/{user_id}/reset-password")
async def reset_password(
    user_id: int,
    data: UserResetPassword,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    ok = await user_service.reset_password(db, user_id, data.new_password)
    if not ok:
        raise HTTPException(status_code=404, detail="用户不存在")
    return {"detail": "密码已重置"}


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: int,
    current_user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    if current_user["id"] == user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="不能删除自己的账号",
        )
    ok = await user_service.delete_user(db, user_id)
    if not ok:
        raise HTTPException(status_code=404, detail="用户不存在")
