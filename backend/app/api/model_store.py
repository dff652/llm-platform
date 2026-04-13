"""Model store API — browse remote models, manage downloads, publish to registry."""

from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = structlog.get_logger(__name__)

from app.api.deps import get_current_user, require_role
from app.core.database import get_db
from app.schemas.model_store import (
    DownloadCreate,
    DownloadListResponse,
    DownloadResponse,
    PublishRequest,
    RemoteModelDetail,
    RemoteModelListResponse,
)
from app.services.model_store.download_service import DownloadService
from app.services.model_store.modelscope_provider import ModelScopeProvider

router = APIRouter()

CurrentUser = Annotated[dict, Depends(get_current_user)]
AdminUser = Annotated[dict, Depends(require_role("admin"))]

# Provider registry
_providers = {
    "modelscope": ModelScopeProvider(),
}


# ===== Disk space check =====


@router.get("/disk-space")
async def check_disk_space(
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Check available disk space for model downloads."""
    import shutil
    from app.core.config import settings
    from pathlib import Path

    # 从 DB 恢复持久化的路径（首次请求时）
    await _restore_download_dir(db)

    download_dir = Path(settings.MODEL_DOWNLOAD_DIR)
    download_dir.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(str(download_dir))
    return {
        "total": usage.total,
        "used": usage.used,
        "free": usage.free,
        "download_dir": str(download_dir),
    }


_dir_restored = False

async def _restore_download_dir(db: AsyncSession):
    """从 system_config 恢复下载路径（仅首次）。"""
    global _dir_restored
    if _dir_restored:
        return
    _dir_restored = True

    from app.core.config import settings
    from app.models.system_config import SystemConfig
    result = await db.execute(
        select(SystemConfig).where(SystemConfig.key == "model_download_dir")
    )
    cfg = result.scalar_one_or_none()
    if cfg and cfg.value:
        settings.MODEL_DOWNLOAD_DIR = cfg.value
        logger.info("download_dir_restored", path=cfg.value)


@router.put("/disk-space")
async def update_download_dir(
    _user: AdminUser,
    body: dict,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Update model download directory. Persists to DB + runtime."""
    from app.core.config import settings
    from app.models.system_config import SystemConfig
    from pathlib import Path

    new_dir = body.get("download_dir", "").strip()
    if not new_dir:
        raise HTTPException(status_code=400, detail="下载路径不能为空")

    path = Path(new_dir)
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"路径无法创建: {e}")

    # Update runtime
    settings.MODEL_DOWNLOAD_DIR = str(path)

    # Persist to DB
    result = await db.execute(
        select(SystemConfig).where(SystemConfig.key == "model_download_dir")
    )
    cfg = result.scalar_one_or_none()
    if cfg:
        cfg.value = str(path)
    else:
        db.add(SystemConfig(key="model_download_dir", value=str(path), description="模型下载路径"))
    await db.commit()

    import shutil
    usage = shutil.disk_usage(str(path))
    return {
        "total": usage.total,
        "used": usage.used,
        "free": usage.free,
        "download_dir": str(path),
    }


@router.get("/browse-dirs")
async def browse_directories(
    _user: AdminUser,
    path: str = Query("/", description="目录路径"),
):
    """Browse server directories for download path selection."""
    from pathlib import Path as P

    target = P(path).resolve()
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"路径不存在: {path}")

    dirs = []
    try:
        for entry in sorted(target.iterdir()):
            if entry.name.startswith('.'):
                continue
            if entry.is_dir():
                dirs.append({"name": entry.name, "path": str(entry)})
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"无权限访问: {path}")

    return {
        "current": str(target),
        "parent": str(target.parent) if target != target.parent else None,
        "dirs": dirs,
    }


# ===== Browse remote models =====


@router.get("/models", response_model=RemoteModelListResponse)
async def search_models(
    _user: CurrentUser,
    source: str = Query("modelscope", pattern=r"^(modelscope|huggingface)$"),  # huggingface: 待实现
    query: str = Query("", max_length=100),
    owner: str = Query("Qwen", max_length=100),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=50),
):
    """Search models from remote source. Default: Qwen family on ModelScope."""
    provider = _providers.get(source)
    if not provider:
        raise HTTPException(status_code=400, detail=f"不支持的模型源: {source}")

    try:
        items, total = await provider.search_models(query, owner, page, page_size)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"请求模型源失败: {e}")

    return RemoteModelListResponse(
        total=total, page=page, page_size=page_size, items=items,
    )


@router.get("/models/{source}/{owner}/{name}")
async def get_model_detail(
    source: str,
    owner: str,
    name: str,
    _user: CurrentUser,
) -> RemoteModelDetail:
    """Get detailed model info (README, files, etc.)."""
    provider = _providers.get(source)
    if not provider:
        raise HTTPException(status_code=400, detail=f"不支持的模型源: {source}")

    model_id = f"{owner}/{name}"
    try:
        detail = await provider.get_model_detail(model_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"请求模型源失败: {e}")

    if not detail:
        raise HTTPException(status_code=404, detail=f"模型 {model_id} 不存在")
    return detail


# ===== Download management =====


@router.get("/downloads", response_model=DownloadListResponse)
async def list_downloads(
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    download_status: str | None = Query(None, alias="status"),
):
    """List all download tasks."""
    items, total = await DownloadService.list_downloads(db, page, page_size, download_status)
    return DownloadListResponse(
        total=total,
        items=[DownloadResponse.model_validate(d) for d in items],
    )


