"""
app/config/settings.py

Centralised configuration using pydantic-settings.
All environment variables are read here — nothing else in the codebase
calls os.environ directly.

Usage:
    from app.config.settings import get_settings
    settings = get_settings()
    print(settings.slack_client_id)

The @lru_cache on get_settings() means the Settings object is created
once and reused for the lifetime of the process — env vars are not
re-read on every call.
"""

import json
from functools import lru_cache
from typing import Optional

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    All configurable values for the Collectium Slack MCP connector.
    Values are loaded from environment variables (case-insensitive) or a
    .env file in the project root.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,       # SLACK_CLIENT_ID == slack_client_id
        extra="ignore",             # silently ignore unknown env vars
    )

    # ------------------------------------------------------------------
    # App
    # ------------------------------------------------------------------
    app_name: str = Field(
        default="Collectium Slack MCP",
        validation_alias=AliasChoices("APP_NAME", "app_name"),
        description="Human-readable app name",
    )
    app_env: str = Field(
        default="development",
        validation_alias=AliasChoices("APP_ENV", "app_env"),
        description="development | staging | production",
    )
    debug: bool = Field(
        default=False,
        validation_alias=AliasChoices("DEBUG", "debug"),
        description="Enable debug logging and FastAPI debug mode",
    )
    host: str = Field(
        default="0.0.0.0",
        validation_alias=AliasChoices("APP_HOST", "HOST", "host"),
    )
    port: int = Field(
        default=8000,
        validation_alias=AliasChoices("APP_PORT", "PORT", "port"),
    )

    # ------------------------------------------------------------------
    # Slack OAuth credentials
    # Obtain from https://api.slack.com/apps → your app → Basic Information
    # ------------------------------------------------------------------
    slack_client_id: str = Field(
        ...,
        validation_alias=AliasChoices("SLACK_CLIENT_ID", "slack_client_id"),
        description="Slack app Client ID",
    )
    slack_client_secret: str = Field(
        ...,
        validation_alias=AliasChoices("SLACK_CLIENT_SECRET", "slack_client_secret"),
        description="Slack app Client Secret",
    )
    slack_signing_secret: str = Field(
        ...,
        validation_alias=AliasChoices("SLACK_SIGNING_SECRET", "slack_signing_secret"),
        description=(
            "Slack Signing Secret — used to verify X-Slack-Signature on "
            "every incoming webhook request"
        ),
    )
    slack_redirect_uri: str = Field(
        ...,
        validation_alias=AliasChoices("SLACK_REDIRECT_URI", "slack_redirect_uri"),
        description=(
            "OAuth callback URL registered in your Slack app settings. "
            "Must match exactly, including trailing slash."
        ),
        examples=["https://yourapp.com/api/oauth/callback"],
    )

    # Optional: Bot token for a single-workspace setup (skips OAuth flow)
    slack_bot_token: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("SLACK_BOT_TOKEN", "slack_bot_token"),
        description="xoxb-... bot token (single-workspace shortcut, not needed for multi-workspace)",
    )

    # ------------------------------------------------------------------
    # Supabase
    # Obtain from Supabase dashboard → Project Settings → API
    # ------------------------------------------------------------------
    supabase_url: str = Field(
        ...,
        validation_alias=AliasChoices("SUPABASE_URL", "supabase_url"),
        description="Supabase project URL  e.g. https://xxx.supabase.co",
    )
    supabase_anon_key: str = Field(
        ...,
        validation_alias=AliasChoices("SUPABASE_ANON_KEY", "supabase_anon_key"),
        description="Supabase anon/public key (safe to expose to browsers)",
    )
    supabase_service_role_key: str = Field(
        ...,
        validation_alias=AliasChoices("SUPABASE_SERVICE_KEY", "supabase_service_role_key"),
        description=(
            "Supabase service-role key — bypasses Row Level Security. "
            "Never expose this to clients."
        ),
    )

    # ------------------------------------------------------------------
    # Rate limiting / retry
    # ------------------------------------------------------------------
    slack_max_retries: int = Field(
        default=3,
        validation_alias=AliasChoices("SLACK_MAX_RETRIES", "slack_max_retries"),
        ge=0,
        le=10,
        description="Max retry attempts on Slack API rate-limit (429) responses",
    )
    slack_retry_delay: float = Field(
        default=1.0,
        validation_alias=AliasChoices(
            "SLACK_RETRY_BASE_DELAY",
            "SLACK_RETRY_DELAY",
            "slack_retry_delay",
        ),
        ge=0.1,
        description="Base delay in seconds between retries (exponential backoff applied)",
    )
    event_dedupe_ttl_seconds: int = Field(
        default=3600,
        validation_alias=AliasChoices(
            "EVENT_DEDUPE_TTL_SECONDS",
            "SLACK_EVENT_DEDUPE_TTL_SECONDS",
            "event_dedupe_ttl_seconds",
        ),
        ge=60,
        le=86400,
        description="How long to keep processed Slack event IDs in memory.",
    )
    channel_cache_ttl_seconds: int = Field(
        default=300,
        validation_alias=AliasChoices(
            "CHANNEL_CACHE_TTL_SECONDS",
            "SLACK_CHANNEL_CACHE_TTL_SECONDS",
            "channel_cache_ttl_seconds",
        ),
        ge=30,
        le=3600,
        description="How long to cache Slack channel metadata in memory.",
    )
    supabase_batch_size: int = Field(
        default=250,
        validation_alias=AliasChoices(
            "SUPABASE_BATCH_SIZE",
            "supabase_batch_size",
        ),
        ge=1,
        le=1000,
        description="Max messages per Supabase bulk upsert batch.",
    )

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------
    log_level: str = Field(
        default="INFO",
        validation_alias=AliasChoices("LOG_LEVEL", "log_level"),
        description="Python logging level: DEBUG | INFO | WARNING | ERROR | CRITICAL",
    )
    log_format: str = Field(
        default="json",
        validation_alias=AliasChoices("LOG_FORMAT", "log_format"),
        description="Log output format: 'json' (production) | 'text' (development)",
    )

    # ------------------------------------------------------------------
    # CORS (for the FastAPI app)
    # ------------------------------------------------------------------
    cors_origins: list[str] = Field(
        default=["*"],
        validation_alias=AliasChoices("ALLOWED_ORIGINS", "CORS_ORIGINS", "cors_origins"),
        description="Allowed CORS origins. In production, list explicit domains.",
    )

    # ------------------------------------------------------------------
    # Validators
    # ------------------------------------------------------------------

    @field_validator("app_env")
    @classmethod
    def validate_app_env(cls, v: str) -> str:
        allowed = {"development", "staging", "production"}
        if v not in allowed:
            raise ValueError(f"app_env must be one of {allowed}, got {v!r}")
        return v

    @field_validator("debug", mode="before")
    @classmethod
    def validate_debug(cls, v):
        if isinstance(v, bool):
            return v
        if v is None:
            return False
        normalized = str(v).strip().lower()
        if normalized in {"1", "true", "yes", "on", "debug"}:
            return True
        if normalized in {"0", "false", "no", "off", "release", ""}:
            return False
        raise ValueError("debug must be a boolean-like value")

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, v: str) -> str:
        allowed = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        upper = v.upper()
        if upper not in allowed:
            raise ValueError(f"log_level must be one of {allowed}")
        return upper

    @field_validator("supabase_url")
    @classmethod
    def validate_supabase_url(cls, v: str) -> str:
        if not v.startswith("https://"):
            raise ValueError("supabase_url must start with https://")
        return v.rstrip("/")   # normalise — no trailing slash

    @field_validator("slack_redirect_uri")
    @classmethod
    def validate_redirect_uri(cls, v: str) -> str:
        if not v.startswith("http"):
            raise ValueError("slack_redirect_uri must be a full URL starting with http(s)://")
        return v

    # ------------------------------------------------------------------
    # Derived helpers
    # ------------------------------------------------------------------

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def is_development(self) -> bool:
        return self.app_env == "development"

    @property
    def app_host(self) -> str:
        return self.host

    @property
    def app_port(self) -> int:
        return self.port

    @property
    def allowed_origins(self) -> list[str]:
        return self.cors_origins


    @field_validator("cors_origins", mode="before")
    @classmethod
    def validate_cors_origins(cls, v):
        if isinstance(v, list):
            return v
        if v is None:
            return ["*"]
        text = str(v).strip()
        if not text:
            return ["*"]
        if text.startswith("["):
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError("cors_origins must be valid JSON or comma-separated") from exc
            if not isinstance(parsed, list):
                raise ValueError("cors_origins JSON value must be a list")
            return [str(item).strip() for item in parsed if str(item).strip()]
        return [part.strip() for part in text.split(",") if part.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """
    Returns the cached Settings singleton.
    Call this anywhere you need config — do NOT instantiate Settings directly.
    """
    return Settings()  # type: ignore[call-arg]
