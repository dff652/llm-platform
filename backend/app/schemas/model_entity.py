"""Model entity request/response schemas."""

from datetime import datetime

from pydantic import BaseModel, Field


class ModelCreate(BaseModel):
    name: str = Field(..., max_length=255)
    family: str = Field(..., max_length=50)
    runtime_type: str = Field(..., max_length=50)
    version: str = Field(..., max_length=50)
    artifact_uri: str | None = None
    base_model: str | None = None
    compatibility: dict | None = None
    metrics: dict | None = None
    tags: list[str] | None = None
    description: str | None = None
    source_task_id: str | None = None


class ModelUpdate(BaseModel):
    name: str | None = None
    version: str | None = None
    artifact_uri: str | None = None
    compatibility: dict | None = None
    metrics: dict | None = None
    tags: list[str] | None = None
    description: str | None = None


class ModelResponse(BaseModel):
    id: int
    name: str
    family: str
    runtime_type: str
    version: str | None = None
    artifact_uri: str | None = None
    base_model: str | None = None
    compatibility: dict | None = None
    metrics: dict | None = None
    tags: list[str] | None = None
    status: str
    description: str | None = None
    source_task_id: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ModelListResponse(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[ModelResponse]


class ModelPublishRequest(BaseModel):
    """发布本地模型目录到模型中心。"""
    path: str = Field(..., description="服务器上的模型目录绝对路径")
    name: str | None = Field(None, max_length=200, description="模型名称（空则取目录名）")
    family: str = Field("qwen", max_length=50)
    runtime_type: str = Field("gpu")
    version: str = Field("v1.0", max_length=50)
    description: str = ""
    create_service: bool = Field(False, description="自动创建推理引擎")
    service_port: int | None = Field(None, description="引擎端口（create_service=true 时）")
    gpu_device: str | None = Field(None, description="GPU 设备号（如 '0'）")


class ModelPublishResponse(BaseModel):
    model: ModelResponse
    model_type: str  # "full" | "adapter" | "unknown"
    service_created: bool = False
    service_id: int | None = None
