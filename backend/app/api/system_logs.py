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
    hours: int = Query(24, ge=1, le=168, description="最近 N 小时"),
):
    """性能指标统计：推理任务耗时、吞吐量、错误率。"""
    from sqlalchemy import select, func as sa_func
    from app.models.inference_task import InferenceTask
    from datetime import datetime, timedelta, timezone

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

    # 查询最近完成的任务
    result = await db.execute(
        select(InferenceTask).where(
            InferenceTask.completed_at >= cutoff,
            InferenceTask.parent_task_id.is_(None),
        ).order_by(InferenceTask.completed_at.desc()).limit(500)
    )
    tasks = result.scalars().all()

    if not tasks:
        return {"hours": hours, "total": 0, "stats": {}, "recent": [], "by_algorithm": {}, "by_hour": []}

    # 计算耗时
    durations = []
    by_algo: dict[str, list[float]] = {}
    by_status: dict[str, int] = {}
    by_hour: dict[str, dict] = {}

    for t in tasks:
        status = t.status or "unknown"
        by_status[status] = by_status.get(status, 0) + 1

        if t.started_at and t.completed_at:
            dur = (t.completed_at - t.started_at).total_seconds()
            durations.append(dur)
            algo = t.algorithm_name or "unknown"
            by_algo.setdefault(algo, []).append(dur)

            # 按小时聚合
            hour_key = t.completed_at.strftime("%Y-%m-%d %H:00")
            if hour_key not in by_hour:
                by_hour[hour_key] = {"hour": hour_key, "count": 0, "success": 0, "failed": 0, "avg_duration": 0, "total_duration": 0}
            by_hour[hour_key]["count"] += 1
            by_hour[hour_key]["total_duration"] += dur
            if status in ("completed", "partial_success"):
                by_hour[hour_key]["success"] += 1
            elif status in ("failed", "timeout"):
                by_hour[hour_key]["failed"] += 1

    # 汇总
    import numpy as np
    stats = {}
    if durations:
        stats = {
            "avg": round(np.mean(durations), 2),
            "p50": round(np.percentile(durations, 50), 2),
            "p95": round(np.percentile(durations, 95), 2),
            "min": round(min(durations), 2),
            "max": round(max(durations), 2),
        }

    algo_stats = {}
    for algo, durs in by_algo.items():
        algo_stats[algo] = {
            "count": len(durs),
            "avg": round(np.mean(durs), 2),
            "p95": round(np.percentile(durs, 95), 2),
        }

    # 按小时排序
    hour_list = sorted(by_hour.values(), key=lambda x: x["hour"])
    for h in hour_list:
        h["avg_duration"] = round(h["total_duration"] / h["count"], 2) if h["count"] else 0
        del h["total_duration"]

    # 最近 10 条
    recent = []
    for t in tasks[:10]:
        dur = None
        if t.started_at and t.completed_at:
            dur = round((t.completed_at - t.started_at).total_seconds(), 2)
        recent.append({
            "id": t.id[:12],
            "algorithm": t.algorithm_name,
            "status": t.status,
            "duration": dur,
            "source": t.source,
            "completed_at": t.completed_at.isoformat() if t.completed_at else None,
        })

    return {
        "hours": hours,
        "total": len(tasks),
        "by_status": by_status,
        "stats": stats,
        "by_algorithm": algo_stats,
        "by_hour": hour_list,
        "recent": recent,
    }
