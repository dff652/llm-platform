"""System configuration API — read/write global settings."""

from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.core.database import get_db
from app.models.system_config import SystemConfig

logger = structlog.get_logger(__name__)

router = APIRouter()

AdminUser = Annotated[dict, Depends(require_role("admin"))]

# ─── Default values ───

DEFAULTS = {
    # API 限流（-1 = 不限制，0 = 禁止调用，单个 Key 可在 API 密钥页覆盖）
    "rate_limit_per_minute": ("-1", "API 默认每分钟调用上限（-1 不限制，推荐值 10，0 禁止）"),
    "rate_limit_per_hour": ("-1", "API 默认每小时调用上限（-1 不限制，推荐值 100，0 禁止）"),
    "rate_limit_per_day": ("-1", "API 默认每日调用上限（-1 不限制，推荐值 500，0 禁止）"),
    # 过期清理
    "cleanup_enabled": ("true", "启用自动清理"),
    "cleanup_retention_days": ("30", "结果文件保留天数"),
    # 并发限制（-1 = 不限制，0 = 暂停所有任务，正数 = 最大并发数）
    "max_gpu_concurrency": ("4", "GPU 任务并发 — 仅控制平台内部 Celery GPU 任务队列，不影响外部 API（推荐 4，-1 不限制，0 暂停）"),
    "max_cpu_concurrency": ("8", "CPU 任务并发 — 仅控制平台内部 Celery CPU 任务队列，不影响外部 API（推荐 8，-1 不限制，0 暂停）"),
    "gpu_sync_concurrency": ("4", "外部 API GPU 并发 — 控制外部系统同时调用 GPU 的请求数，超出排队等待（推荐 4，设 1 可确保结果一致，-1 不限制）"),
    # 日志管理
    "log_max_size_mb": ("10", "单个日志文件上限 (MB)"),
    "log_backup_count": ("5", "日志备份文件数量"),
}


# ─── Schemas ───

class ConfigItem(BaseModel):
    key: str
    value: str
    description: str | None = None


class ConfigUpdate(BaseModel):
    configs: list[ConfigItem]


# ─── Endpoints ───

@router.get("")
async def get_all_configs(
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Get all system configs, merged with defaults."""
    result = await db.execute(select(SystemConfig))
    stored = {row.key: {"value": row.value, "description": row.description} for row in result.scalars().all()}

    configs = []
    for key, (default_val, desc) in DEFAULTS.items():
        if key in stored:
            configs.append({
                "key": key,
                "value": stored[key]["value"],
                "description": stored[key]["description"] or desc,
            })
        else:
            configs.append({
                "key": key,
                "value": default_val,
                "description": desc,
            })

    return configs


@router.put("")
async def update_configs(
    body: ConfigUpdate,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Update system configs (upsert)."""
    for item in body.configs:
        if item.key not in DEFAULTS:
            raise HTTPException(status_code=400, detail=f"未知配置项: {item.key}")

    for item in body.configs:
        result = await db.execute(
            select(SystemConfig).where(SystemConfig.key == item.key)
        )
        existing = result.scalars().first()
        if existing:
            existing.value = item.value
        else:
            db.add(SystemConfig(
                key=item.key,
                value=item.value,
                description=item.description or DEFAULTS[item.key][1],
            ))

    await db.commit()
    logger.info("system_config_updated", keys=[c.key for c in body.configs])

    # 热更新：日志配置
    changed_keys = {c.key for c in body.configs}
    if changed_keys & {"log_max_size_mb", "log_backup_count"}:
        from app.core.logging_config import apply_log_settings
        max_mb = int(await get_config_value(db, "log_max_size_mb"))
        backup = int(await get_config_value(db, "log_backup_count"))
        apply_log_settings(max_bytes=max_mb * 1024 * 1024, backup_count=backup)

    # 热更新：限流配置同步到 Redis
    rate_keys = {"rate_limit_per_minute", "rate_limit_per_hour", "rate_limit_per_day"}
    if changed_keys & rate_keys:
        try:
            from app.core.rate_limiter import _get_redis
            r = _get_redis()
            mapping = {}
            for item in body.configs:
                if item.key == "rate_limit_per_minute":
                    mapping["per_minute"] = item.value
                elif item.key == "rate_limit_per_hour":
                    mapping["per_hour"] = item.value
                elif item.key == "rate_limit_per_day":
                    mapping["per_day"] = item.value
            if mapping:
                r.hset("system:rate_limits", mapping=mapping)
                logger.info("rate_limits_synced_to_redis", mapping=mapping)
        except Exception as e:
            logger.warning("rate_limits_redis_sync_failed", error=str(e))

    # 热更新：外部 API GPU 同步并发信号量
    if "gpu_sync_concurrency" in changed_keys:
        from app.api.inference_external import update_gpu_sync_semaphore
        await update_gpu_sync_semaphore()

    return {"updated": len(body.configs)}


# ─── Helper for other modules ───

async def get_config_value(db: AsyncSession, key: str) -> str:
    """Get a single config value, return default if not set."""
    result = await db.execute(
        select(SystemConfig.value).where(SystemConfig.key == key)
    )
    row = result.scalar()
    if row is not None:
        return row
    default = DEFAULTS.get(key)
    return default[0] if default else ""
