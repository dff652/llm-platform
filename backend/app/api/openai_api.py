"""OpenAI-compatible API endpoints — /v1/chat/completions, /v1/completions, /v1/models.

These endpoints proxy requests to vLLM backends, authenticated via API Key or JWT.
"""

import logging
import time
import uuid
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.core.config import settings
from app.models.chat_log import ChatLog
from app.schemas.openai import (
    ChatCompletionRequest,
    CompletionRequest,
    ModelInfo,
    ModelListResponse,
)
from app.services.llm_router import ensure_running, list_available_models, resolve_endpoint

logger = logging.getLogger(__name__)

router = APIRouter()

CurrentUser = Annotated[dict, Depends(get_current_user)]


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

_shared_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    """Reuse a single AsyncClient for connection pooling across all requests."""
    global _shared_client
    if _shared_client is None or _shared_client.is_closed:
        _shared_client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.VLLM_REQUEST_TIMEOUT, connect=10),
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
        )
    return _shared_client


async def _log_request(
    db: AsyncSession,
    *,
    request_id: str,
    model: str,
    endpoint_type: str,
    stream: bool,
    user: dict,
    service_id: int | None,
    service_endpoint: str | None,
    status: str = "success",
    error_message: str | None = None,
    error_code: str | None = None,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    total_tokens: int | None = None,
    latency_ms: float | None = None,
    ttft_ms: float | None = None,
    request_body: dict | None = None,
    response_body: dict | None = None,
):
    """Log an API call to chat_logs table (fire-and-forget)."""
    try:
        log = ChatLog(
            request_id=request_id,
            model=model,
            endpoint_type=endpoint_type,
            stream=stream,
            user_id=user.get("id"),
            api_key_id=user.get("api_key_id"),
            api_key_name=user.get("api_key_name"),
            service_id=service_id,
            service_endpoint=service_endpoint,
            status=status,
            error_message=error_message,
            error_code=error_code,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            latency_ms=latency_ms,
            time_to_first_token_ms=ttft_ms,
            request_body=request_body,
            response_body=response_body,
        )
        db.add(log)
        # Accumulate token usage on API Key
        api_key_id = user.get("api_key_id")
        if api_key_id and total_tokens and total_tokens > 0:
            from app.models.api_key import ApiKey
            key = await db.get(ApiKey, api_key_id)
            if key:
                key.token_used = (key.token_used or 0) + total_tokens
        await db.commit()
    except Exception as e:
        logger.warning("chat_log_write_failed: %s", e)


# ---------------------------------------------------------------------------
# POST /v1/chat/completions
# ---------------------------------------------------------------------------

