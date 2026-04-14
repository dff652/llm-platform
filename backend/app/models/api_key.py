"""API Key ORM model — external system authentication."""

from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    key_prefix: Mapped[str] = mapped_column(String(10), nullable=False)
    key_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    key_value: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # 限流配置：0 = 使用系统默认值
    rate_limit_per_minute: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    rate_limit_per_hour: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    rate_limit_per_day: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Token 用量配额：-1 = 不限制，0 = 禁止，正数 = 上限
    token_quota: Mapped[int] = mapped_column(BigInteger, default=-1, server_default="-1")
    token_used: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        Index("idx_api_keys_user", "user_id"),
        Index("idx_api_keys_prefix", "key_prefix"),
        Index("idx_api_keys_active", "is_active"),
    )
