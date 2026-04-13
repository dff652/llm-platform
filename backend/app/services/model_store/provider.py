"""Abstract base class for model store providers."""

from abc import ABC, abstractmethod

from app.schemas.model_store import RemoteModel, RemoteModelDetail


class ModelStoreProvider(ABC):
    """Interface for remote model sources (ModelScope, HuggingFace, etc.)."""

    @abstractmethod
    async def search_models(
        self,
        query: str = "",
        owner: str = "",
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[RemoteModel], int]:
        """Search models. Returns (items, total_count)."""
        ...

    @abstractmethod
    async def get_model_detail(self, model_id: str) -> RemoteModelDetail | None:
        """Get detailed info for a single model (README, files, etc.)."""
        ...

    @abstractmethod
    def get_download_command(self, model_id: str, cache_dir: str) -> list[str]:
        """Return the command args to download the model (run in Celery)."""
        ...
