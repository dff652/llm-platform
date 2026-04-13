"""Model management API routes."""

import structlog
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_role
from app.core.database import get_db
from app.models.model_entity import ModelEntity
from app.models.model_version import ModelVersion
from app.models.llm_service import LLMService
from app.schemas.model_entity import (
    ModelCreate,
    ModelListResponse,
    ModelResponse,
    ModelUpdate,
)
from app.services.model_service import ModelService

logger = structlog.get_logger(__name__)

router = APIRouter()

CurrentUser = Annotated[dict, Depends(get_current_user)]
AdminUser = Annotated[dict, Depends(require_role("admin"))]


@router.post("", response_model=ModelResponse, status_code=status.HTTP_201_CREATED)
async def create_model(
    data: ModelCreate,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    model = await ModelService.create(db, data)
    await db.commit()
    await db.refresh(model)
    return model


@router.get("", response_model=ModelListResponse)
async def list_models(
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    family: str | None = None,
    model_status: str | None = Query(None, alias="status"),
):
    items, total = await ModelService.list_models(db, page, page_size, family, model_status)
    return ModelListResponse(
        total=total,
        page=page,
        page_size=page_size,
        items=[ModelResponse.model_validate(m) for m in items],
    )


@router.get("/{model_id}", response_model=ModelResponse)
async def get_model(
    model_id: int,
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    model = await ModelService.get(db, model_id)
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    return model


@router.put("/{model_id}", response_model=ModelResponse)
async def update_model(
    model_id: int,
    data: ModelUpdate,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    model = await ModelService.update(db, model_id, data)
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    await db.commit()
    await db.refresh(model)
    return model


@router.delete("/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_model(
    model_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    model = await ModelService.get(db, model_id)
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")

    # Delete associated LLM services
    services = (await db.execute(
        select(LLMService).where(LLMService.model_name == model.name)
    )).scalars().all()
    for svc in services:
        await db.delete(svc)

    await db.delete(model)
    await db.commit()
