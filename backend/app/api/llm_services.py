"""LLM Service management API — CRUD for vLLM backend instances."""

import logging
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_role, get_db
from app.models.llm_service import LLMService
from app.services.llm_router import invalidate_cache

logger = logging.getLogger(__name__)

router = APIRouter()

AdminUser = Annotated[dict, Depends(require_role("admin"))]
CurrentUser = Annotated[dict, Depends(get_current_user)]


class ServiceCreate(BaseModel):
    name: str
    display_name: str
    endpoint: str
    model_name: str | None = None
    model_path: str | None = None
    gpu_device: str | None = None
    description: str | None = None
    exec_command: str | None = None
    work_dir: str | None = None
    extra_env: dict | None = None


class ServiceUpdate(BaseModel):
    display_name: str | None = None
    endpoint: str | None = None
    model_name: str | None = None
    model_path: str | None = None
    gpu_device: str | None = None
    description: str | None = None
    exec_command: str | None = None
    work_dir: str | None = None
    extra_env: dict | None = None
    status: str | None = None


def _to_dict(svc: LLMService) -> dict:
    return {
        "id": svc.id,
        "name": svc.name,
        "display_name": svc.display_name,
        "endpoint": svc.endpoint,
        "model_name": svc.model_name,
        "model_path": svc.model_path,
        "gpu_device": svc.gpu_device,
        "description": svc.description,
        "exec_command": svc.exec_command,
        "work_dir": svc.work_dir,
        "extra_env": svc.extra_env,
        "status": svc.status,
        "created_by": svc.created_by,
        "created_at": svc.created_at.isoformat() if svc.created_at else None,
        "updated_at": svc.updated_at.isoformat() if svc.updated_at else None,
    }


@router.get("")
async def list_services(
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
    status: str | None = Query(None),
):
    query = select(LLMService)
    if status:
        query = query.where(LLMService.status == status)
    query = query.order_by(LLMService.id)
    result = await db.execute(query)
    return [_to_dict(svc) for svc in result.scalars().all()]


@router.get("/{service_id}")
async def get_service(
    service_id: int,
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    svc = await db.get(LLMService, service_id)
    if not svc:
        raise HTTPException(404, detail="Service not found")
    return _to_dict(svc)


@router.post("", status_code=201)
async def create_service(
    body: ServiceCreate,
    user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    svc = LLMService(
        **body.model_dump(),
        created_by=user["username"],
    )
    db.add(svc)
    await db.commit()
    await db.refresh(svc)
    invalidate_cache()
    return _to_dict(svc)


@router.put("/{service_id}")
async def update_service(
    service_id: int,
    body: ServiceUpdate,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    svc = await db.get(LLMService, service_id)
    if not svc:
        raise HTTPException(404, detail="Service not found")

    for key, val in body.model_dump(exclude_none=True).items():
        setattr(svc, key, val)
    await db.commit()
    await db.refresh(svc)
    invalidate_cache()
    return _to_dict(svc)


@router.delete("/{service_id}")
async def delete_service(
    service_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    svc = await db.get(LLMService, service_id)
    if not svc:
        raise HTTPException(404, detail="Service not found")
    await db.delete(svc)
    await db.commit()
    invalidate_cache()
    return {"ok": True}


@router.get("/{service_id}/health")
async def check_health(
    service_id: int,
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Check if the vLLM backend is reachable and list its models."""
    svc = await db.get(LLMService, service_id)
    if not svc:
        raise HTTPException(404, detail="Service not found")

    endpoint = svc.endpoint.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5, connect=2)) as client:
            resp = await client.get(f"{endpoint}/v1/models")
        if resp.status_code == 200:
            data = resp.json()
            models = [m.get("id") for m in data.get("data", [])]
            return {
                "healthy": True,
                "endpoint": endpoint,
                "models": models,
            }
        return {"healthy": False, "endpoint": endpoint, "error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"healthy": False, "endpoint": endpoint, "error": str(e)[:200]}
