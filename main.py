"""
main.py

FastAPI application entry point for the Collectium Slack MCP connector.

Run locally:
    uvicorn main:app --reload --port 8000
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import events_router, messages_router, oauth_router
from app.config.settings import get_settings
from app.utils.logger import setup_logging

# ---------------------------------------------------------------------------
# Bootstrap — configure logging and validate settings before anything else
# ---------------------------------------------------------------------------

settings = get_settings()
setup_logging()   # reads level + format from settings internally
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lifespan — startup / shutdown hooks
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Startup: verify Supabase connectivity so we fail fast on misconfiguration.
    Shutdown: log graceful exit.
    """
    logger.info(
        "Starting %s  env=%s  debug=%s",
        settings.app_name,
        settings.app_env,
        settings.debug,
    )

    # Lightweight Supabase ping — confirms URL + key are valid
    try:
        from app.services.supabase_service import ping_supabase
        await ping_supabase()
        logger.info("Supabase connection OK")
    except Exception as exc:
        # Non-fatal on startup — allows running without DB in pure dev mode
        logger.warning("Supabase startup check failed: %s", exc)

    logger.info("Ready — %s:%d", settings.app_host, settings.app_port)
    yield
    logger.info("Shutting down")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title=settings.app_name,
    description="Collectium MCP connector — Slack OAuth, message sync, event processing.",
    version="1.0.0",
    debug=settings.debug,
    # Hide interactive docs in production
    docs_url="/docs" if not settings.is_production else None,
    redoc_url="/redoc" if not settings.is_production else None,
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Global exception handlers
# ---------------------------------------------------------------------------

@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    """Workspace-not-found / bad-input errors → 400."""
    logger.warning("ValueError on %s: %s", request.url.path, exc)
    return JSONResponse(status_code=400, content={"ok": False, "error": str(exc)})


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    """Catch-all — returns 500 without leaking stack traces in production."""
    logger.exception("Unhandled exception on %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "ok": False,
            "error": "Internal server error",
            "detail": str(exc) if not settings.is_production else None,
        },
    )


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

app.include_router(oauth_router)
app.include_router(messages_router)
app.include_router(events_router)


# ---------------------------------------------------------------------------
# Health routes
# ---------------------------------------------------------------------------

@app.get("/", tags=["Health"])
async def root():
    return {"service": settings.app_name, "version": "1.0.0", "status": "ok"}


@app.get("/health", tags=["Health"])
async def health():
    return {"ok": True, "service": settings.app_name, "env": settings.app_env}


# ---------------------------------------------------------------------------
# Dev entrypoint — python main.py
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=settings.app_host,
        port=settings.app_port,
        reload=settings.is_development,
        log_level=settings.log_level.lower(),
    )
