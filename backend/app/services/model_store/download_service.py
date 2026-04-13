"""Download management service — CRUD for model downloads + publish to registry."""

import logging

from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.model_download import ModelDownload
from app.models.model_entity import ModelEntity
from app.models.inference_service import InferenceService
from app.schemas.model_store import DownloadCreate, PublishRequest

logger = logging.getLogger(__name__)

_GPU_PORT_START = 8001
_GPU_PORT_END = 8099


async def _next_available_port(db: AsyncSession) -> int:
    """Find the next available GPU service port by scanning existing endpoints."""
    result = await db.execute(select(InferenceService.endpoint))
    used_ports: set[int] = set()
    for (endpoint,) in result.all():
        if endpoint:
            try:
                from urllib.parse import urlparse
                p = urlparse(endpoint).port
                if p:
                    used_ports.add(p)
            except Exception:
                pass
    for port in range(_GPU_PORT_START, _GPU_PORT_END + 1):
        if port not in used_ports:
            return port
    raise ValueError("没有可用的 GPU 服务端口 (8001-8099 已全部占用)")


class DownloadService:

    @staticmethod
    async def reset_stuck_downloads(engine):
        """Reset downloads stuck in pending/downloading after server restart."""
        from sqlalchemy import text, update
        from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

        try:
            async with AsyncSession(engine, expire_on_commit=False) as db:
                result = await db.execute(
                    update(ModelDownload)
                    .where(ModelDownload.status.in_(["pending", "downloading", "verifying"]))
                    .values(status="failed", error_message="服务重启，下载中断（可重试）")
                )
                if result.rowcount > 0:
                    await db.commit()
                    import logging
                    logging.getLogger(__name__).info(
                        "Reset %d stuck download(s) to failed", result.rowcount
                    )
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning("Failed to reset stuck downloads: %s", e)

    @staticmethod
    async def create(
        db: AsyncSession, data: DownloadCreate, created_by: str,
    ) -> ModelDownload:
        # Check for duplicate active download
        existing = await db.execute(
            select(ModelDownload).where(
                ModelDownload.model_id == data.model_id,
                ModelDownload.source == data.source,
                ModelDownload.status.in_(["pending", "downloading", "verifying"]),
            )
        )
        if existing.scalars().first():
            raise ValueError(f"模型 {data.model_id} 正在下载中")

        dl = ModelDownload(
            source=data.source,
            model_id=data.model_id,
            model_name=data.model_name,
            model_family=data.model_family,
            total_size=data.total_size,
            status="pending",
            created_by=created_by,
        )
        db.add(dl)
        await db.flush()
        await db.refresh(dl)
        return dl

    @staticmethod
    async def get(db: AsyncSession, download_id: int) -> ModelDownload | None:
        return await db.get(ModelDownload, download_id)

    @staticmethod
    async def list_downloads(
        db: AsyncSession,
        page: int = 1,
        page_size: int = 20,
        status: str | None = None,
    ) -> tuple[list[ModelDownload], int]:
        query = select(ModelDownload)
        count_query = select(sa_func.count(ModelDownload.id))

        if status:
            query = query.where(ModelDownload.status == status)
            count_query = count_query.where(ModelDownload.status == status)

        total = (await db.execute(count_query)).scalar() or 0
        offset = (page - 1) * page_size
        query = query.order_by(ModelDownload.created_at.desc()).offset(offset).limit(page_size)
        result = await db.execute(query)
        return list(result.scalars().all()), total

    @staticmethod
    async def update_progress(
        db: AsyncSession,
        download_id: int,
        status: str | None = None,
        progress: float | None = None,
        downloaded_size: int | None = None,
        download_path: str | None = None,
        error_message: str | None = None,
        celery_task_id: str | None = None,
    ) -> ModelDownload | None:
        dl = await db.get(ModelDownload, download_id)
        if not dl:
            return None
        if status is not None:
            dl.status = status
        if progress is not None:
            dl.progress = progress
        if downloaded_size is not None:
            dl.downloaded_size = downloaded_size
        if download_path is not None:
            dl.download_path = download_path
        if error_message is not None:
            dl.error_message = error_message
        if celery_task_id is not None:
            dl.celery_task_id = celery_task_id
        await db.flush()
        await db.refresh(dl)
        return dl

    @staticmethod
    async def publish(
        db: AsyncSession,
        download_id: int,
        data: PublishRequest,
        created_by: str,
    ) -> tuple[ModelEntity, InferenceService | None]:
        """Publish a downloaded model to the model registry, optionally creating an inference service."""
        dl = await db.get(ModelDownload, download_id)
        if not dl:
            raise ValueError("下载记录不存在")
        if dl.status != "completed":
            raise ValueError("模型尚未下载完成")
        if dl.registered_model_id:
            raise ValueError("模型已发布，请勿重复操作")

        # 1. Register model entity
        model = ModelEntity(
            name=dl.model_name,
            family=dl.model_family or _guess_family(dl.model_id),
            runtime_type=data.runtime_type,
            version=data.version,
            artifact_uri=dl.download_path,
            base_model=dl.model_id,
            description=data.description or f"从 {dl.source} 下载: {dl.model_id}",
            tags=["downloaded", dl.source],
            status="active",
        )
        db.add(model)
        await db.flush()
        await db.refresh(model)

        # Link download to model
        dl.registered_model_id = model.id
        await db.flush()

        # 2. Optionally create inference service
        service = None
        if data.create_service:
            # Auto-assign port if not specified
            port = data.service_port
            if not port:
                port = await _next_available_port(db)

            svc_name = dl.model_name.lower().replace(" ", "-").replace("/", "-")

            # Check if engine already exists for this model
            existing = (await db.execute(
                select(InferenceService).where(InferenceService.display_name == dl.model_name)
            )).scalars().first()
            if existing:
                raise ValueError(f"引擎 {dl.model_name} 已存在 (id={existing.id})，请勿重复创建")

            endpoint = f"http://localhost:{port}/v1"
            gpu_arg = f"--tensor-parallel-size 1"
            if data.gpu_device:
                gpu_arg = f"--tensor-parallel-size 1"  # CUDA_VISIBLE_DEVICES set in extra_env

            from app.core.config import settings
            vllm_python = settings.VLLM_PYTHON_PATH

            exec_cmd = (
                f"{vllm_python} -m vllm.entrypoints.openai.api_server "
                f"--model {dl.download_path} "
                f"--port {port} "
                f"--trust-remote-code "
                f"{gpu_arg}"
            )
            if data.quantization and data.quantization != "auto":
                exec_cmd += f" --quantization {data.quantization}"

            service = InferenceService(
                name=svc_name,
                display_name=dl.model_name,
                service_type="gpu",
                endpoint=endpoint,
                model_name=dl.model_name,
                model_path=dl.download_path,
                gpu_device=data.gpu_device,
                algorithms=["qwen"],  # Default for Qwen family
                exec_command=exec_cmd,
                description=f"Auto-created from model store: {dl.model_id}",
                extra_env={"CUDA_VISIBLE_DEVICES": data.gpu_device or "0"},
                status="enabled",
                created_by=created_by,
            )
            db.add(service)
            await db.flush()
            await db.refresh(service)

        return model, service

    @staticmethod
    async def delete(db: AsyncSession, download_id: int) -> bool:
        dl = await db.get(ModelDownload, download_id)
        if not dl:
            return False
        if dl.status in ("pending", "downloading"):
            raise ValueError("请先取消下载再删除")
        await db.delete(dl)
        await db.flush()
        return True


def _guess_family(model_id: str) -> str:
    """Guess model family from model_id."""
    lower = model_id.lower()
    if "qwen" in lower:
        return "qwen"
    if "chatts" in lower:
        return "chatts"
    if "llama" in lower:
        return "llama"
    return "other"
