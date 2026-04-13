"""Import all models so SQLAlchemy Base.metadata knows about them."""

from app.models.user import User  # noqa: F401
from app.models.model_entity import ModelEntity  # noqa: F401
from app.models.model_version import ModelVersion  # noqa: F401
from app.models.model_download import ModelDownload  # noqa: F401
from app.models.api_key import ApiKey  # noqa: F401
from app.models.system_config import SystemConfig  # noqa: F401
from app.models.llm_service import LLMService  # noqa: F401
from app.models.chat_log import ChatLog  # noqa: F401
