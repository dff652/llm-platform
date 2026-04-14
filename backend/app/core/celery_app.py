"""Celery application — used for model downloads and background tasks."""

from celery import Celery

from app.core.config import settings

celery_app = Celery(
    "llm_platform",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
)

celery_app.conf.update(
    imports=["app.tasks.model_download_task"],
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Shanghai",
    enable_utc=True,
    task_track_started=True,
    worker_concurrency=4,
    worker_prefetch_multiplier=1,
)


# ---------------------------------------------------------------------------
# Sync DB session for background threads (model downloads, etc.)
# ---------------------------------------------------------------------------

_sync_engine = None


def _get_sync_engine():
    """Module-level singleton sync engine."""
    global _sync_engine
    if _sync_engine is None:
        from sqlalchemy import create_engine, event
        _sync_engine = create_engine(
            settings.DATABASE_SYNC_URL,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
            pool_timeout=30,
            pool_recycle=1800,
        )
        if settings.DATABASE_SYNC_URL.startswith("sqlite"):
            @event.listens_for(_sync_engine, "connect")
            def _set_sqlite_pragma(dbapi_conn, connection_record):
                cursor = dbapi_conn.cursor()
                cursor.execute("PRAGMA journal_mode=WAL")
                cursor.execute("PRAGMA busy_timeout=5000")
                cursor.close()
    return _sync_engine


def _get_sync_session():
    """Create a synchronous DB session for background threads."""
    from sqlalchemy.orm import Session
    return Session(_get_sync_engine())
