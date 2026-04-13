"""SSE event stream endpoint for real-time inference progress."""

import json
from typing import Annotated

from fastapi import APIRouter, Depends
from sse_starlette.sse import EventSourceResponse

from app.api.deps import get_current_user
from app.core.events import read_events

router = APIRouter()

CurrentUser = Annotated[dict, Depends(get_current_user)]


@router.get("/{run_id}")
async def stream_events(run_id: str, _user: CurrentUser):
    """SSE endpoint — stream pipeline progress events for a given run.

    Events are JSON objects, one per line:
        data: {"type":"step","step":"infer","status":"running",...}
        data: {"type":"file_progress","completed":2,"total":5,...}
        data: {"type":"complete","success":true,...}

    The stream ends when a terminal event (complete/error) is sent,
    or after 30s of inactivity.
    """
    async def event_generator():
        async for event in read_events(run_id):
            yield {"data": json.dumps(event, ensure_ascii=False)}

    return EventSourceResponse(event_generator())
