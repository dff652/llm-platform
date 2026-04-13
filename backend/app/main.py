"""LLM-Platform Backend — FastAPI Entry Point"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.database import Base, engine
from app.core.logging_config import configure_logging
import app.models  # noqa: F401 — register all ORM models

configure_logging(json_output=not settings.DEBUG)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Security: refuse startup with default JWT secret
    if settings.JWT_SECRET == "change-me-in-production":
        raise RuntimeError(
            "FATAL: JWT_SECRET is set to the default value. "
            "Set a secure JWT_SECRET in your .env file before starting the server."
        )

    # Dev convenience: auto-create tables if DEBUG=true
    if settings.DEBUG:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    # Ensure log directories exist
    from pathlib import Path
    Path(settings.LOG_DIR).mkdir(parents=True, exist_ok=True)
    Path(settings.LOG_ENGINES_DIR).mkdir(parents=True, exist_ok=True)

    # Load log rotation config from DB
    from app.core.logging_config import apply_log_settings
    from app.core.database import async_session
    async with async_session() as db:
        from app.api.system_config import get_config_value
        try:
            max_mb = int(await get_config_value(db, "log_max_size_mb"))
            backup = int(await get_config_value(db, "log_backup_count"))
            apply_log_settings(max_bytes=max_mb * 1024 * 1024, backup_count=backup)
        except Exception:
            pass  # First startup, DB may not have tables yet

    # Sync rate limit config from DB to Redis
    async with async_session() as db:
        try:
            from app.api.system_config import get_config_value
            from app.core.rate_limiter import _get_redis
            r = _get_redis()
            mapping = {
                "per_minute": await get_config_value(db, "rate_limit_per_minute"),
                "per_hour": await get_config_value(db, "rate_limit_per_hour"),
                "per_day": await get_config_value(db, "rate_limit_per_day"),
            }
            r.hset("system:rate_limits", mapping=mapping)
        except Exception:
            pass

    # Auto-start Redis + Celery worker
    from app.core.subprocess_manager import startup, shutdown
    startup()

    # Clean up stuck model downloads
    from app.services.model_store.download_service import DownloadService
    await DownloadService.reset_stuck_downloads(engine)

    yield

    shutdown()


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    lifespan=lifespan,
    redirect_slashes=False,
    docs_url="/api/docs" if settings.DEBUG else None,
    redoc_url="/api/redoc" if settings.DEBUG else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.DEBUG else settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Global exception handler ---
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception(
        "unhandled_exception: %s %s — %s",
        request.method, request.url.path, str(exc)[:500],
    )
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


# --- OpenAI-compatible API (top-level /v1/) ---
from app.api.openai_api import router as openai_router  # noqa: E402
app.include_router(openai_router, prefix="/v1", tags=["openai"])

# --- Platform Management API (/api/v1/) ---
from app.api import auth, users, models, api_keys, system_config, system_logs, dashboard, model_store, events  # noqa: E402

app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(users.router, prefix="/api/v1/users", tags=["users"])
app.include_router(models.router, prefix="/api/v1/models", tags=["models"])
app.include_router(model_store.router, prefix="/api/v1/model-store", tags=["model-store"])
app.include_router(api_keys.router, prefix="/api/v1/api-keys", tags=["api-keys"])
app.include_router(system_config.router, prefix="/api/v1/system-config", tags=["system-config"])
app.include_router(system_logs.router, prefix="/api/v1/system-logs", tags=["system-logs"])
app.include_router(dashboard.router, prefix="/api/v1/dashboard", tags=["dashboard"])
app.include_router(events.router, prefix="/api/v1/events", tags=["events"])

# --- LLM Service management ---
from app.api.llm_services import router as llm_services_router  # noqa: E402
app.include_router(llm_services_router, prefix="/api/v1/services", tags=["services"])


@app.get("/api/v1/health")
async def health_check():
    return {"status": "ok", "version": settings.APP_VERSION, "build_time": settings.BUILD_TIME}
