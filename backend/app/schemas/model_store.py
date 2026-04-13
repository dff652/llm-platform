"""Model store request/response schemas."""

from datetime import datetime

from pydantic import BaseModel, Field


# ===== Remote model (from ModelScope/HuggingFace) =====

class RemoteModel(BaseModel):
    model_id: str
    name: str
    owner: str
    description: str = ""
    downloads: int = 0
    stars: int = 0
    storage_size: int = 0
    license: str = ""
    tasks: list[str] = []
    tags: list[str] = []
    frameworks: list[str] = []
    last_updated: str = ""


class RemoteModelDetail(RemoteModel):
    readme: str = ""
    files: list[dict] = []
    architectures: list[str] = []
    backend_support: dict = {}


class RemoteModelListResponse(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[RemoteModel]


# ===== Download management =====

class DownloadCreate(BaseModel):
    source: str = Field(..., pattern=r"^(modelscope|huggingface)$")
    model_id: str = Field(..., max_length=300)
    model_name: str = Field(..., max_length=200)
    model_family: str = Field("", max_length=100)
    total_size: int = 0


class DownloadResponse(BaseModel):
    id: int
    source: str
    model_id: str
    model_name: str
    model_family: str
    status: str
    progress: float
    total_size: int
    downloaded_size: int
    download_path: str | None = None
    error_message: str | None = None
    celery_task_id: str | None = None
    registered_model_id: int | None = None
    created_by: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DownloadListResponse(BaseModel):
    total: int
    items: list[DownloadResponse]


# ===== Publish =====

class PublishRequest(BaseModel):
    runtime_type: str = Field("gpu", pattern=r"^(cpu|gpu)$")
    version: str = "v1.0"
    description: str = ""
    create_service: bool = False
    service_port: int | None = None
    gpu_device: str | None = None
    quantization: str = "auto"
