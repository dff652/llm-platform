"""LLM request router — resolves model name to vLLM backend with round-robin load balancing."""

import asyncio
import logging
import os
import subprocess
import time
from pathlib import Path

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.utils import is_port_listening, parse_url_port
from app.models.llm_service import LLMService

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Health check cache: endpoint -> (healthy, timestamp)
# ---------------------------------------------------------------------------
_health_cache: dict[str, tuple[bool, float]] = {}
_HEALTH_TTL = 30  # seconds


_health_client: httpx.AsyncClient | None = None


def _get_health_client() -> httpx.AsyncClient:
    global _health_client
    if _health_client is None or _health_client.is_closed:
        _health_client = httpx.AsyncClient(
            timeout=httpx.Timeout(3, connect=2),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
    return _health_client


async def _check_endpoint_health(endpoint: str) -> bool:
    """Check if a vLLM endpoint is reachable (GET /v1/models)."""
    now = time.monotonic()
    cached = _health_cache.get(endpoint)
    if cached and (now - cached[1]) < _HEALTH_TTL:
        return cached[0]

    healthy = False
    try:
        client = _get_health_client()
        resp = await client.get(f"{endpoint}/v1/models")
        healthy = resp.status_code == 200
    except Exception:
        pass

    _health_cache[endpoint] = (healthy, now)
    return healthy


# ---------------------------------------------------------------------------
# Round-robin counter
# ---------------------------------------------------------------------------
_rr_counter: int = 0


async def resolve_endpoint(model: str, db: AsyncSession) -> tuple[str, int] | None:
    """Resolve model name to (endpoint, service_id) with round-robin load balancing.

    1. Find ALL enabled services matching model_name or name
    2. Concurrent health check (30s cache), filter unhealthy
    3. Round-robin across healthy candidates
    """
    global _rr_counter

    # Query all matching services (not limit 1)
    result = await db.execute(
        select(LLMService).where(
            LLMService.model_name == model,
            LLMService.status == "enabled",
        ).order_by(LLMService.id)
    )
    candidates = list(result.scalars().all())

    # Fallback: match by service name
    if not candidates:
        result = await db.execute(
            select(LLMService).where(
                LLMService.name == model,
                LLMService.status == "enabled",
            ).order_by(LLMService.id)
        )
        candidates = list(result.scalars().all())

    if not candidates:
        logger.warning("no_route_for_model: %s", model)
        return None

    # Single candidate — skip health check overhead
    if len(candidates) == 1:
        svc = candidates[0]
        return svc.endpoint.rstrip("/"), svc.id

    # Multiple candidates — concurrent health check, filter unhealthy
    endpoints = [svc.endpoint.rstrip("/") for svc in candidates]
    health_results = await asyncio.gather(*(
        _check_endpoint_health(ep) for ep in endpoints
    ))

    healthy = [(svc, ep) for svc, ep, ok in zip(candidates, endpoints, health_results) if ok]
    for svc, ep, ok in zip(candidates, endpoints, health_results):
        if not ok:
            logger.info("skip_unhealthy: %s (endpoint=%s)", svc.name, ep)

    if not healthy:
        # All unhealthy — fall back to first candidate (let ensure_running handle it)
        svc = candidates[0]
        return svc.endpoint.rstrip("/"), svc.id

    # Round-robin
    idx = _rr_counter % len(healthy)
    _rr_counter += 1
    chosen_svc, chosen_ep = healthy[idx]
    logger.info("round_robin: %s (id=%d), %d/%d healthy",
                chosen_svc.name, chosen_svc.id, idx + 1, len(healthy))
    return chosen_ep, chosen_svc.id


async def ensure_running(service_id: int, db: AsyncSession) -> tuple[bool, str]:
    """Ensure the vLLM backend is running. Auto-start if it has exec_command."""
    svc = await db.get(LLMService, service_id)
    if not svc:
        return False, "Service not found"

    port = parse_url_port(svc.endpoint)
    if not port:
        return False, "Cannot parse port from endpoint"

    if is_port_listening(port):
        return True, "already running"

    if not svc.exec_command:
        return False, f"Service not running on port {port} and no exec_command configured"

    logger.info("ensure_running: auto-starting %s (port %d)", svc.name, port)
    log_dir = Path(settings.LOG_ENGINES_DIR)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"{svc.name}.log"

    env = os.environ.copy()
    if svc.extra_env:
        env.update(svc.extra_env)

    try:
        log_fh = open(log_file, "a")
        try:
            proc = subprocess.Popen(
                svc.exec_command,
                shell=True,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                cwd=svc.work_dir or None,
                env=env,
                start_new_session=True,
            )
        finally:
            log_fh.close()
    except Exception as e:
        return False, f"Failed to start: {e}"

    for i in range(120):
        await asyncio.sleep(1)
        if is_port_listening(port):
            # Invalidate health cache for this endpoint
            _health_cache.pop(svc.endpoint.rstrip("/"), None)
            logger.info("ensure_running: %s ready after %ds (pid=%d)", svc.name, i + 1, proc.pid)
            return True, f"auto-started (pid={proc.pid}, {i + 1}s)"

    return False, f"Process started (pid={proc.pid}) but port {port} not ready after 120s"


def invalidate_cache(model: str | None = None):
    """Clear route cache and health cache."""
    _health_cache.clear()


async def list_available_models(db: AsyncSession) -> list[dict]:
    """List all enabled LLM services as available models (deduplicated by model_name)."""
    result = await db.execute(
        select(LLMService).where(LLMService.status == "enabled")
    )
    services = result.scalars().all()

    # Deduplicate: same model_name may have multiple instances
    seen: dict[str, dict] = {}
    for svc in services:
        model_id = svc.model_name or svc.name
        if model_id not in seen:
            seen[model_id] = {
                "id": model_id,
                "service_count": 0,
                "display_name": svc.display_name,
                "created": int(svc.created_at.timestamp()) if svc.created_at else 0,
            }
        seen[model_id]["service_count"] += 1

    return list(seen.values())
