"""LLM request router — resolves model name to vLLM backend endpoint."""

import logging
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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
