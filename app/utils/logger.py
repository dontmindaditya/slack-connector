"""
app/utils/logger.py

Configures Python's standard logging for the entire application.

- In production (log_format=json): emits structured JSON lines — compatible
  with Datadog, GCP Cloud Logging, AWS CloudWatch, etc.
- In development (log_format=text): emits colourised, human-readable output.

Call setup_logging() once at application startup (in main.py).
Every other module just does `logger = logging.getLogger(__name__)`.
"""

import logging
import sys
from datetime import datetime, timezone
from typing import Any

from app.config.settings import get_settings


# ---------------------------------------------------------------------------
# JSON formatter
# ---------------------------------------------------------------------------

class JsonFormatter(logging.Formatter):
    """
    Formats each log record as a single-line JSON object.

    Fields emitted:
      timestamp  — ISO-8601 UTC
      level      — DEBUG / INFO / WARNING / ERROR / CRITICAL
      logger     — __name__ of the module that emitted the record
      message    — formatted log message
      exc_info   — exception traceback (only when an exception is active)
      **extra    — any extra= kwargs passed to the logger call
    """

    def format(self, record: logging.LogRecord) -> str:
        import json

        log_object: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Attach exception info when present
        if record.exc_info:
            log_object["exc_info"] = self.formatException(record.exc_info)

        if record.stack_info:
            log_object["stack_info"] = self.formatStack(record.stack_info)

        # Merge any extra= fields the caller passed in
        skip_fields = {
            "args", "asctime", "created", "exc_info", "exc_text",
            "filename", "funcName", "id", "levelname", "levelno",
            "lineno", "module", "msecs", "message", "msg", "name",
            "pathname", "process", "processName", "relativeCreated",
            "stack_info", "thread", "threadName", "taskName",
        }
        for key, value in record.__dict__.items():
            if key not in skip_fields:
                log_object[key] = value

        return json.dumps(log_object, default=str, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Colourised text formatter (development only)
# ---------------------------------------------------------------------------

_LEVEL_COLOURS = {
    "DEBUG":    "\033[36m",   # cyan
    "INFO":     "\033[32m",   # green
    "WARNING":  "\033[33m",   # yellow
    "ERROR":    "\033[31m",   # red
    "CRITICAL": "\033[35m",   # magenta
}
_RESET = "\033[0m"


class ColourTextFormatter(logging.Formatter):
    """Human-readable colourised log lines for local development."""

    FMT = "{colour}[{level:<8}]{reset} {time} | {name:<40} | {message}"

    def format(self, record: logging.LogRecord) -> str:
        colour = _LEVEL_COLOURS.get(record.levelname, "")
        time_str = datetime.fromtimestamp(record.created, tz=timezone.utc).strftime(
            "%H:%M:%S.%f"
        )[:-3]   # trim microseconds to milliseconds

        line = self.FMT.format(
            colour=colour,
            level=record.levelname,
            reset=_RESET,
            time=time_str,
            name=record.name,
            message=record.getMessage(),
        )

        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)

        return line


# ---------------------------------------------------------------------------
# Public setup function
# ---------------------------------------------------------------------------

def setup_logging() -> None:
    """
    Configure root logger and silence noisy third-party loggers.
    Call once at application startup.
    """
    settings = get_settings()
    level = getattr(logging, settings.log_level, logging.INFO)

    # Choose formatter based on environment
    if settings.log_format == "json":
        formatter: logging.Formatter = JsonFormatter()
    else:
        formatter = ColourTextFormatter()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # Remove any handlers added by libraries before we configure
    root_logger.handlers.clear()
    root_logger.addHandler(handler)

    # ------------------------------------------------------------------
    # Quieten noisy third-party loggers
    # ------------------------------------------------------------------
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("asyncio").setLevel(logging.WARNING)

    # Supabase / postgrest can be very chatty at DEBUG
    logging.getLogger("postgrest").setLevel(logging.WARNING)
    logging.getLogger("gotrue").setLevel(logging.WARNING)
    logging.getLogger("realtime").setLevel(logging.WARNING)

    logging.getLogger(__name__).info(
        "Logging configured — level=%s format=%s env=%s",
        settings.log_level,
        settings.log_format,
        settings.app_env,
    )


def get_logger(name: str) -> logging.Logger:
    """
    Convenience wrapper.  Prefer the standard `logging.getLogger(__name__)`
    pattern; this helper exists for modules that want a single import.
    """
    return logging.getLogger(name)