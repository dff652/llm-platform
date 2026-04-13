"""Application configuration via Pydantic Settings."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # App
    APP_NAME: str = "LLM-Platform"
    APP_VERSION: str = "0.1.0"
    BUILD_TIME: str = ""
    DEBUG: bool = False

    # Containerized mode — disables subprocess management (Redis/Celery auto-start)
    IS_CONTAINERIZED: bool = False
    # GPU Agent URL — container mode: host agent for GPU monitoring
    GPU_AGENT_URL: str = ""

    # Database (PostgreSQL)
    DATABASE_URL: str = "postgresql+asyncpg://llmuser:llmpass123@localhost:5432/llm_platform"
    DATABASE_SYNC_URL: str = "postgresql+psycopg2://llmuser:llmpass123@localhost:5432/llm_platform"

    # Redis & Celery
    REDIS_URL: str = "redis://localhost:6379/0"
    CELERY_BROKER_URL: str = "redis://localhost:6379/0"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/1"

    # Auth
    JWT_SECRET: str = "change-me-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_HOURS: int = 24

    # Ports
    API_PORT: int = 8100

    # Paths
    DATA_ROOT: str = "./app/data"

    # Logs
    LOG_DIR: str = "./logs"
    LOG_APP: str = "./logs/app.log"
    LOG_CELERY: str = "./logs/celery.log"
    LOG_ENGINES_DIR: str = "./logs/engines"
    LOG_MAX_BYTES: int = 10 * 1024 * 1024  # 10MB per file
    LOG_BACKUP_COUNT: int = 5

    # Model artifacts
    MODEL_DOWNLOAD_DIR: str = "./llm_models"
    MODEL_PUBLISH_ALLOWED_DIRS: str = "/home/share/models,/home/share/llm_models"

    # vLLM defaults
    VLLM_PYTHON_PATH: str = ""
    VLLM_REQUEST_TIMEOUT: int = 120
    VLLM_MAX_TOKENS: int = 4096

    # Task
    MAX_CONCURRENT_TASKS: int = 16

    # CORS
    ALLOWED_ORIGINS: list[str] = ["http://localhost:5175", "http://localhost:3000"]

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    def model_post_init(self, __context):
        """Container mode: convert relative paths to absolute paths (WORKDIR=/app)"""
        if self.IS_CONTAINERIZED:
            path_fields = {
                "DATA_ROOT": "/app/data",
                "LOG_DIR": "/app/logs",
                "LOG_APP": "/app/logs/app.log",
                "LOG_CELERY": "/app/logs/celery.log",
                "LOG_ENGINES_DIR": "/app/logs/engines",
            }
            for field, abs_path in path_fields.items():
                current = getattr(self, field)
                if current.startswith("./"):
                    object.__setattr__(self, field, abs_path)


settings = Settings()
