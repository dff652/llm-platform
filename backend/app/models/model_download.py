"""Model download tracking ORM model."""

from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ModelDownload(Base):
    __tablename__ = "model_downloads"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(String(50), nullable=False)  # modelscope | huggingface
    model_id: Mapped[str] = mapped_column(String(300), nullable=False)  # e.g. Qwen/Qwen3-8B
    model_name: Mapped[str] = mapped_column(String(200), nullable=False)  # display name
    model_family: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending"
    )  # pending | downloading | completed | failed | cancelled
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    total_size: Mapped[int] = mapped_column(BigInteger, default=0)  # bytes (supports >2GB models)
    downloaded_size: Mapped[int] = mapped_column(BigInteger, default=0)
    download_path: Mapped[str | None] = mapped_column(String(500))
    error_message: Mapped[str | None] = mapped_column(Text)
    celery_task_id: Mapped[str | None] = mapped_column(String(100))
    registered_model_id: Mapped[int | None] = mapped_column(Integer)  # FK to models.id after publish
    created_by: Mapped[str] = mapped_column(String(50), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
