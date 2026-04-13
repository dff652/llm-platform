"""Auto-start Redis and Celery worker as managed subprocesses.

Starts on FastAPI lifespan startup, stops on shutdown.
Skips if the service is already running externally.
Skips entirely when IS_CONTAINERIZED=true (compose provides Redis & Celery).
"""

import logging
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from app.core.config import settings

logger = logging.getLogger(__name__)

_managed_procs: list[subprocess.Popen] = []


def _parse_redis_port(url: str) -> int:
    try:
        parsed = urlparse(url)
        return parsed.port or 6379
    except Exception:
        return 6379


def _is_port_listening(port: int) -> bool:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _start_redis() -> subprocess.Popen | None:
    port = _parse_redis_port(settings.REDIS_URL)

    if _is_port_listening(port):
        logger.info("Redis already running on port %d", port)
        return None

    redis_bin = shutil.which("redis-server")
    if not redis_bin:
        logger.warning("redis-server not found in PATH, cannot auto-start Redis")
        return None

    proc = subprocess.Popen(
        [redis_bin, "--port", str(port), "--daemonize", "no", "--save", "", "--dbfilename", ""],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(20):
        if _is_port_listening(port):
            logger.info("Redis auto-started (pid=%d, port=%d)", proc.pid, port)
            return proc
        import time
        time.sleep(0.25)

    logger.error("Redis failed to start within 5s")
    proc.kill()
    return None


def _start_celery_worker() -> subprocess.Popen | None:
    python = sys.executable
    log_path = Path(settings.LOG_CELERY)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    proc = subprocess.Popen(
        [
            python, "-m", "celery",
            "-A", "app.core.celery_app",
            "worker",
            "--loglevel=info",
            f"--concurrency={settings.MAX_CONCURRENT_TASKS}",
            f"--logfile={log_path}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    logger.info("Celery worker auto-started (pid=%d)", proc.pid)
    return proc


def startup():
    """Start managed subprocesses. Called from FastAPI lifespan."""
    if settings.IS_CONTAINERIZED:
        logger.info("Containerized mode: skipping Redis/Celery auto-start")
        return

    # Prevent duplicate starts from multiple uvicorn workers
    pidfile = Path(settings.LOG_DIR) / ".subprocess_manager.pid"
    pidfile.parent.mkdir(parents=True, exist_ok=True)
    if pidfile.exists():
        try:
            old_pid = int(pidfile.read_text().strip())
            os.kill(old_pid, 0)
            logger.info("Subprocesses already managed by worker pid=%d, skipping", old_pid)
            return
        except ProcessLookupError:
            pass
        except (OSError, ValueError) as e:
            logger.warning("pidfile check error: %s", e)

    tmp = pidfile.with_suffix(".tmp")
    tmp.write_text(str(os.getpid()))
    tmp.replace(pidfile)

    redis_proc = _start_redis()
    if redis_proc:
        _managed_procs.append(redis_proc)

    celery_proc = _start_celery_worker()
    if celery_proc:
        _managed_procs.append(celery_proc)


def shutdown():
    """Stop all managed subprocesses. Called from FastAPI lifespan."""
    if settings.IS_CONTAINERIZED:
        return

    for proc in _managed_procs:
        if proc.poll() is None:
            logger.info("Stopping managed subprocess pid=%d", proc.pid)
            proc.send_signal(signal.SIGTERM)

    for proc in _managed_procs:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            logger.warning("Force-killing subprocess pid=%d", proc.pid)
            proc.kill()

    _managed_procs.clear()
