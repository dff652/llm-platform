"""API Key rate limiter using Redis sliding window counters."""

import structlog
from datetime import datetime, timezone

from app.core.config import settings

logger = structlog.get_logger(__name__)

# 系统默认限流值（Key 级别为 0 时使用，可通过 SystemConfig 覆盖）
# -1 = 不限制，部署后默认不限流，按需在系统设置页面开启
DEFAULT_RATE_LIMIT_PER_MINUTE = -1
DEFAULT_RATE_LIMIT_PER_HOUR = -1
DEFAULT_RATE_LIMIT_PER_DAY = -1


def get_system_defaults() -> dict[str, int]:
    """从 Redis 缓存读系统默认限流值（由系统设置页写入）。"""
    try:
        r = _get_redis()
        cached = r.hgetall("system:rate_limits")
        if cached:
            return {
                "minute": int(cached.get("per_minute", DEFAULT_RATE_LIMIT_PER_MINUTE)),
                "hour": int(cached.get("per_hour", DEFAULT_RATE_LIMIT_PER_HOUR)),
                "day": int(cached.get("per_day", DEFAULT_RATE_LIMIT_PER_DAY)),
            }
    except Exception:
        pass
    return {"minute": DEFAULT_RATE_LIMIT_PER_MINUTE, "hour": DEFAULT_RATE_LIMIT_PER_HOUR, "day": DEFAULT_RATE_LIMIT_PER_DAY}


def _get_redis():
    """Get a sync Redis client (reuse Celery's Redis)."""
    import redis
    return redis.from_url(settings.REDIS_URL, decode_responses=True)


class RateLimitExceeded(Exception):
    """Raised when API key exceeds rate limit."""
    def __init__(self, window: str, limit: int, remaining: int, retry_after: int):
        self.window = window
        self.limit = limit
        self.remaining = remaining
        self.retry_after = retry_after
        super().__init__(f"Rate limit exceeded: {window} ({limit}/window)")


def check_rate_limit(api_key_id: int, limits: dict[str, int] | None = None):
    """
    Check rate limits for an API key. Raises RateLimitExceeded if over limit.

    Args:
        api_key_id: the API key's database ID
        limits: {"minute": N, "hour": N, "day": N} — 0 means use default

    Returns:
        dict with remaining quotas: {"minute": N, "hour": N, "day": N}
    """
    if limits is None:
        limits = {}

    defaults = get_system_defaults()
    per_minute = limits.get("minute", 0) or defaults["minute"]
    per_hour = limits.get("hour", 0) or defaults["hour"]
    per_day = limits.get("day", 0) or defaults["day"]

    now = datetime.now(timezone.utc)

    windows = [
        ("minute", per_minute, 60, now.strftime("%Y%m%d%H%M")),
        ("hour", per_hour, 3600, now.strftime("%Y%m%d%H")),
        ("day", per_day, 86400, now.strftime("%Y%m%d")),
    ]

    try:
        r = _get_redis()
        remaining = {}

        for window_name, limit, ttl, window_key in windows:
            # -1 = unlimited, skip this window; 0 = block all
            if limit < 0:
                remaining[window_name] = -1
                continue

            key = f"ratelimit:{api_key_id}:{window_name}:{window_key}"
            count = r.incr(key)
            if count == 1:
                r.expire(key, ttl)

            left = max(0, limit - count)
            remaining[window_name] = left

            if count > limit:
                logger.warning("rate_limit_exceeded",
                               api_key_id=api_key_id, window=window_name,
                               count=count, limit=limit)
                raise RateLimitExceeded(
                    window=window_name,
                    limit=limit,
                    remaining=0,
                    retry_after=r.ttl(key) or ttl,
                )

        return remaining

    except RateLimitExceeded:
        raise
    except Exception as e:
        # Redis down → 不阻塞，放行
        logger.warning("rate_limit_redis_error", error=str(e))
        return {"minute": -1, "hour": -1, "day": -1}
