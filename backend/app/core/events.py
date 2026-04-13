"""Event bus — Redis Streams for pipeline progress events.

Write side:  emit_event(run_id, event_dict)  → XADD
Read side:   read_events(run_id)             → async generator for SSE

Uses Redis Streams (not pub/sub) so events are persisted and
clients can reconnect without losing messages.
"""

import json
import time
import structlog
from typing import AsyncGenerator

import redis
from app.core.config import settings

logger = structlog.get_logger(__name__)

STREAM_PREFIX = "events:"
STREAM_MAXLEN = 500       # Max events per run
STREAM_TTL_SECONDS = 3600  # 1 hour expiry


def _get_redis():
    """Get a sync Redis client (for write side, called from pipeline/celery)."""
    return redis.from_url(settings.REDIS_URL, decode_responses=True)


def _stream_key(run_id: str) -> str:
    return f"{STREAM_PREFIX}{run_id}"


def emit_event(run_id: str, event: dict) -> None:
    """Write an event to the Redis Stream for a given run.

    Called from pipeline on_step callback (sync context).
    Safe to call from Celery workers or FastAPI sync code.
    """
    if not run_id:
        return
    try:
        r = _get_redis()
        key = _stream_key(run_id)
        # Store event as a single "data" field (JSON string)
        payload = {
            **event,
            "run_id": run_id,
            "timestamp": event.get("timestamp") or time.time(),
        }
        r.xadd(key, {"data": json.dumps(payload, ensure_ascii=False)}, maxlen=STREAM_MAXLEN)
        # Set TTL on first write
        if r.ttl(key) < 0:
            r.expire(key, STREAM_TTL_SECONDS)
    except Exception as e:
        logger.warning("emit_event_failed", run_id=run_id, error=str(e))


async def read_events(run_id: str, last_id: str = "0") -> AsyncGenerator[dict, None]:
    """Async generator that yields events from a Redis Stream.

    Used by the SSE endpoint. Blocks waiting for new events,
    yields them as they arrive, stops when it sees a terminal event
    (type=complete or type=error with no more events for 30s).
    """
    import redis.asyncio as aioredis

    r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    key = _stream_key(run_id)

    try:
        cursor = last_id
        idle_count = 0

        while True:
            # XREAD with 2s block timeout
            results = await r.xread({key: cursor}, count=10, block=2000)

            if not results:
                idle_count += 1
                if idle_count > 15:  # 30s with no events → stop
                    return
                continue

            idle_count = 0
            for _stream_name, messages in results:
                for msg_id, fields in messages:
                    cursor = msg_id
                    data_str = fields.get("data", "{}")
                    try:
                        event = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue

                    yield event

                    # Stop on terminal events
                    etype = event.get("type", "")
                    if etype in ("complete", "error"):
                        return
    finally:
        await r.aclose()
