"""Dashboard API — GPU monitoring, API call stats, request trends."""

import asyncio
import subprocess
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func as sa_func, case
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_role
from app.core.database import get_db
from app.models.chat_log import ChatLog
from app.models.llm_service import LLMService
from app.models.api_key import ApiKey

logger = logging.getLogger(__name__)

router = APIRouter()

CurrentUser = Annotated[dict, Depends(get_current_user)]
AdminUser = Annotated[dict, Depends(require_role("admin"))]


def _safe_float(val: str) -> float | None:
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _query_gpu_stats() -> list[dict]:
    """Query nvidia-smi for GPU stats."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return []

        gpus = []
        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 6:
                continue
            gpu = {
                "index": int(parts[0]),
                "name": parts[1],
                "memory_used_mb": _safe_float(parts[2]),
                "memory_total_mb": _safe_float(parts[3]),
                "utilization_pct": _safe_float(parts[4]),
                "temperature_c": _safe_float(parts[5]),
            }
            if len(parts) >= 8:
                gpu["power_draw_w"] = _safe_float(parts[6])
                gpu["power_limit_w"] = _safe_float(parts[7])
            if gpu["memory_total_mb"] and gpu["memory_total_mb"] > 0:
                gpu["memory_pct"] = round(gpu["memory_used_mb"] / gpu["memory_total_mb"] * 100, 1)
            else:
                gpu["memory_pct"] = 0
            gpus.append(gpu)
        return gpus
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception) as e:
        logger.warning("nvidia_smi_failed: %s", e)
        return []


@router.get("/gpu-stats")
async def get_gpu_stats(_user: CurrentUser):
    """Real-time GPU stats from nvidia-smi (or via GPU Agent in container mode)."""
    from app.core.config import settings
    if settings.IS_CONTAINERIZED and settings.GPU_AGENT_URL:
        return await _fetch_gpu_stats_from_agent()
    gpus = await asyncio.to_thread(_query_gpu_stats)
    return {"gpus": gpus, "count": len(gpus)}


async def _fetch_gpu_stats_from_agent() -> dict:
    import httpx
    from app.core.config import settings
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5, connect=2)) as client:
            resp = await client.get(f"{settings.GPU_AGENT_URL}/gpu-stats")
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        logger.warning("gpu_agent_failed: %s", e)
    return {"gpus": [], "count": 0}


@router.get("/overview")
async def get_overview(
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Dashboard overview: service count, today's requests, active keys."""
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    # Service count
    svc_count = (await db.execute(
        select(sa_func.count(LLMService.id)).where(LLMService.status == "enabled")
    )).scalar() or 0

    # Today's request stats
    today_result = await db.execute(
        select(
            sa_func.count(ChatLog.id),
            sa_func.sum(case((ChatLog.status == "success", 1), else_=0)),
            sa_func.sum(case((ChatLog.status == "error", 1), else_=0)),
            sa_func.sum(ChatLog.total_tokens),
            sa_func.avg(ChatLog.latency_ms),
        ).where(ChatLog.created_at >= today_start)
    )
    row = today_result.one()

    # Active API keys
    active_keys = (await db.execute(
        select(sa_func.count(ApiKey.id)).where(ApiKey.is_active.is_(True))
    )).scalar() or 0

    return {
        "services": svc_count,
        "today_requests": row[0] or 0,
        "today_success": row[1] or 0,
        "today_errors": row[2] or 0,
        "today_tokens": row[3] or 0,
        "avg_latency_ms": round(row[4] or 0, 1),
        "active_keys": active_keys,
    }


@router.get("/request-trend")
async def get_request_trend(
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
    days: int = Query(7, ge=1, le=90),
):
    """Hourly request counts for trend chart."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    result = await db.execute(
        select(ChatLog.created_at, ChatLog.status).where(
            ChatLog.created_at >= cutoff,
        )
    )

    hourly: dict[str, dict] = defaultdict(lambda: {"count": 0, "success": 0, "error": 0})
    for created_at, status in result.all():
        if created_at:
            hour_key = created_at.strftime("%Y-%m-%dT%H:00")
            hourly[hour_key]["count"] += 1
            if status == "success":
                hourly[hour_key]["success"] += 1
            else:
                hourly[hour_key]["error"] += 1

    trend = [{"hour": k, **v} for k, v in sorted(hourly.items())]
    return {"days": days, "trend": trend}


@router.get("/model-distribution")
async def get_model_distribution(
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Request count per model for pie chart."""
    result = await db.execute(
        select(ChatLog.model, sa_func.count(ChatLog.id))
        .group_by(ChatLog.model)
    )
    distribution = [{"model": row[0], "count": row[1]} for row in result.all()]
    distribution.sort(key=lambda x: -x["count"])
    return distribution


@router.get("/token-usage-daily")
async def get_token_usage_daily(
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
    days: int = Query(14, ge=1, le=90),
):
    """Daily token usage for bar chart."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    result = await db.execute(
        select(ChatLog.created_at, ChatLog.prompt_tokens, ChatLog.completion_tokens)
        .where(ChatLog.created_at >= cutoff)
    )

    daily: dict[str, dict] = defaultdict(lambda: {"prompt": 0, "completion": 0, "total": 0, "requests": 0})
    for created_at, prompt, completion in result.all():
        if created_at:
            day = created_at.strftime("%Y-%m-%d")
            daily[day]["prompt"] += prompt or 0
            daily[day]["completion"] += completion or 0
            daily[day]["total"] += (prompt or 0) + (completion or 0)
            daily[day]["requests"] += 1

    usage = [{"date": k, **v} for k, v in sorted(daily.items())]
    return {"days": days, "usage": usage}


@router.get("/recent-requests")
async def list_recent_requests(
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    model: str | None = Query(None),
    status: str | None = Query(None),
):
    """Paginated recent API calls. Admin only."""
    query = select(ChatLog)
    count_query = select(sa_func.count(ChatLog.id))

    if model:
        query = query.where(ChatLog.model == model)
        count_query = count_query.where(ChatLog.model == model)
    if status:
        query = query.where(ChatLog.status == status)
        count_query = count_query.where(ChatLog.status == status)

    total = (await db.execute(count_query)).scalar() or 0
    offset = (page - 1) * page_size
    query = query.order_by(ChatLog.created_at.desc()).offset(offset).limit(page_size)
    result = await db.execute(query)
    logs = result.scalars().all()

    items = []
    for log in logs:
        items.append({
            "id": log.id,
            "request_id": log.request_id,
            "model": log.model,
            "endpoint_type": log.endpoint_type,
            "stream": log.stream,
            "status": log.status,
            "api_key_name": log.api_key_name,
            "prompt_tokens": log.prompt_tokens,
            "completion_tokens": log.completion_tokens,
            "total_tokens": log.total_tokens,
            "latency_ms": log.latency_ms,
            "time_to_first_token_ms": log.time_to_first_token_ms,
            "error_message": log.error_message,
            "created_at": log.created_at.isoformat() if log.created_at else None,
        })

    return {"total": total, "page": page, "page_size": page_size, "items": items}
