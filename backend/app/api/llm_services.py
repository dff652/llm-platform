"""LLM Service management API — CRUD + process management for vLLM backend instances."""

import asyncio
import logging
import os
import signal
import subprocess
from pathlib import Path
from typing import Annotated
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_role, get_db
from app.core.config import settings
from app.models.llm_service import LLMService
from app.services.llm_router import invalidate_cache

logger = logging.getLogger(__name__)

LOG_DIR = Path(settings.LOG_ENGINES_DIR)

router = APIRouter()

AdminUser = Annotated[dict, Depends(require_role("admin"))]
CurrentUser = Annotated[dict, Depends(get_current_user)]


class ServiceCreate(BaseModel):
    name: str
    display_name: str
    endpoint: str
    model_name: str | None = None
    model_path: str | None = None
    gpu_device: str | None = None
    description: str | None = None
    exec_command: str | None = None
    work_dir: str | None = None
    extra_env: dict | None = None


class ServiceUpdate(BaseModel):
    display_name: str | None = None
    endpoint: str | None = None
    model_name: str | None = None
    model_path: str | None = None
    gpu_device: str | None = None
    description: str | None = None
    exec_command: str | None = None
    work_dir: str | None = None
    extra_env: dict | None = None
    status: str | None = None


def _to_dict(svc: LLMService) -> dict:
    return {
        "id": svc.id,
        "name": svc.name,
        "display_name": svc.display_name,
        "endpoint": svc.endpoint,
        "model_name": svc.model_name,
        "model_path": svc.model_path,
        "gpu_device": svc.gpu_device,
        "description": svc.description,
        "exec_command": svc.exec_command,
        "work_dir": svc.work_dir,
        "extra_env": svc.extra_env,
        "status": svc.status,
        "created_by": svc.created_by,
        "created_at": svc.created_at.isoformat() if svc.created_at else None,
        "updated_at": svc.updated_at.isoformat() if svc.updated_at else None,
    }


@router.get("")
async def list_services(
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
    status: str | None = Query(None),
):
    query = select(LLMService)
    if status:
        query = query.where(LLMService.status == status)
    query = query.order_by(LLMService.id)
    result = await db.execute(query)
    return [_to_dict(svc) for svc in result.scalars().all()]


