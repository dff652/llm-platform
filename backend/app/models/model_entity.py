"""Model registry ORM model."""

from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base


class ModelEntity(Base):
    __tablename__ = "models"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    family: Mapped[str] = mapped_column(String(50), nullable=False)
    runtime_type: Mapped[str] = mapped_column(String(50), nullable=False)
    version: Mapped[str | None] = mapped_column(String(50))
    artifact_uri: Mapped[str | None] = mapped_column(String(500))
    base_model: Mapped[str | None] = mapped_column(String(200))
    compatibility: Mapped[dict | None] = mapped_column(JSON)
    metrics: Mapped[dict | None] = mapped_column(JSON)
    tags: Mapped[dict | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(
        Enum("active", "archived", "disabled", name="model_status"),
        default="active",
    )
    description: Mapped[str | None] = mapped_column(Text)
    source_task_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
