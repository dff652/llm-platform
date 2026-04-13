"""Model management API routes."""

import structlog
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_role
from app.core.database import get_db
from app.models.model_version import ModelVersion
from app.models.model_entity import ModelEntity
from app.models.inference_service import InferenceService
from app.schemas.model_entity import (
    ModelCreate,
    ModelListResponse,
    ModelPublishRequest,
    ModelPublishResponse,
    ModelResponse,
    ModelUpdate,
)
from app.schemas.finetune import ModelVersionResponse
from app.services.model_service import ModelService

logger = structlog.get_logger(__name__)

router = APIRouter()

CurrentUser = Annotated[dict, Depends(get_current_user)]
AdminUser = Annotated[dict, Depends(require_role("admin"))]


async def _auto_register_orphan_engines(db: AsyncSession):
    """Detect GPU engines without a matching model entity and auto-register them.

    An engine is orphaned only if NO model entity shares its family (algorithm).
    This avoids false positives when display_name differs from model name.
    """
    # Get all registered model families
    result = await db.execute(select(ModelEntity.name, ModelEntity.family, ModelEntity.artifact_uri))
    registered_families: set[str] = set()
    registered_paths: set[str] = set()
    registered_names: set[str] = set()
    for name, family, uri in result.all():
        registered_families.add(family)
        registered_names.add(name)
        if uri:
            registered_paths.add(uri)

    # Find GPU engines that have no matching model by family + model_path
    engines = (await db.execute(
        select(InferenceService).where(
            InferenceService.service_type == "gpu",
            InferenceService.status == "enabled",
        )
    )).scalars().all()

    created = 0
    for svc in engines:
        name = svc.display_name or svc.name
        # Skip if name already registered
        if name in registered_names:
            continue
        # Skip if model_path already registered
        if svc.model_path and svc.model_path in registered_paths:
            continue

        family = svc.algorithms[0] if svc.algorithms else "unknown"
        model = ModelEntity(
            name=name,
            family=family,
            runtime_type="gpu",
            version="v1.0",
            artifact_uri=svc.model_path,
            description=f"Auto-registered from orphan engine: {svc.name}",
        )
        db.add(model)
        registered_names.add(name)
        if svc.model_path:
            registered_paths.add(svc.model_path)
        created += 1
        logger.info("auto_registered_orphan_engine", engine=svc.name, model_name=name)

    if created:
        await db.commit()


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


