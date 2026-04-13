"""System logs API — read and filter application logs."""

import re
from collections import deque
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.core.config import settings
from app.core.database import get_db

router = APIRouter()

# 匹配标准日志行开头：日期时间
_LOG_HEAD_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}")
# 读取上限：最多读最后 50000 行原始行，避免大文件 OOM
_MAX_RAW_LINES = 50000

AdminUser = Annotated[dict, Depends(require_role("admin"))]

# 可用的日志源
LOG_SOURCES = {
    "app": Path(settings.LOG_APP),
    "celery": Path(settings.LOG_CELERY),
}

# 引擎日志动态加载
def _get_engine_logs() -> dict[str, Path]:
    engines_dir = Path(settings.LOG_ENGINES_DIR)
    if not engines_dir.exists():
        return {}
    return {
        f"engine:{f.stem}": f
        for f in engines_dir.glob("*.log")
    }


@router.get("/sources")
async def list_log_sources(_user: AdminUser):
    """列出所有可用的日志源。"""
    label_map = {"app": "应用日志", "celery": "Celery 队列"}
    sources = []
    for name, path in {**LOG_SOURCES, **_get_engine_logs()}.items():
        try:
            st = path.stat()
            sources.append({"name": name, "label": label_map.get(name, f"引擎: {path.stem}"),
                            "exists": True, "size": st.st_size})
        except OSError:
            sources.append({"name": name, "label": label_map.get(name, f"引擎: {path.stem}"),
                            "exists": False, "size": 0})
    return sources


@router.get("", response_class=PlainTextResponse)
async def get_system_logs(
    _user: AdminUser,
    source: str = Query("app", description="日志源: app, celery, engine:xxx"),
    tail: int = Query(200, ge=10, le=5000, description="返回最后 N 行"),
    keyword: str = Query("", description="关键词过滤（支持 | 分隔多关键词 OR 匹配）"),
    level: str = Query("", description="日志级别过滤: info, warning, error"),
):
    """读取系统日志，支持 tail + 关键词 + 级别过滤。"""
    # 查找日志文件
    all_sources = {**LOG_SOURCES, **_get_engine_logs()}
    log_file = all_sources.get(source)
    if not log_file:
        raise HTTPException(status_code=400, detail=f"未知日志源: {source}")

    if not log_file.exists():
        raise HTTPException(status_code=404, detail=f"日志文件不存在")

    # 读取文件末尾行，按日志条目分组后过滤，最后 tail
    try:
        with open(log_file, encoding="utf-8", errors="replace") as f:
            raw_lines = list(deque(f, maxlen=_MAX_RAW_LINES))
    except OSError:
        raise HTTPException(status_code=500, detail="读取日志失败")

    # 将多行日志合并为条目（续行归属上一条）
    entries: list[str] = []
    for raw in raw_lines:
        line = raw.rstrip("\n")
        if _LOG_HEAD_RE.match(line):
            entries.append(line)
        elif entries:
            entries[-1] += "\n" + line
        else:
            entries.append(line)

    # 级别过滤（按条目首行判断）
    if level:
        level_upper = level.upper()
        entries = [e for e in entries if level_upper in e.split("\n", 1)[0].upper()]

    # 关键词过滤：支持 | 分隔的多关键词 OR 匹配
    if keyword:
        keywords = [k.strip().lower() for k in keyword.split("|") if k.strip()]
        entries = [e for e in entries if any(kw in e.lower() for kw in keywords)]

    # tail：取最后 N 条条目
    entries = entries[-tail:]

    return "\n".join(entries) if entries else "（无匹配日志）"


@router.delete("")
async def clear_log(
    _user: AdminUser,
    source: str = Query("app", description="日志源"),
):
    """清空指定日志文件。"""
    all_sources = {**LOG_SOURCES, **_get_engine_logs()}
    log_file = all_sources.get(source)
    if not log_file or not log_file.exists():
        raise HTTPException(status_code=404, detail="日志文件不存在")
    try:
        log_file.write_text("", encoding="utf-8")
        return {"cleared": source}
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"清空失败: {e}")


@router.get("/perf-stats")
async def get_perf_stats(
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
    hours: int = Query(24, ge=1, le=168, description="Recent N hours"),
):
    """Performance stats from chat_logs: latency, throughput, error rate."""
    from sqlalchemy import select, func as sa_func
    from app.models.chat_log import ChatLog
    from datetime import datetime, timedelta, timezone

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

    result = await db.execute(
        select(ChatLog).where(ChatLog.created_at >= cutoff)
        .order_by(ChatLog.created_at.desc()).limit(500)
    )
    logs = result.scalars().all()

    if not logs:
        return {"hours": hours, "total": 0, "stats": {}, "by_model": {}, "by_status": {}}

    latencies = [l.latency_ms for l in logs if l.latency_ms is not None]
    by_status = {}
    by_model: dict[str, int] = {}
    for l in logs:
        by_status[l.status] = by_status.get(l.status, 0) + 1
        by_model[l.model] = by_model.get(l.model, 0) + 1

    stats = {}
    if latencies:
        latencies.sort()
        stats = {
            "avg_ms": round(sum(latencies) / len(latencies), 1),
            "p50_ms": round(latencies[len(latencies) // 2], 1),
            "p95_ms": round(latencies[int(len(latencies) * 0.95)], 1),
            "min_ms": round(min(latencies), 1),
            "max_ms": round(max(latencies), 1),
        }

    return {
        "hours": hours,
        "total": len(logs),
        "by_status": by_status,
        "by_model": by_model,
        "stats": stats,
    }
