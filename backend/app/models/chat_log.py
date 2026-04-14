"""Chat log ORM model — records every API call for monitoring and billing."""

from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base


class ChatLog(Base):
    __tablename__ = "chat_logs"
    __table_args__ = (
        Index("idx_chat_logs_created_at", "created_at"),
        Index("idx_chat_logs_model", "model"),
        Index("idx_chat_logs_status_created", "status", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Request metadata
    request_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    endpoint_type: Mapped[str] = mapped_column(String(20), nullable=False)  # "chat" | "completions"
    stream: Mapped[bool] = mapped_column(default=False)
    # Auth
    user_id: Mapped[int | None] = mapped_column(Integer)
    api_key_id: Mapped[int | None] = mapped_column(Integer)
    api_key_name: Mapped[str | None] = mapped_column(String(100))
    # Token usage
    prompt_tokens: Mapped[int | None] = mapped_column(Integer)
    completion_tokens: Mapped[int | None] = mapped_column(Integer)
    total_tokens: Mapped[int | None] = mapped_column(Integer)
    # Latency
    latency_ms: Mapped[float | None] = mapped_column(Float)
    time_to_first_token_ms: Mapped[float | None] = mapped_column(Float)
    # Status
    status: Mapped[str] = mapped_column(String(20), default="success")  # success | error
    error_message: Mapped[str | None] = mapped_column(Text)
    error_code: Mapped[str | None] = mapped_column(String(50))
    # Service routing
    service_id: Mapped[int | None] = mapped_column(Integer)
    service_endpoint: Mapped[str | None] = mapped_column(String(500))
    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
