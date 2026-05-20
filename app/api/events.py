"""
FastAPI router for the Slack Events API webhook endpoint.
"""

import logging
import time

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import JSONResponse

from app.config.settings import get_settings
from app.services import slack_events
from app.utils.slack_verification import verify_slack_signature

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/events", tags=["Events"])
settings = get_settings()
_processed_event_ids: dict[str, float] = {}


def _prune_processed_events(now: float | None = None) -> None:
    current = now if now is not None else time.time()
    ttl = settings.event_dedupe_ttl_seconds
    expired = [
        event_id
        for event_id, seen_at in _processed_event_ids.items()
        if current - seen_at > ttl
    ]
    for event_id in expired:
        _processed_event_ids.pop(event_id, None)


def _mark_event_seen(event_id: str) -> bool:
    now = time.time()
    _prune_processed_events(now)
    if event_id in _processed_event_ids:
        return False
    _processed_event_ids[event_id] = now
    return True


@router.post("/webhook", summary="Receive Slack event callbacks")
async def slack_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
):
    try:
        raw_body = await request.body()
    except Exception as exc:
        logger.error("Failed to read request body: %s", exc)
        raise HTTPException(status_code=400, detail="Cannot read request body")

    try:
        payload: dict = await request.json()
    except Exception as exc:
        logger.error("Failed to parse webhook JSON: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    # Respond to Slack's URL-verification challenge before signature check.
    # This is safe: the challenge is a random token sent over HTTPS that
    # proves we own the URL — no sensitive data is involved.
    if payload.get("type") == "url_verification":
        logger.info("Responding to Slack URL verification challenge")
        return JSONResponse(content={"challenge": payload.get("challenge", "")})

    timestamp = request.headers.get("X-Slack-Request-Timestamp", "")
    signature = request.headers.get("X-Slack-Signature", "")
    if not verify_slack_signature(raw_body=raw_body, timestamp=timestamp, signature=signature):
        logger.warning(
            "Slack signature verification failed (timestamp=%s, sig=%s...)",
            timestamp,
            signature[:20],
        )
        raise HTTPException(status_code=403, detail="Invalid Slack signature")

    event_id = payload.get("event_id", "unknown")
    event_type = payload.get("event", {}).get("type", "unknown")
    if event_id != "unknown" and not _mark_event_seen(event_id):
        logger.info("Ignoring duplicate Slack webhook event_id=%s type=%s", event_id, event_type)
        return JSONResponse(content={"ok": True, "duplicate": True})

    logger.debug(
        "Received event_id=%s type=%s - queuing background processing",
        event_id,
        event_type,
    )
    background_tasks.add_task(_process_event_background, payload)
    return JSONResponse(content={"ok": True})


async def _process_event_background(payload: dict) -> None:
    event_id = payload.get("event_id", "unknown")
    try:
        result = await slack_events.handle_webhook_payload(payload)
        if result:
            logger.debug(
                "Processed event_id=%s handled=%s synced=%s",
                event_id,
                getattr(result, "handled", "?"),
                getattr(result, "synced", "?"),
            )
    except Exception as exc:
        logger.exception("Background event processing failed for event_id=%s: %s", event_id, exc)


@router.get("/health", summary="Events webhook health check")
async def events_health():
    return {"ok": True, "service": "slack-events-webhook"}
