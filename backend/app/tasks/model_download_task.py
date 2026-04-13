"""Background thread-based model download — direct SDK call, no subprocess."""

import logging
import threading
import time
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

# 下载日志目录
_LOG_DIR = Path("app/data/download_logs")


def _log_path(download_id: int) -> Path:
    _LOG_DIR.mkdir(parents=True, exist_ok=True)
    return _LOG_DIR / f"{download_id}.log"


def _write_log(download_id: int, message: str):
    """追加一行到下载日志文件。"""
    try:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(_log_path(download_id), "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {message}\n")
    except Exception:
        pass


def get_download_log(download_id: int) -> str:
    """读取下载日志内容。"""
    path = _log_path(download_id)
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")

# Track running downloads for cancellation
_cancelled: set[int] = set()
_lock = threading.Lock()


def _get_db_session():
    """Get a sync DB session for background thread use."""
    from app.core.celery_app import _get_sync_session
    return _get_sync_session()


def _is_cancelled(download_id: int) -> bool:
    with _lock:
        return download_id in _cancelled


def _find_model_path(cache_dir: str, model_id: str) -> str:
    """Find the actual model directory after download."""
    base = Path(cache_dir)
    for candidate in [
        base / model_id,
        base / model_id.replace("/", "___"),
        base / "models" / model_id,
        base / model_id.replace("/", "--"),
    ]:
        if candidate.exists() and any(candidate.iterdir()):
            return str(candidate)

    # Fallback: search for config.json
    for config in base.rglob("config.json"):
        return str(config.parent)

    return str(base / model_id)


def _scan_dir_size(directory: str) -> int:
    """Calculate total file size recursively."""
    total = 0
    try:
        for p in Path(directory).rglob("*"):
            if p.is_file():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


_STALL_TIMEOUT_SECONDS = 10 * 60  # 10 minutes without progress → fail


def _update_progress(download_id: int, total_size: int, cache_dir: str, model_id: str):
    """Background loop: scan directory and update DB progress every 5s.

    Auto-fails the download if no progress is made for _STALL_TIMEOUT_SECONDS.
    """
    from app.models.model_download import ModelDownload

    last_size = 0
    stall_start = None

    while not _is_cancelled(download_id):
        time.sleep(5)

        # Scan model subdirectory only (not entire cache_dir)
        # ModelScope SDK stores to: cache_dir/model_id or cache_dir/org___model
        current_size = 0
        model_dir = Path(cache_dir) / model_id
        model_dir_alt = Path(cache_dir) / model_id.replace("/", "___")
        for candidate in [model_dir, model_dir_alt]:
            if candidate.exists():
                current_size += _scan_dir_size(str(candidate))
        # Also check modelscope default home cache
        home_cache = Path.home() / ".cache" / "modelscope" / "hub" / "models" / model_id
        if home_cache.exists():
            current_size += _scan_dir_size(str(home_cache))

        # Stall detection: no new bytes for too long → mark failed and signal cancel
        if current_size > last_size:
            last_size = current_size
            stall_start = None
        else:
            if stall_start is None:
                stall_start = time.monotonic()
            elif time.monotonic() - stall_start > _STALL_TIMEOUT_SECONDS:
                stall_minutes = int(_STALL_TIMEOUT_SECONDS / 60)
                msg = f"下载停滞超过 {stall_minutes} 分钟，自动终止（可重试）"
                logger.warning("Download %d stalled for %dm, marking failed", download_id, stall_minutes)
                _write_log(download_id, msg)
                try:
                    with _get_db_session() as db:
                        dl = db.get(ModelDownload, download_id)
                        if dl and dl.status == "downloading":
                            dl.status = "failed"
                            dl.error_message = msg
                            db.commit()
                except Exception:
                    pass
                with _lock:
                    _cancelled.add(download_id)
                return

        if total_size > 0:
            progress = min(current_size / total_size, 0.99)
        else:
            progress = 0.5 if current_size > 0 else 0.1

        try:
            with _get_db_session() as db:
                dl = db.get(ModelDownload, download_id)
                if not dl or dl.status == "cancelled":
                    return
                # Don't overwrite verifying status back to downloading
                if dl.status == "downloading":
                    dl.progress = progress
                    dl.downloaded_size = current_size
                elif dl.status == "verifying":
                    # Still update size but keep verifying status
                    dl.downloaded_size = current_size
                db.commit()
        except Exception as e:
            logger.debug("Progress update failed for %d: %s", download_id, e)


