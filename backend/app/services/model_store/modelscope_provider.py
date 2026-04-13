"""ModelScope provider — proxy ModelScope REST API for model browsing & download."""

import hashlib
import json
import logging
from datetime import datetime, timezone

import httpx

from app.schemas.model_store import RemoteModel, RemoteModelDetail
from app.services.model_store.provider import ModelStoreProvider

logger = logging.getLogger(__name__)

MODELSCOPE_API = "https://modelscope.cn/api/v1"
CACHE_TTL = 600  # 10 minutes


def _get_redis():
    """Get Redis client, return None if unavailable."""
    try:
        import redis
        from app.core.config import settings
        return redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)
    except Exception:
        return None


def _cache_get(key: str) -> dict | None:
    r = _get_redis()
    if not r:
        return None
    try:
        val = r.get(key)
        return json.loads(val) if val else None
    except Exception:
        return None


def _cache_set(key: str, data: dict, ttl: int = CACHE_TTL):
    r = _get_redis()
    if not r:
        return
    try:
        r.setex(key, ttl, json.dumps(data, ensure_ascii=False))
    except Exception:
        pass


def _ts_to_iso(ts: int | None) -> str:
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except (OSError, ValueError):
        return ""


def _parse_model(raw: dict) -> RemoteModel:
    """Parse a model dict from ModelScope search results."""
    path = raw.get("Path", "")
    name = raw.get("Name", "")
    return RemoteModel(
        model_id=f"{path}/{name}" if path else name,
        name=name,
        owner=path,
        description=raw.get("ChineseName", "") or raw.get("Description", ""),
        downloads=raw.get("Downloads", 0),
        stars=raw.get("Stars", 0),
        storage_size=raw.get("StorageSize", 0),
        license=raw.get("License", ""),
        tasks=[t.get("Name", "") for t in (raw.get("Tasks") or [])],
        tags=raw.get("Tags") or [],
        frameworks=raw.get("Frameworks") or [],
        last_updated=_ts_to_iso(raw.get("LastUpdatedTime")),
    )


class ModelScopeProvider(ModelStoreProvider):

    async def search_models(
        self,
        query: str = "",
        owner: str = "",
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[RemoteModel], int]:
        # Check cache
        cache_key = f"ms:search:{hashlib.md5(f'{query}:{owner}:{page}:{page_size}'.encode()).hexdigest()}"
        cached = _cache_get(cache_key)
        if cached:
            models = [RemoteModel(**m) for m in cached["models"]]
            return models, cached["total"]

        body: dict = {
            "PageNumber": page,
            "PageSize": page_size,
            "SortBy": "Default",
        }
        if owner:
            body["Path"] = owner
        if query:
            body["Name"] = query

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.put(f"{MODELSCOPE_API}/models", json=body)
            resp.raise_for_status()

        data = resp.json().get("Data", {})
        total = data.get("TotalCount", 0)
        models = [_parse_model(m) for m in (data.get("Models") or [])]

        # Cache result
        _cache_set(cache_key, {
            "total": total,
            "models": [m.model_dump() for m in models],
        })

        return models, total

    async def get_model_detail(self, model_id: str) -> RemoteModelDetail | None:
        """Get model detail + file listing from ModelScope."""
        async with httpx.AsyncClient(timeout=15) as client:
            # Model info
            resp = await client.get(f"{MODELSCOPE_API}/models/{model_id}")
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            raw = resp.json().get("Data", {})

            # File listing
            files = []
            try:
                file_resp = await client.get(
                    f"{MODELSCOPE_API}/models/{model_id}/repo/files"
                )
                if file_resp.status_code == 200:
                    file_data = file_resp.json().get("Data", {})
                    for f in file_data.get("Files") or []:
                        files.append({
                            "name": f.get("Name", ""),
                            "path": f.get("Path", ""),
                            "size": f.get("Size", 0),
                        })
            except Exception as e:
                logger.warning("Failed to fetch file list for %s: %s", model_id, e)

        base = _parse_model(raw)
        # BackendSupport has nested structure: {backend_info: {vllm: {...}, ...}}
        raw_bs = raw.get("BackendSupport") or {}
        backend_info = raw_bs.get("backend_info", {}) if isinstance(raw_bs, dict) else {}
        return RemoteModelDetail(
            **base.model_dump(),
            readme=raw.get("ReadMeContent", ""),
            files=files,
            architectures=raw_bs.get("architectures") or raw.get("Architectures") or [],
            backend_support=backend_info,
        )

    def get_download_command(self, model_id: str, cache_dir: str) -> list[str]:
        """Return Python command to download via modelscope SDK."""
        script = (
            f"from modelscope import snapshot_download; "
            f"snapshot_download('{model_id}', cache_dir='{cache_dir}')"
        )
        return ["python", "-c", script]
