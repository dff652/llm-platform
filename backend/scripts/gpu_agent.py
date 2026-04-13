"""
GPU Agent — 宿主机轻量服务，供容器化部署的 backend 远程调用

提供 3 个接口：
  GET  /gpu-stats       — nvidia-smi GPU 状态
  POST /process/start   — 启动 vLLM 进程
  POST /process/stop    — 停止 vLLM 进程

启动方式（宿主机上运行，使用 vLLM 环境的 Python）：
  /opt/vllm-env/bin/python3 scripts/gpu_agent.py --port 9100
  # 或指定 token:
  /opt/vllm-env/bin/python3 scripts/gpu_agent.py --port 9100 --token <secret>

容器 backend 通过 GPU_AGENT_URL=http://host.docker.internal:9100 调用。
"""

import argparse
import asyncio
import logging
import os
import signal
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException, Depends, Header
from pydantic import BaseModel
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("gpu-agent")

app = FastAPI(title="GPU Agent", version="1.0.0")

# Auth token (optional, set via --token or GPU_AGENT_TOKEN env)
_AUTH_TOKEN: str | None = None
PROCESS_LOG_DIR = Path("./logs/engines")


def _check_token(authorization: str | None = Header(None)):
    if not _AUTH_TOKEN:
        return
    if not authorization or authorization != f"Bearer {_AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── GPU Stats ──

def _safe_float(s: str) -> float | None:
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def _query_gpu_stats() -> list[dict]:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return []
        gpus = []
        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 6:
                continue
            gpu = {
                "index": int(parts[0]),
                "name": parts[1],
                "memory_used_mb": _safe_float(parts[2]),
                "memory_total_mb": _safe_float(parts[3]),
                "utilization_pct": _safe_float(parts[4]),
                "temperature_c": _safe_float(parts[5]),
            }
            if len(parts) >= 8:
                gpu["power_draw_w"] = _safe_float(parts[6])
                gpu["power_limit_w"] = _safe_float(parts[7])
            if gpu["memory_total_mb"] and gpu["memory_total_mb"] > 0:
                gpu["memory_pct"] = round(gpu["memory_used_mb"] / gpu["memory_total_mb"] * 100, 1)
            else:
                gpu["memory_pct"] = 0
            gpus.append(gpu)
        return gpus
    except Exception as e:
        logger.warning("nvidia-smi failed: %s", e)
        return []


@app.get("/gpu-stats", dependencies=[Depends(_check_token)])
async def get_gpu_stats():
    gpus = await asyncio.to_thread(_query_gpu_stats)
    logger.info("GET /gpu-stats → %d GPUs", len(gpus))
    return {"gpus": gpus, "count": len(gpus)}


# ── Process Management ──

async def _find_pids_on_port(port: int) -> list[int]:
    proc = await asyncio.create_subprocess_exec(
        "lsof", "-ti", f":{port}",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0 or not stdout.strip():
        return []
    return [int(line.strip()) for line in stdout.decode().strip().split("\n") if line.strip().isdigit()]


async def _is_port_open(port: int) -> bool:
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection("127.0.0.1", port), timeout=1,
        )
        writer.close()
        await writer.wait_closed()
        return True
    except Exception:
        return False


class StartRequest(BaseModel):
    exec_command: str
    service_name: str = "unknown"
    port: int | None = None
    extra_env: dict[str, str] | None = None
    work_dir: str | None = None


class StopRequest(BaseModel):
    port: int


@app.post("/process/start", dependencies=[Depends(_check_token)])
async def start_process(req: StartRequest):
    logger.info("POST /process/start: service=%s, port=%s", req.service_name, req.port)
    if not req.exec_command:
        raise HTTPException(400, "exec_command is required")

    if req.port and await _is_port_open(req.port):
        logger.warning("  port %s already in use", req.port)
        raise HTTPException(409, f"端口 {req.port} 已被占用")

    env = os.environ.copy()
    env.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    if req.extra_env:
        env.update(req.extra_env)

    PROCESS_LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = PROCESS_LOG_DIR / f"{req.service_name}.log"
    log_file = open(log_path, "w", encoding="utf-8")

    try:
        ts_cmd = f"{{ {req.exec_command} ; }} 2>&1 | awk '{{ print strftime(\"[%Y-%m-%d %H:%M:%S]\"), $0; fflush() }}'"
        proc = await asyncio.create_subprocess_exec(
            "bash", "-c", ts_cmd,
            stdout=log_file, stderr=log_file,
            cwd=req.work_dir or None,
            env=env,
            start_new_session=True,
        )
        log_file.close()  # 子进程已继承 fd，父进程可安全关闭
        logger.info("Started pid=%d for %s, log=%s", proc.pid, req.service_name, log_path)
    except Exception as e:
        log_file.close()
        raise HTTPException(500, f"启动失败: {e}")

    # Poll until ready
    if req.port:
        logger.info("  waiting for port %d...", req.port)
        for _ in range(60):
            await asyncio.sleep(2)
            if await _is_port_open(req.port):
                logger.info("  port %d ready, model loaded", req.port)
                return {"success": True, "message": f"进程已启动 (pid={proc.pid})，模型加载完成", "pid": proc.pid}
            if proc.returncode is not None:
                logger.error("  process exited with code=%s", proc.returncode)
                raise HTTPException(500, f"进程启动后退出 (code={proc.returncode})")
        logger.warning("  port %d not ready after 120s", req.port)

    return {"success": True, "message": f"进程已启动 (pid={proc.pid})，模型加载中...", "pid": proc.pid}


@app.post("/process/stop", dependencies=[Depends(_check_token)])
async def stop_process(req: StopRequest):
    logger.info("POST /process/stop: port=%d", req.port)
    pids = await _find_pids_on_port(req.port)
    if not pids:
        logger.info("  no process on port %d", req.port)
        return {"success": True, "message": "端口上无运行进程"}

    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
            logger.info("SIGTERM → pid=%d (port %d)", pid, req.port)
        except ProcessLookupError:
            pass
        except PermissionError:
            raise HTTPException(403, f"无权限停止进程 pid={pid}")

    for _ in range(20):
        await asyncio.sleep(0.5)
        if not await _is_port_open(req.port):
            return {"success": True, "message": f"进程已停止 (pids={pids})"}

    remaining = await _find_pids_on_port(req.port)
    for pid in remaining:
        try:
            os.kill(pid, signal.SIGKILL)
            logger.warning("SIGKILL → pid=%d (port %d)", pid, req.port)
        except (ProcessLookupError, PermissionError):
            pass

    await asyncio.sleep(1)
    if await _is_port_open(req.port):
        raise HTTPException(500, f"无法停止端口 {req.port} 上的进程")
    return {"success": True, "message": f"进程已强制停止 (pids={pids})"}


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="GPU Agent for containerized deployment")
    parser.add_argument("--port", type=int, default=9100)
    parser.add_argument("--token", type=str, default=os.environ.get("GPU_AGENT_TOKEN", ""))
    args = parser.parse_args()

    _AUTH_TOKEN = args.token or None
    if _AUTH_TOKEN:
        logger.info("Auth token enabled")
    else:
        logger.info("Auth token disabled (open access)")

    uvicorn.run(app, host="0.0.0.0", port=args.port)
