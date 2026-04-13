"""Auth API routes: login, me, change-password."""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.schemas.auth import ChangePasswordRequest, LoginRequest, LoginResponse, UserBrief
from app.services import auth_service, user_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/login", response_model=LoginResponse)
async def login(data: LoginRequest, request: Request, db: Annotated[AsyncSession, Depends(get_db)]):
    user = await auth_service.authenticate(db, data.username, data.password)
    if user is None:
        logger.warning("login_failed: username=%s, ip=%s", data.username, request.client.host if request.client else "unknown")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误",
        )

    logger.info("login_success: username=%s, role=%s", user.username, user.role)
    token = auth_service.generate_token(user)
    return LoginResponse(
        access_token=token,
        user=UserBrief(
            id=user.id,
            username=user.username,
            display_name=user.display_name,
            role=user.role,
        ),
    )


@router.get("/me", response_model=UserBrief)
async def get_me(
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    user = await user_service.get_user(db, current_user["id"])
    if user is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    return UserBrief.model_validate(user)


@router.post("/change-password")
async def change_password(
    data: ChangePasswordRequest,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    ok = await auth_service.change_password(
        db, current_user["id"], data.old_password, data.new_password
    )
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="原密码错误",
        )
    return {"detail": "密码修改成功"}