@router.post("/downloads", response_model=DownloadResponse, status_code=status.HTTP_201_CREATED)
async def create_download(
    data: DownloadCreate,
    user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Start downloading a model in a background thread."""
    try:
        dl = await DownloadService.create(db, data, created_by=user["username"])
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))

    await db.commit()
    await db.refresh(dl)

    # Launch background thread download
    from app.tasks.model_download_task import start_download
    from app.core.config import settings

    start_download(dl.id, data.source, data.model_id, settings.MODEL_DOWNLOAD_DIR)

    # Return with updated status (thread will set to 'downloading' in DB,
    # but return 'pending' here since thread may not have committed yet)
    return dl


@router.get("/downloads/{download_id}", response_model=DownloadResponse)
async def get_download(
    download_id: int,
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Get download status."""
    dl = await DownloadService.get(db, download_id)
    if not dl:
        raise HTTPException(status_code=404, detail="下载记录不存在")
    return dl


@router.get("/downloads/{download_id}/logs")
async def get_download_logs(
    download_id: int,
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Get download log (plain text)."""
    from fastapi.responses import PlainTextResponse
    from app.tasks.model_download_task import get_download_log

    dl = await DownloadService.get(db, download_id)
    if not dl:
        raise HTTPException(status_code=404, detail="下载记录不存在")

    log_text = get_download_log(download_id)
    if not log_text:
        log_text = "暂无日志"
        if dl.error_message:
            log_text += f"\n\n错误信息:\n{dl.error_message}"
    return PlainTextResponse(log_text)


@router.get("/downloads/{download_id}/dependencies")
async def get_download_dependencies(
    download_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Get dependencies of a download (model registration, inference services)."""
    from app.models.model_entity import ModelEntity
    from app.models.llm_service import LLMService

    dl = await DownloadService.get(db, download_id)
    if not dl:
        raise HTTPException(status_code=404, detail="下载记录不存在")

    result: dict = {"model": None, "services": []}

    if dl.registered_model_id:
        model = await db.get(ModelEntity, dl.registered_model_id)
        if model:
            result["model"] = {"id": model.id, "name": model.name}

    if dl.download_path:
        services = (await db.execute(
            select(LLMService).where(LLMService.model_path == dl.download_path)
        )).scalars().all()
        result["services"] = [
            {"id": s.id, "name": s.display_name or s.name, "endpoint": s.endpoint}
            for s in services
        ]

    return result


@router.delete("/downloads/{download_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_download(
    download_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Delete model files. Disables (not deletes) associated engines."""
    from app.models.model_entity import ModelEntity
    from app.models.llm_service import LLMService

    dl = await DownloadService.get(db, download_id)
    if not dl:
        raise HTTPException(status_code=404, detail="下载记录不存在")

    # Delete associated inference services
    if dl.download_path:
        services = (await db.execute(
            select(LLMService).where(LLMService.model_path == dl.download_path)
        )).scalars().all()
        for svc in services:
            await db.delete(svc)

    # Delete model registration
    if dl.registered_model_id:
        model = await db.get(ModelEntity, dl.registered_model_id)
        if model:
            await db.delete(model)
        dl.registered_model_id = None

    await db.flush()

    # Cancel active download if running
    if dl.status in ("pending", "downloading"):
        from app.tasks.model_download_task import cancel_download as terminate_download
        terminate_download(dl.id)
        dl.status = "cancelled"
        await db.commit()

    # Clean up files
    if dl.download_path:
        import shutil
        from pathlib import Path
        path = Path(dl.download_path)
        if path.exists():
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)

    # Delete download record
    await db.delete(dl)
    await db.commit()


# ===== Retry failed download =====


@router.post("/downloads/{download_id}/retry", response_model=DownloadResponse)
async def retry_download(
    download_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Retry a failed/cancelled download. ModelScope SDK auto-resumes partial files."""
    dl = await DownloadService.get(db, download_id)
    if not dl:
        raise HTTPException(status_code=404, detail="下载记录不存在")
    if dl.status not in ("failed", "cancelled", "pending"):
        raise HTTPException(status_code=400, detail=f"当前状态 {dl.status} 不可重试")

    # Reset status and launch background thread
    dl.status = "downloading"
    dl.error_message = None
    dl.progress = 0.0
    await db.commit()
    await db.refresh(dl)

    from app.tasks.model_download_task import start_download
    from app.core.config import settings

    start_download(dl.id, dl.source, dl.model_id, settings.MODEL_DOWNLOAD_DIR)

    return dl


# ===== Publish (deploy) =====


@router.post("/downloads/{download_id}/publish", response_model=dict)
async def publish_model(
    download_id: int,
    data: PublishRequest,
    user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Publish a downloaded model to the model registry and optionally create inference service."""
    try:
        model, service = await DownloadService.publish(
            db, download_id, data, created_by=user["username"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    await db.commit()
    await db.refresh(model)

    result = {
        "model_id": model.id,
        "model_name": model.name,
        "message": f"模型 {model.name} 已发布到模型中心",
    }
    if service:
        await db.refresh(service)
        result["service_id"] = service.id
        result["service_name"] = service.name
        result["endpoint"] = service.endpoint
        result["message"] += f"，推理引擎 {service.display_name} 已创建"

    return result