@router.get("/{service_id}")
async def get_service(
    service_id: int,
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    svc = await db.get(LLMService, service_id)
    if not svc:
        raise HTTPException(404, detail="Service not found")
    return _to_dict(svc)


@router.post("", status_code=201)
async def create_service(
    body: ServiceCreate,
    user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    svc = LLMService(
        **body.model_dump(),
        created_by=user["username"],
    )
    db.add(svc)
    await db.commit()
    await db.refresh(svc)
    invalidate_cache()
    return _to_dict(svc)


@router.put("/{service_id}")
async def update_service(
    service_id: int,
    body: ServiceUpdate,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    svc = await db.get(LLMService, service_id)
    if not svc:
        raise HTTPException(404, detail="Service not found")

    for key, val in body.model_dump(exclude_none=True).items():
        setattr(svc, key, val)
    await db.commit()
    await db.refresh(svc)
    invalidate_cache()
    return _to_dict(svc)


@router.delete("/{service_id}")
async def delete_service(
    service_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    svc = await db.get(LLMService, service_id)
    if not svc:
        raise HTTPException(404, detail="Service not found")
    await db.delete(svc)
    await db.commit()
    invalidate_cache()
    return {"ok": True}


@router.get("/{service_id}/health")
async def check_health(
    service_id: int,
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Check if the vLLM backend is reachable and list its models."""
    svc = await db.get(LLMService, service_id)
    if not svc:
        raise HTTPException(404, detail="Service not found")

    endpoint = svc.endpoint.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5, connect=2)) as client:
            resp = await client.get(f"{endpoint}/v1/models")
        if resp.status_code == 200:
            data = resp.json()
            models = [m.get("id") for m in data.get("data", [])]
            return {
                "healthy": True,
                "endpoint": endpoint,
                "models": models,
            }
        return {"healthy": False, "endpoint": endpoint, "error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"healthy": False, "endpoint": endpoint, "error": str(e)[:200]}


# ---------------------------------------------------------------------------
# Process management (Port-as-Truth)
# ---------------------------------------------------------------------------

def _parse_port(endpoint: str) -> int | None:
    """Extract port from endpoint URL."""
    try:
        return urlparse(endpoint).port
    except Exception:
        return None


def _find_pid_by_port(port: int) -> int | None:
    """Find PID listening on a port using lsof."""
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return int(result.stdout.strip().split("\n")[0])
    except Exception:
        pass
    return None


def _is_port_listening(port: int) -> bool:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


@router.get("/{service_id}/process")
async def get_process_status(
    service_id: int,
    _user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Check if the process is running (by port)."""
    svc = await db.get(LLMService, service_id)
    if not svc:
        raise HTTPException(404, detail="Service not found")

    port = _parse_port(svc.endpoint)
    if not port:
        return {"running": False, "error": "Cannot parse port from endpoint"}

    running = await asyncio.to_thread(_is_port_listening, port)
    pid = await asyncio.to_thread(_find_pid_by_port, port) if running else None
    return {"running": running, "port": port, "pid": pid}


@router.post("/{service_id}/start")
async def start_process(
    service_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Start vLLM process using exec_command."""
    svc = await db.get(LLMService, service_id)
    if not svc:
        raise HTTPException(404, detail="Service not found")
    if not svc.exec_command:
        raise HTTPException(400, detail="No exec_command configured for this service")

    port = _parse_port(svc.endpoint)
    if port and await asyncio.to_thread(_is_port_listening, port):
        return {"success": True, "message": "Process already running", "already_running": True}

    # Prepare log file
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = LOG_DIR / f"{svc.name}.log"
    log_fh = open(log_file, "a")

    # Build environment
    env = os.environ.copy()
    if svc.extra_env:
        env.update(svc.extra_env)

    # Start process
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
    except Exception as e:
        log_fh.close()
        raise HTTPException(500, detail=f"Failed to start process: {e}")

    # Wait for port to become available
    if port:
        for _ in range(60):  # up to 60s
            await asyncio.sleep(1)
            if _is_port_listening(port):
                logger.info("service_started: %s (pid=%d, port=%d)", svc.name, proc.pid, port)
                return {"success": True, "message": f"Process started (pid={proc.pid})", "pid": proc.pid}

        return {"success": False, "message": f"Process started (pid={proc.pid}) but port {port} not ready after 60s", "pid": proc.pid}

    return {"success": True, "message": f"Process started (pid={proc.pid})", "pid": proc.pid}


@router.post("/{service_id}/stop")
async def stop_process(
    service_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Stop vLLM process by finding PID via port."""
    svc = await db.get(LLMService, service_id)
    if not svc:
        raise HTTPException(404, detail="Service not found")

    port = _parse_port(svc.endpoint)
    if not port:
        raise HTTPException(400, detail="Cannot parse port from endpoint")

    pid = await asyncio.to_thread(_find_pid_by_port, port)
    if not pid:
        return {"success": True, "message": "No process found on port", "already_stopped": True}

    # Send SIGTERM, wait, then SIGKILL if needed
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except ProcessLookupError:
        return {"success": True, "message": "Process already exited"}
    except PermissionError:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception as e:
            raise HTTPException(500, detail=f"Cannot kill process {pid}: {e}")

    # Wait up to 10s for graceful shutdown
    for _ in range(10):
        await asyncio.sleep(1)
        if not _is_port_listening(port):
            logger.info("service_stopped: %s (pid=%d)", svc.name, pid)
            return {"success": True, "message": f"Process stopped (pid={pid})"}

    # Force kill
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except Exception:
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass

    logger.warning("service_force_killed: %s (pid=%d)", svc.name, pid)
    return {"success": True, "message": f"Process force-killed (pid={pid})"}


@router.get("/{service_id}/logs")
async def get_process_logs(
    service_id: int,
    _user: AdminUser,
    db: Annotated[AsyncSession, Depends(get_db)],
    lines: int = Query(100, ge=10, le=1000),
):
    """Read recent process log lines."""
    svc = await db.get(LLMService, service_id)
    if not svc:
        raise HTTPException(404, detail="Service not found")

    log_file = LOG_DIR / f"{svc.name}.log"
    if not log_file.exists():
        return {"lines": [], "total_lines": 0}

    from collections import deque
    all_lines = deque(maxlen=lines)
    with open(log_file, "r", errors="replace") as f:
        for line in f:
            all_lines.append(line.rstrip("\n"))

    return {"lines": list(all_lines), "total_lines": len(all_lines)}
