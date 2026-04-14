"""LLM request router — resolves model name to vLLM backend endpoint."""

import asyncio
import logging
import os
import subprocess
import time
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.utils import is_port_listening, parse_url_port
from app.models.llm_service import LLMService

logger = logging.getLogger(__name__)

# In-memory cache: model_name -> (endpoint, service_id, timestamp)
_route_cache: dict[str, tuple[str, int, float]] = {}
_CACHE_TTL = 60  # seconds


async def resolve_endpoint(model: str, db: AsyncSession) -> tuple[str, int] | None:
    """Resolve model name to (endpoint, service_id).

    Lookup order:
    1. In-memory cache (60s TTL)
    2. Database: LLMService where model_name matches and status='enabled'
    3. Database: LLMService where name matches and status='enabled'

    Returns None if no matching service found.
    """
    now = time.monotonic()

    # Check cache
    cached = _route_cache.get(model)
    if cached and (now - cached[2]) < _CACHE_TTL:
        return cached[0], cached[1]

    # Query by model_name first
    result = await db.execute(
        select(LLMService).where(
            LLMService.model_name == model,
            LLMService.status == "enabled",
        ).limit(1)
    )
    svc = result.scalar_one_or_none()

    # Fallback: query by service name
    if not svc:
        result = await db.execute(
            select(LLMService).where(
                LLMService.name == model,
                LLMService.status == "enabled",
            ).limit(1)
        )
        svc = result.scalar_one_or_none()

    if not svc:
        logger.warning("no_route_for_model: %s", model)
        return None

    endpoint = svc.endpoint.rstrip("/")
    _route_cache[model] = (endpoint, svc.id, now)
    return endpoint, svc.id


async def ensure_running(service_id: int, db: AsyncSession) -> tuple[bool, str]:
    """Ensure the vLLM backend is running. Auto-start if it has exec_command.

    Returns (ready, message).
    """
    svc = await db.get(LLMService, service_id)
    if not svc:
        return False, "Service not found"

    port = parse_url_port(svc.endpoint)
    if not port:
        return False, "Cannot parse port from endpoint"

    # Already running
    if is_port_listening(port):
        return True, "already running"

    # No exec_command — can't auto-start
    if not svc.exec_command:
        return False, f"Service not running on port {port} and no exec_command configured"

    # Auto-start
    logger.info("ensure_running: auto-starting %s (port %d)", svc.name, port)
    log_dir = Path(settings.LOG_ENGINES_DIR)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"{svc.name}.log"

    env = os.environ.copy()
    if svc.extra_env:
        env.update(svc.extra_env)

    try:
        log_fh = open(log_file, "a")
        proc = subprocess.Popen(
            svc.exec_command,
            shell=True,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            cwd=svc.work_dir or None,
            env=env,
            start_new_session=True,
        )
        log_fh.close()
    except Exception as e:
        return False, f"Failed to start: {e}"

    # Wait for port (up to 120s for large models)
    for i in range(120):
        await asyncio.sleep(1)
        if is_port_listening(port):
            logger.info("ensure_running: %s ready after %ds (pid=%d)", svc.name, i + 1, proc.pid)
            return True, f"auto-started (pid={proc.pid}, {i + 1}s)"

    return False, f"Process started (pid={proc.pid}) but port {port} not ready after 120s"


def invalidate_cache(model: str | None = None):
    """Clear route cache. Call after service config changes."""
    if model:
        _route_cache.pop(model, None)
    else:
        _route_cache.clear()


async def list_available_models(db: AsyncSession) -> list[dict]:
    """List all enabled LLM services as available models."""
    result = await db.execute(
        select(LLMService).where(LLMService.status == "enabled")
    )
    services = result.scalars().all()

    models = []
    for svc in services:
        model_id = svc.model_name or svc.name
        models.append({
            "id": model_id,
            "service_id": svc.id,
            "endpoint": svc.endpoint,
            "display_name": svc.display_name,
            "created": int(svc.created_at.timestamp()) if svc.created_at else 0,
        })
    return models
