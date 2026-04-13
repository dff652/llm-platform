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
