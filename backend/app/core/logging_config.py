"""Structured logging configuration using structlog with stdlib integration."""
import logging
import re
from logging.handlers import RotatingFileHandler
from pathlib import Path

import structlog

from app.core.config import settings

# 模块级引用，供 apply_log_settings() 热更新
_file_handler: RotatingFileHandler | None = None

# ANSI 转义码正则（剥离颜色/粗体等终端控制符）
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


class StripAnsiFormatter(logging.Formatter):
    """包装 formatter，剥离 ANSI 颜色码（用于文件输出）。"""

    def __init__(self, inner: logging.Formatter):
        super().__init__()
        self._inner = inner

    def format(self, record: logging.LogRecord) -> str:
        msg = self._inner.format(record)
        return _ANSI_RE.sub("", msg) if "\x1b[" in msg else msg


def configure_logging(json_output: bool = True):
    """Configure structlog processors and stdlib integration.

    Args:
        json_output: True for JSON log format (production), False for colored console (dev).
    """
    global _file_handler

    shared_processors = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
    ]

    if json_output:
        renderer = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer()

    structlog.configure(
        processors=[
            *shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            renderer,
        ],
    )

    # 控制台输出（保留颜色）
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(console_handler)

    # 文件输出（带轮转，剥离 ANSI 颜色码）
    log_path = Path(settings.LOG_APP)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    _file_handler = RotatingFileHandler(
        log_path,
        maxBytes=settings.LOG_MAX_BYTES,
        backupCount=settings.LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    _file_handler.setFormatter(StripAnsiFormatter(formatter))
    root_logger.addHandler(_file_handler)

    root_logger.setLevel(logging.INFO)

    # SQLAlchemy SQL 日志太吵，只记录 WARNING 以上
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

    # uvicorn access/error logger 统一走 root（不再自带 handler）
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        uv_logger = logging.getLogger(name)
        uv_logger.handlers.clear()
        uv_logger.propagate = True


def apply_log_settings(max_bytes: int, backup_count: int):
    """热更新日志轮转参数（从系统设置页面调用）。"""
    if _file_handler is None:
        return
    _file_handler.maxBytes = max_bytes
    _file_handler.backupCount = backup_count
