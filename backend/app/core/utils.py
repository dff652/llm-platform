"""Shared utility functions."""

import socket
from datetime import datetime
from urllib.parse import urlparse


def is_port_listening(port: int, host: str = "127.0.0.1", timeout: float = 1) -> bool:
    """Check if a TCP port is listening."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0


def parse_url_port(url: str) -> int | None:
    """Extract port number from a URL."""
    try:
        return urlparse(url).port
    except Exception:
        return None


def to_iso(dt: datetime | None) -> str | None:
    """Convert datetime to ISO 8601 string."""
    return dt.isoformat() if dt else None