def _run_download(download_id: int, source: str, model_id: str, cache_dir: str):
    """Download model by calling SDK directly in thread."""
    from app.models.model_download import ModelDownload

    # Phase 1: Mark as downloading
    _write_log(download_id, f"开始下载: {model_id} (来源: {source})")
    _write_log(download_id, f"下载路径: {cache_dir}")
    with _get_db_session() as db:
        dl = db.get(ModelDownload, download_id)
        if not dl:
            _write_log(download_id, "错误: 下载记录不存在")
            logger.error("Download %d not found", download_id)
            return
        dl.status = "downloading"
        total_size = dl.total_size
        db.commit()

    _write_log(download_id, f"总大小: {total_size / 1024 / 1024:.0f} MB")
    Path(cache_dir).mkdir(parents=True, exist_ok=True)

    # Start progress monitor in a separate thread
    progress_thread = threading.Thread(
        target=_update_progress,
        args=(download_id, total_size, cache_dir, model_id),
        daemon=True,
        name=f"progress-{download_id}",
    )
    progress_thread.start()

    # Phase 2: Check if local files already exist → set appropriate status
    model_dir = Path(cache_dir) / model_id
    model_dir_alt = Path(cache_dir) / model_id.replace("/", "___")
    local_exists = (model_dir.exists() and any(model_dir.iterdir())) or \
                   (model_dir_alt.exists() and any(model_dir_alt.iterdir()))

    if local_exists:
        _write_log(download_id, "检测到本地文件，校验完整性...")
        with _get_db_session() as db:
            dl = db.get(ModelDownload, download_id)
            if dl and dl.status not in ("cancelled",):
                dl.status = "verifying"
                db.commit()
    else:
        _write_log(download_id, f"调用 {source} SDK 开始下载...")

    logger.info("Downloading %s from %s → %s (total=%d)", model_id, source, cache_dir, total_size)
    try:
        if source == "modelscope":
            from modelscope import snapshot_download
            model_path = snapshot_download(model_id, cache_dir=cache_dir)
        else:
            raise ValueError(f"不支持的模型源: {source}")

    except Exception as e:
        # Stop progress monitor
        with _lock:
            _cancelled.add(download_id)

        error_msg = str(e)[:2000]
        _write_log(download_id, f"下载失败: {error_msg}")
        import traceback
        _write_log(download_id, f"完整堆栈:\n{traceback.format_exc()}")
        logger.error("Download %d failed: %s", download_id, error_msg)
        with _get_db_session() as db:
            dl = db.get(ModelDownload, download_id)
            if dl and dl.status != "cancelled":
                dl.status = "failed"
                dl.error_message = error_msg
                db.commit()

        with _lock:
            _cancelled.discard(download_id)
        return

    # Stop progress monitor
    with _lock:
        _cancelled.add(download_id)

    # Phase 3: Mark completed
    if not model_path:
        model_path = _find_model_path(cache_dir, model_id)
    final_size = _scan_dir_size(str(model_path)) if model_path else 0

    _write_log(download_id, f"下载完成: {model_path}")
    _write_log(download_id, f"最终大小: {final_size / 1024 / 1024:.0f} MB")

    with _get_db_session() as db:
        dl = db.get(ModelDownload, download_id)
        if dl and dl.status != "cancelled":
            dl.status = "completed"
            dl.progress = 1.0
            dl.downloaded_size = final_size
            dl.download_path = str(model_path)
            db.commit()

    logger.info("Download %d completed: %s → %s", download_id, model_id, model_path)

    with _lock:
        _cancelled.discard(download_id)


def start_download(download_id: int, source: str, model_id: str, cache_dir: str):
    """Launch download in a daemon thread. Returns immediately."""
    with _lock:
        _cancelled.discard(download_id)

    t = threading.Thread(
        target=_run_download,
        args=(download_id, source, model_id, cache_dir),
        daemon=True,
        name=f"download-{download_id}",
    )
    t.start()


def cancel_download(download_id: int):
    """Signal a download to stop. The SDK call can't be interrupted mid-file,
    but progress monitoring will stop and status won't be overwritten."""
    with _lock:
        _cancelled.add(download_id)
