from functools import lru_cache
from typing import Optional, List

from pydantic_settings import BaseSettings
from pydantic import Field, field_validator


class Settings(BaseSettings):
    WHATSAPP_VERIFY_TOKEN: str = Field(...)
    WHATSAPP_APP_SECRET: str = Field(...)
    WHATSAPP_PHONE_NUMBER_ID: str = Field(...)
    
    ALLOWED_IP_RANGES: str = Field(default="")
    RATE_LIMIT_PER_PHONE: int = Field(default=30)
    RATE_LIMIT_GLOBAL: int = Field(default=1000)
    
    ENCRYPTION_KEY: str = Field(...)
    
    # Neon PostgreSQL
    DATABASE_URL: str = Field(default="postgresql+asyncpg://user:pass@host.neon.tech/db?ssl=require")
    
    # Upstash Redis (optional but recommended)
    REDIS_URL: Optional[str] = Field(default=None)
    
    # AI Team (leave empty until ready)
    AI_TEAM_WEBHOOK_URL: Optional[str] = Field(default=None)
    AI_TEAM_API_KEY: Optional[str] = Field(default=None)
    MAX_RETRIES: int = Field(default=5)
    RETRY_BASE_DELAY: float = Field(default=2.0)
    
    ENVIRONMENT: str = Field(default="production")
    LOG_LEVEL: str = Field(default="INFO")
    
    @field_validator("ALLOWED_IP_RANGES", mode="before")
    @classmethod
    def parse_ip_ranges(cls, v):
        if not v:
            return []
        return [x.strip() for x in v.split(",") if x.strip()]
    
    @field_validator("ENCRYPTION_KEY", mode="before")
    @classmethod
    def validate_fernet_key(cls, v):
        if not v:
            raise ValueError("ENCRYPTION_KEY is required")
        return v
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