@router.post("/chat/completions")
async def chat_completions(
    body: ChatCompletionRequest,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    request_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    t0 = time.monotonic()

    # Resolve model → vLLM endpoint
    route = await resolve_endpoint(body.model, db)
    if not route:
        raise HTTPException(
            status_code=404,
            detail=f"Model '{body.model}' not found or not available",
        )
    endpoint, service_id = route

    # Ensure backend is running (auto-start if needed)
    ready, msg = await ensure_running(service_id, db)
    if not ready:
        raise HTTPException(503, detail=f"Model backend not available: {msg}")

    # Build payload — forward everything, override model with actual vLLM model name
    payload = body.model_dump(exclude_none=True, exclude={"extra_body"})
    if body.extra_body:
        payload.update(body.extra_body)

    url = f"{endpoint}/v1/chat/completions"

    # Streaming
    if body.stream:
        return await _stream_proxy(
            url=url,
            payload=payload,
            request_id=request_id,
            model=body.model,
            endpoint_type="chat",
            user=user,
            service_id=service_id,
            service_endpoint=endpoint,
            db=db,
            t0=t0,
        )

    # Non-streaming
    try:
        client = _get_client()
        resp = await client.post(url, json=payload)

        if resp.status_code != 200:
            error_msg = resp.text[:500]
            await _log_request(
                db,
                request_id=request_id,
                model=body.model,
                endpoint_type="chat",
                stream=False,
                user=user,
                service_id=service_id,
                service_endpoint=endpoint,
                status="error",
                error_message=error_msg,
                error_code=f"UPSTREAM_{resp.status_code}",
                latency_ms=(time.monotonic() - t0) * 1000,
            )
            raise HTTPException(status_code=resp.status_code, detail=error_msg)

        data = resp.json()
        # Extract usage for logging
        usage = data.get("usage", {})
        await _log_request(
            db,
            request_id=request_id,
            model=body.model,
            endpoint_type="chat",
            stream=False,
            user=user,
            service_id=service_id,
            service_endpoint=endpoint,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            total_tokens=usage.get("total_tokens"),
            latency_ms=(time.monotonic() - t0) * 1000,
            request_body=payload,
            response_body=data,
        )
        data["id"] = request_id
        return data

    except HTTPException:
        raise
    except httpx.ConnectError:
        await _log_request(
            db, request_id=request_id, model=body.model, endpoint_type="chat",
            stream=False, user=user, service_id=service_id, service_endpoint=endpoint,
            status="error", error_code="CONNECT_ERROR",
            error_message=f"Cannot connect to {endpoint}",
            latency_ms=(time.monotonic() - t0) * 1000,
        )
        raise HTTPException(502, detail=f"Cannot connect to model backend at {endpoint}")
    except httpx.TimeoutException:
        await _log_request(
            db, request_id=request_id, model=body.model, endpoint_type="chat",
            stream=False, user=user, service_id=service_id, service_endpoint=endpoint,
            status="error", error_code="TIMEOUT",
            error_message=f"Request timed out ({settings.VLLM_REQUEST_TIMEOUT}s)",
            latency_ms=(time.monotonic() - t0) * 1000,
        )
        raise HTTPException(504, detail="Model backend request timed out")


# ---------------------------------------------------------------------------
# POST /v1/completions
# ---------------------------------------------------------------------------

@router.post("/completions")
async def completions(
    body: CompletionRequest,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    request_id = f"cmpl-{uuid.uuid4().hex[:24]}"
    t0 = time.monotonic()

    route = await resolve_endpoint(body.model, db)
    if not route:
        raise HTTPException(404, detail=f"Model '{body.model}' not found or not available")
    endpoint, service_id = route

    ready, msg = await ensure_running(service_id, db)
    if not ready:
        raise HTTPException(503, detail=f"Model backend not available: {msg}")

    payload = body.model_dump(exclude_none=True)
    url = f"{endpoint}/v1/completions"

    if body.stream:
        return await _stream_proxy(
            url=url,
            payload=payload,
            request_id=request_id,
            model=body.model,
            endpoint_type="completions",
            user=user,
            service_id=service_id,
            service_endpoint=endpoint,
            db=db,
            t0=t0,
        )

    try:
        client = _get_client()
        resp = await client.post(url, json=payload)

        if resp.status_code != 200:
            error_msg = resp.text[:500]
            await _log_request(
                db, request_id=request_id, model=body.model, endpoint_type="completions",
                stream=False, user=user, service_id=service_id, service_endpoint=endpoint,
                status="error", error_message=error_msg, error_code=f"UPSTREAM_{resp.status_code}",
                latency_ms=(time.monotonic() - t0) * 1000,
            )
            raise HTTPException(status_code=resp.status_code, detail=error_msg)

        data = resp.json()
        usage = data.get("usage", {})
        await _log_request(
            db, request_id=request_id, model=body.model, endpoint_type="completions",
            stream=False, user=user, service_id=service_id, service_endpoint=endpoint,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            total_tokens=usage.get("total_tokens"),
            latency_ms=(time.monotonic() - t0) * 1000,
        )
        data["id"] = request_id
        return data

    except HTTPException:
        raise
    except httpx.ConnectError:
        await _log_request(
            db, request_id=request_id, model=body.model, endpoint_type="completions",
            stream=False, user=user, service_id=service_id, service_endpoint=endpoint,
            status="error", error_code="CONNECT_ERROR",
            error_message=f"Cannot connect to {endpoint}",
            latency_ms=(time.monotonic() - t0) * 1000,
        )
        raise HTTPException(502, detail=f"Cannot connect to model backend at {endpoint}")
    except httpx.TimeoutException:
        await _log_request(
            db, request_id=request_id, model=body.model, endpoint_type="completions",
            stream=False, user=user, service_id=service_id, service_endpoint=endpoint,
            status="error", error_code="TIMEOUT",
            error_message=f"Request timed out ({settings.VLLM_REQUEST_TIMEOUT}s)",
            latency_ms=(time.monotonic() - t0) * 1000,
        )
        raise HTTPException(504, detail="Model backend request timed out")


# ---------------------------------------------------------------------------
# GET /v1/models
# ---------------------------------------------------------------------------

@router.get("/models")
async def list_models(
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    models = await list_available_models(db)
    return ModelListResponse(
        data=[
            ModelInfo(
                id=m["id"],
                created=m["created"],
                owned_by="llm-platform",
            )
            for m in models
        ]
    )


# ---------------------------------------------------------------------------
# Streaming proxy
# ---------------------------------------------------------------------------

async def _stream_proxy(
    *,
    url: str,
    payload: dict,
    request_id: str,
    model: str,
    endpoint_type: str,
    user: dict,
    service_id: int | None,
    service_endpoint: str,
    db: AsyncSession,
    t0: float,
):
    """Proxy SSE stream from vLLM backend to client."""

    async def event_generator():
        ttft = None
        try:
            client = _get_client()
            async with client.stream("POST", url, json=payload) as resp:
                if resp.status_code != 200:
                    error_body = b""
                    async for chunk in resp.aiter_bytes():
                        error_body += chunk
                    error_msg = error_body.decode("utf-8", errors="replace")[:500]
                    yield f'data: {{"error": "{error_msg}"}}\n\n'
                    yield "data: [DONE]\n\n"
                    return

                content_type = resp.headers.get("content-type", "")
                is_sse = "text/event-stream" in content_type

                if is_sse:
                    async for line in resp.aiter_lines():
                        if ttft is None:
                            ttft = (time.monotonic() - t0) * 1000
                        yield f"{line}\n"
                        if line.strip() == "":
                            yield "\n"
                else:
                    body_bytes = b""
                    async for chunk in resp.aiter_bytes():
                        body_bytes += chunk
                    ttft = (time.monotonic() - t0) * 1000
                    yield f"data: {body_bytes.decode('utf-8', errors='replace')}\n\n"
                    yield "data: [DONE]\n\n"

        except httpx.ConnectError:
            yield f'data: {{"error": "Cannot connect to model backend"}}\n\n'
            yield "data: [DONE]\n\n"
        except httpx.TimeoutException:
            yield f'data: {{"error": "Stream timed out"}}\n\n'
            yield "data: [DONE]\n\n"
        finally:
            # Log after stream completes (no token counts for streaming)
            await _log_request(
                db,
                request_id=request_id,
                model=model,
                endpoint_type=endpoint_type,
                stream=True,
                user=user,
                service_id=service_id,
                service_endpoint=service_endpoint,
                latency_ms=(time.monotonic() - t0) * 1000,
                ttft_ms=ttft,
            )

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Request-Id": request_id,
        },
    )
