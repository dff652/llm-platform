"""清理微调残留文件 — 删除失败/不存在 job 的导出数据和 adapter 目录。

Usage:
    cd backend
    python -m scripts.cleanup_finetune           # 实际删除
    python -m scripts.cleanup_finetune --dry-run  # 仅预览，不删除
"""

import argparse
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

# 将 backend 加入 sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import settings  # noqa: E402


# 需要清理的状态（终态且非成功）
CLEANUP_STATUSES = {"failed", "cancelled"}
# 跳过最近 1 小时内创建的目录（可能正在运行）
SAFE_AGE_SECONDS = 3600


def _parse_job_id(dir_name: str) -> int | None:
    """从目录名（如 'job_7'）提取 job_id。"""
    if dir_name.startswith("job_"):
        try:
            return int(dir_name[4:])
        except ValueError:
            return None
    return None


def _get_job_status_map(job_ids: set[int]) -> dict[int, str | None]:
    """批量查询 job 状态，不存在的 job 返回 None。"""
    if not job_ids:
        return {}

    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import Session
    from app.models.finetune_job import FineTuneJob

    engine = create_engine(settings.DATABASE_SYNC_URL, pool_pre_ping=True)
    with Session(engine) as db:
        stmt = select(FineTuneJob.id, FineTuneJob.status).where(
            FineTuneJob.id.in_(list(job_ids))
        )
        rows = db.execute(stmt).all()

    status_map: dict[int, str | None] = {jid: None for jid in job_ids}
    for row_id, row_status in rows:
        status_map[row_id] = row_status
    return status_map


def _scan_directories(root: str) -> list[tuple[Path, int]]:
    """扫描根目录下的 job_* 子目录，返回 (目录路径, job_id) 列表。"""
    root_path = Path(root)
    if not root_path.exists():
        return []
    results = []
    for d in root_path.iterdir():
        if d.is_dir():
            job_id = _parse_job_id(d.name)
            if job_id is not None:
                results.append((d, job_id))
    return results


def _dir_size_mb(path: Path) -> float:
    """计算目录总大小（MB）。"""
    total = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    return total / (1024 * 1024)


def _dir_age_seconds(path: Path) -> float:
    """目录最后修改时间距现在的秒数。"""
    mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    return (datetime.now(timezone.utc) - mtime).total_seconds()


def main():
    parser = argparse.ArgumentParser(description="清理微调残留文件")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="仅预览待清理目录，不实际删除",
    )
    args = parser.parse_args()

    # 扫描两个根目录
    export_dirs = _scan_directories(settings.LF_EXPORT_ROOT)
    adapter_dirs = _scan_directories(settings.LF_ADAPTER_ROOT)

    all_dirs = export_dirs + adapter_dirs
    if not all_dirs:
        print("未发现任何 job_* 目录，无需清理。")
        return

    # 收集所有 job_id 并批量查状态
    all_job_ids = {jid for _, jid in all_dirs}
    status_map = _get_job_status_map(all_job_ids)

    # 筛选需要清理的目录
    to_clean: list[tuple[Path, int, str]] = []  # (path, job_id, reason)
    for dir_path, job_id in all_dirs:
        status = status_map.get(job_id)

        # 跳过最近创建的目录
        if _dir_age_seconds(dir_path) < SAFE_AGE_SECONDS:
            continue

        if status is None:
            to_clean.append((dir_path, job_id, "job 不存在"))
        elif status in CLEANUP_STATUSES:
            to_clean.append((dir_path, job_id, f"status={status}"))

    if not to_clean:
        print(f"扫描 {len(all_dirs)} 个目录，全部有效，无需清理。")
        return

    # 执行清理
    total_freed_mb = 0.0
    print(f"\n{'[DRY RUN] ' if args.dry_run else ''}待清理 {len(to_clean)} 个目录:\n")
    print(f"{'目录':<60} {'Job ID':>6}  {'原因':<20} {'大小':>8}")
    print("-" * 100)

    for dir_path, job_id, reason in to_clean:
        size_mb = _dir_size_mb(dir_path)
        total_freed_mb += size_mb
        print(f"{str(dir_path):<60} {job_id:>6}  {reason:<20} {size_mb:>7.1f}M")
        if not args.dry_run:
            shutil.rmtree(dir_path)

    print("-" * 100)
    action = "可释放" if args.dry_run else "已释放"
    print(f"\n共清理 {len(to_clean)} 个目录，{action} {total_freed_mb:.1f} MB 磁盘空间。")


if __name__ == "__main__":
    main()