@router.post("/publish", response_model=ModelPublishResponse, status_code=status.HTTP_201_CREATED)
async def publish_model(
    data: ModelPublishRequest,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """发布本地模型目录到模型中心。自动检测模型类型，可选创建推理引擎。"""
    import json as _json
    from pathlib import Path
    from app.core.config import settings

    target = Path(data.path).resolve()

    # 路径安全检查
    allowed_roots = [d.strip() for d in settings.MODEL_PUBLISH_ALLOWED_DIRS.split(",") if d.strip()]
    if settings.MODEL_DOWNLOAD_DIR:
        allowed_roots.append(str(Path(settings.MODEL_DOWNLOAD_DIR).resolve()))
    if not any(str(target).startswith(str(Path(r).resolve())) for r in allowed_roots):
        raise HTTPException(400, f"路径不在允许范围内，允许: {', '.join(allowed_roots)}")
    if not target.is_dir():
        raise HTTPException(400, f"路径不存在或不是目录: {data.path}")

    # 检测模型类型
    model_type = "unknown"
    base_model = None
    if (target / "adapter_config.json").exists():
        model_type = "adapter"
        try:
            cfg = _json.loads((target / "adapter_config.json").read_text())
            base_model = cfg.get("base_model_name_or_path", "")
        except Exception:
            pass
    elif (target / "config.json").exists():
        model_type = "full"

    # 模型名称
    name = data.name or target.name

    # 查重
    existing = await db.execute(select(ModelEntity).where(ModelEntity.name == name))
    if existing.scalars().first():
        raise HTTPException(400, f"模型名称已存在: {name}")

    # 创建模型记录
    model = ModelEntity(
        name=name,
        family=data.family,
        runtime_type=data.runtime_type,
        version=data.version,
        artifact_uri=str(target),
        base_model=base_model,
        tags=[model_type, "local"],
        description=data.description or f"本地发布: {target.name}",
        status="active",
    )
    db.add(model)
    await db.flush()
    await db.refresh(model)

    # 可选：自动创建推理引擎
    service_id = None
    if data.create_service and model_type != "adapter":
        port = data.service_port or 8003
        svc = InferenceService(
            name=f"svc-{name}",
            display_name=name,
            service_type=data.runtime_type,
            endpoint=f"http://localhost:{port}/v1",
            model_name=name,
            model_path=str(target),
            gpu_device=data.gpu_device,
            algorithms=[data.family],
            status="enabled",
            created_by=_user["username"],
        )
        db.add(svc)
        await db.flush()
        service_id = svc.id

    # 自动创建默认配置：从同算法的已有配置复制，或创建空配置
    from app.models.config_template import InferenceConfigTemplate
    existing_cfg = (await db.execute(
        select(InferenceConfigTemplate)
        .where(InferenceConfigTemplate.algorithm_name == data.family, InferenceConfigTemplate.model_id.is_(None))
        .order_by(InferenceConfigTemplate.enabled.desc())
        .limit(1)
    )).scalars().first()

    if existing_cfg:
        # 从算法默认配置复制
        new_cfg = InferenceConfigTemplate(
            name=f"{name} 默认配置",
            algorithm_id=existing_cfg.algorithm_id,
            algorithm_name=data.family,
            model_id=model.id,
            default_params=existing_cfg.default_params,
            validation_schema=existing_cfg.validation_schema,
            env_profile=existing_cfg.env_profile,
            resource_profile=existing_cfg.resource_profile,
            enabled=True,
        )
    else:
        new_cfg = InferenceConfigTemplate(
            name=f"{name} 默认配置",
            algorithm_name=data.family,
            model_id=model.id,
            enabled=True,
        )
    db.add(new_cfg)

    await db.commit()
    await db.refresh(model)

    logger.info("model_published", name=name, path=str(target),
                model_type=model_type, service_created=bool(service_id))

    return ModelPublishResponse(
        model=ModelResponse.model_validate(model),
        model_type=model_type,
        service_created=bool(service_id),
        service_id=service_id,
    )


@router.get("/vllm/status")
async def vllm_status(_user: CurrentUser):
    """Check health of vLLM serving endpoints."""
    from app.adapters.vllm_backend import check_vllm_health
    return {
        "chatts": await check_vllm_health("chatts"),
        "qwen": await check_vllm_health("qwen"),
    }


@router.get("/{model_id}", response_model=ModelResponse)
async def get_model(
    model_id: int,
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    model = await ModelService.get(db, model_id)
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")
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
        raise HTTPException(status_code=404, detail="模型不存在")
    await db.commit()
    await db.refresh(model)
    return model


@router.post("/{model_id}/activate", response_model=ModelResponse)
async def activate_model(
    model_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    model = await ModelService.set_status(db, model_id, "active")
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")
    await db.commit()
    await db.refresh(model)
    return model


@router.post("/{model_id}/archive", response_model=ModelResponse)
async def archive_model(
    model_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    model = await ModelService.set_status(db, model_id, "archived")
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")
    await db.commit()
    await db.refresh(model)
    return model


@router.delete("/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_model(
    model_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
    delete_files: bool = Query(False, description="同时删除本地模型文件"),
):
    """彻底删除模型：删注册记录 + 删关联引擎 + 可选删文件。"""
    from app.models.model_download import ModelDownload

    model = await ModelService.get(db, model_id)
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")

    # Find and delete associated inference services
    services = (await db.execute(
        select(InferenceService).where(InferenceService.model_name == model.name)
    )).scalars().all()
    for svc in services:
        await db.delete(svc)

    # Find associated download record
    dl_result = await db.execute(
        select(ModelDownload).where(ModelDownload.registered_model_id == model_id)
    )
    dl = dl_result.scalars().first()

    if dl:
        # Optionally delete files
        if delete_files and dl.download_path:
            import shutil
            from pathlib import Path
            path = Path(dl.download_path)
            if path.exists():
                if path.is_dir():
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    path.unlink(missing_ok=True)
            # Also delete download record
            await db.delete(dl)
        else:
            # Unlink download from model but keep the record
            dl.registered_model_id = None

    # Delete model entity
    await db.delete(model)
    await db.commit()

    logger.info("model_deleted", model_id=model_id, name=model.name,
                services_deleted=len(services), files_deleted=delete_files)


@router.get("/{model_id}/dependencies")
async def get_model_dependencies(
    model_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """查询模型的关联依赖（引擎、下载记录）。"""
    from app.models.model_download import ModelDownload

    model = await ModelService.get(db, model_id)
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")

    services = (await db.execute(
        select(InferenceService).where(InferenceService.model_name == model.name)
    )).scalars().all()

    dl_result = await db.execute(
        select(ModelDownload).where(ModelDownload.registered_model_id == model_id)
    )
    dl = dl_result.scalars().first()

    return {
        "model": {"id": model.id, "name": model.name},
        "services": [
            {"id": s.id, "name": s.display_name or s.name, "endpoint": s.endpoint}
            for s in services
        ],
        "download": {
            "id": dl.id,
            "path": dl.download_path,
            "size": dl.total_size,
        } if dl else None,
    }


# ===== 模型版本端点 =====


@router.get("/{model_id}/versions", response_model=list[ModelVersionResponse])
async def list_model_versions(
    model_id: int,
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """获取指定模型的版本历史列表。"""
    model = await ModelService.get(db, model_id)
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")
    query = (
        select(ModelVersion)
        .where(ModelVersion.model_id == model_id)
        .order_by(ModelVersion.created_at.desc())
    )
    result = await db.execute(query)
    return [ModelVersionResponse.model_validate(v) for v in result.scalars().all()]


@router.post(
    "/{model_id}/versions/{version_id}/activate",
    response_model=ModelVersionResponse,
)
async def activate_model_version(
    model_id: int,
    version_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """激活指定版本（回滚），同时取消该模型其他版本的激活状态。"""
    version = await db.get(ModelVersion, version_id)
    if not version or version.model_id != model_id:
        raise HTTPException(status_code=404, detail="版本不存在")

    # 取消该模型所有版本的激活状态
    all_versions_q = select(ModelVersion).where(ModelVersion.model_id == model_id)
    result = await db.execute(all_versions_q)
    for v in result.scalars().all():
        v.is_active = False

    # 激活目标版本
    version.is_active = True
    await db.commit()
    await db.refresh(version)
    return version


# ===== 模型 ↔ 引擎关联 =====


@router.get("/{model_id}/services")
async def get_model_services(
    model_id: int,
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """查询与模型关联的推理引擎（通过 model_path / artifact_uri 匹配）。"""
    model = await ModelService.get(db, model_id)
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")

    # Match by model_path containing artifact_uri
    services = []
    if model.artifact_uri:
        result = await db.execute(
            select(InferenceService).where(
                InferenceService.model_path == model.artifact_uri
            )
        )
        services = result.scalars().all()

    return [{
        "id": s.id,
        "name": s.name,
        "display_name": s.display_name,
        "endpoint": s.endpoint,
        "status": s.status,
        "model_path": s.model_path,
    } for s in services]


class DeployRequest(BaseModel):
    service_id: int = Field(..., description="目标引擎 ID")


@router.post("/{model_id}/versions/{version_id}/deploy")
async def deploy_version_to_service(
    model_id: int,
    version_id: int,
    body: DeployRequest,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """部署模型版本到指定引擎 — 更新引擎 model_path 并标记版本为活跃。"""
    model = await ModelService.get(db, model_id)
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")

    version = await db.get(ModelVersion, version_id)
    if not version or version.model_id != model_id:
        raise HTTPException(status_code=404, detail="版本不存在")

    service = await db.get(InferenceService, body.service_id)
    if not service:
        raise HTTPException(status_code=404, detail="引擎不存在")

    # Determine artifact path: version's own artifact_uri, or model's
    artifact = version.artifact_uri or model.artifact_uri
    if not artifact:
        raise HTTPException(status_code=400, detail="模型没有可部署的路径 (artifact_uri)")

    # Update service model_path
    old_path = service.model_path
    service.model_path = artifact

    # Update exec_command if it contains the old model path
    if service.exec_command and old_path and old_path in service.exec_command:
        service.exec_command = service.exec_command.replace(old_path, artifact)

    # Activate this version, deactivate others
    all_versions = await db.execute(
        select(ModelVersion).where(ModelVersion.model_id == model_id)
    )
    for v in all_versions.scalars().all():
        v.is_active = (v.id == version_id)

    # Update model's current version
    model.version = version.version_tag

    await db.commit()

    logger.info("model_deployed",
                model=model.name, version=version.version_tag,
                service=service.display_name, artifact=artifact)

    return {
        "success": True,
        "message": f"版本 {version.version_tag} 已部署到 {service.display_name}",
        "service_id": service.id,
        "model_path": artifact,
        "note": "引擎需要重启才能加载新模型",
    }
