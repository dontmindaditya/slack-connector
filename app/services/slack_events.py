"""
app/services/slack_events.py

Processes incoming Slack Events API webhook payloads.

Responsibilities:
  - Parse the raw JSON envelope into typed models
  - Route to the correct handler based on event.type
  - Sync relevant events (new messages) to Supabase
  - Return a ParsedEvent summary to the route handler

Design notes:
  - We NEVER do heavy work synchronously inside the webhook handler.
    Slack requires an HTTP 200 within 3 seconds.  For anything slow
    (e.g. calling an LLM, doing multi-step processing) offload to a
    background task or a queue.
  - Duplicate events: Slack may re-deliver events on retry.  All writes
    use upsert so duplicates are safe.
"""

import logging
from typing import Any

from app.models.event_models import (
    AppMentionEvent,
    EventCallback,
    MessageEvent,
    ParsedEvent,
    UrlVerificationPayload,
)
from app.models.slack_models import SlackMessageCreate
from app.services import slack_auth, supabase_service
from app.services.slack_messages import send_message
from app.models.slack_models import SendMessageRequest

logger = logging.getLogger(__name__)


def _build_message_create(
    *,
    team_id: str,
    channel_id: str,
    user_id: str | None,
    text: str,
    ts: str,
    thread_ts: str | None,
    message_type: str,
    raw_payload: dict,
) -> SlackMessageCreate:
    return SlackMessageCreate(
        team_id=team_id,
        channel_id=channel_id,
        user_id=user_id,
        text=text,
        ts=ts,
        thread_ts=thread_ts,
        message_type=message_type,
        raw_payload=raw_payload,
    )


# ---------------------------------------------------------------------------
# Top-level dispatcher
# ---------------------------------------------------------------------------

async def handle_webhook_payload(raw: dict) -> Any:
    """
    Entry point called by the /api/events/webhook route.

    Returns:
      - A plain dict {"challenge": ...} for url_verification (Slack handshake)
      - A ParsedEvent for normal event_callback payloads
      - None for unknown / ignored payload types
    """
    payload_type = raw.get("type")

    # ------------------------------------------------------------------
    # 1. URL verification (one-time Slack ownership check)
    # ------------------------------------------------------------------
    if payload_type == "url_verification":
        payload = UrlVerificationPayload(**raw)
        logger.info("Responding to Slack URL verification challenge")
        return {"challenge": payload.challenge}

    # ------------------------------------------------------------------
    # 2. Standard event callback
    # ------------------------------------------------------------------
    if payload_type == "event_callback":
        envelope = EventCallback(**raw)
        return await _dispatch_event(envelope)

    # ------------------------------------------------------------------
    # 3. App rate-limited notification (no action needed, just log it)
    # ------------------------------------------------------------------
    if payload_type == "app_rate_limited":
        logger.warning(
            "app_rate_limited for workspace %s — too many events",
            raw.get("team_id"),
        )
        return None

    logger.debug("Unhandled webhook payload type: %s", payload_type)
    return None


# ---------------------------------------------------------------------------
# Event dispatcher
# ---------------------------------------------------------------------------

async def _dispatch_event(envelope: EventCallback) -> ParsedEvent:
    """Route the inner event to the appropriate handler."""
    inner = envelope.event
    event_type: str = inner.get("type", "unknown")

    logger.debug(
        "Dispatching event type=%s team=%s event_id=%s",
        event_type,
        envelope.team_id,
        envelope.event_id,
    )

    # Map event types to handler coroutines
    handlers = {
        "message": _handle_message_event,
        "app_mention": _handle_app_mention_event,
        "app_uninstalled": _handle_app_uninstalled_event,
        "tokens_revoked": _handle_tokens_revoked_event,
    }

    handler = handlers.get(event_type)
    if handler is None:
        logger.debug("No handler registered for event type %r — skipping", event_type)
        return ParsedEvent(
            event_id=envelope.event_id,
            team_id=envelope.team_id,
            event_type=event_type,
            handled=False,
        )

    return await handler(envelope, inner)


# ---------------------------------------------------------------------------
# Message event handler
# ---------------------------------------------------------------------------

async def _handle_message_event(envelope: EventCallback, inner: dict) -> ParsedEvent:
    """
    Handle `message.*` events.

    We sync the message to Supabase.  Subtypes like `message_changed`,
    `message_deleted`, and `bot_message` are handled separately to avoid
    polluting the message log with noise.
    """
    subtype = inner.get("subtype")

    # Skip edits, deletes, and thread broadcast copies
    ignored_subtypes = {"message_changed", "message_deleted", "message_replied"}
    if subtype in ignored_subtypes:
        logger.debug("Ignoring message subtype %r", subtype)
        return ParsedEvent(
            event_id=envelope.event_id,
            team_id=envelope.team_id,
            event_type="message",
            handled=False,
        )

    try:
        event = MessageEvent(**inner)
    except Exception as exc:
        logger.error("Failed to parse MessageEvent: %s — raw: %s", exc, inner)
        return ParsedEvent(
            event_id=envelope.event_id,
            team_id=envelope.team_id,
            event_type="message",
            handled=False,
            error=str(exc),
        )

    # Skip empty messages (e.g. pure file uploads with no text)
    if not event.text:
        return ParsedEvent(
            event_id=envelope.event_id,
            team_id=envelope.team_id,
            event_type="message",
            handled=False,
        )

    # Persist to Supabase
    msg_create = _build_message_create(
        team_id=envelope.team_id,
        channel_id=event.channel,
        user_id=event.user or event.bot_id,
        text=event.text,
        ts=event.ts,
        thread_ts=event.thread_ts,
        message_type=subtype or "message",
        raw_payload=inner,
    )

    synced = False
    try:
        await supabase_service.upsert_message(msg_create)
        synced = True
        logger.info(
            "Synced message ts=%s channel=%s team=%s",
            event.ts,
            event.channel,
            envelope.team_id,
        )
    except Exception as exc:
        logger.error("Failed to sync message to Supabase: %s", exc)

    return ParsedEvent(
        event_id=envelope.event_id,
        team_id=envelope.team_id,
        event_type="message",
        handled=True,
        synced=synced,
        data={
            "channel": event.channel,
            "user": event.user,
            "ts": event.ts,
            "text": event.text,
        },
    )


# ---------------------------------------------------------------------------
# App mention handler
# ---------------------------------------------------------------------------

async def _handle_app_mention_event(envelope: EventCallback, inner: dict) -> ParsedEvent:
    """
    Handle `app_mention` events — fired when someone @-mentions the bot.

    Currently just logs the mention and syncs it as a regular message.
    Extend this to trigger AI responses, workflows, etc.
    """
    try:
        event = AppMentionEvent(**inner)
    except Exception as exc:
        logger.error("Failed to parse AppMentionEvent: %s", exc)
        return ParsedEvent(
            event_id=envelope.event_id,
            team_id=envelope.team_id,
            event_type="app_mention",
            handled=False,
            error=str(exc),
        )

    logger.info(
        "Bot mentioned by %s in %s: %r",
        event.user,
        event.channel,
        event.text[:80],
    )

    # Sync the mention message to Supabase the same way as a regular message
    msg_create = _build_message_create(
        team_id=envelope.team_id,
        channel_id=event.channel,
        user_id=event.user,
        text=event.text,
        ts=event.ts,
        thread_ts=event.thread_ts,
        message_type="app_mention",
        raw_payload=inner,
    )

    synced = False
    try:
        await supabase_service.upsert_message(msg_create)
        synced = True
    except Exception as exc:
        logger.error("Failed to sync app_mention to Supabase: %s", exc)

    reply_sent = False
    cleaned_text = " ".join(part for part in event.text.split() if not part.startswith("<@"))
    if cleaned_text:
        try:
            await send_message(
                SendMessageRequest(
                    team_id=envelope.team_id,
                    channel=event.channel,
                    text=(
                        "I received your mention and synced it into Collectium. "
                        f"Message preview: {cleaned_text[:180]}"
                    ),
                    thread_ts=event.thread_ts or event.ts,
                )
            )
            reply_sent = True
        except Exception as exc:
            logger.warning("Failed to send app_mention acknowledgement: %s", exc)

    return ParsedEvent(
        event_id=envelope.event_id,
        team_id=envelope.team_id,
        event_type="app_mention",
        handled=True,
        synced=synced,
        data={
            "channel": event.channel,
            "user": event.user,
            "ts": event.ts,
            "text": event.text,
            "reply_sent": reply_sent,
        },
    )


async def _handle_app_uninstalled_event(envelope: EventCallback, inner: dict) -> ParsedEvent:
    removed = False
    try:
        removed = await slack_auth.revoke_token(envelope.team_id)
    except Exception as exc:
        logger.warning("Failed to revoke workspace token after app_uninstalled: %s", exc)
        return ParsedEvent(
            event_id=envelope.event_id,
            team_id=envelope.team_id,
            event_type="app_uninstalled",
            handled=False,
            error=str(exc),
        )

    return ParsedEvent(
        event_id=envelope.event_id,
        team_id=envelope.team_id,
        event_type="app_uninstalled",
        handled=True,
        synced=removed,
        data={"workspace_revoked": removed},
    )


async def _handle_tokens_revoked_event(envelope: EventCallback, inner: dict) -> ParsedEvent:
    return ParsedEvent(
        event_id=envelope.event_id,
        team_id=envelope.team_id,
        event_type="tokens_revoked",
        handled=True,
        synced=False,
        data={"payload": inner},
    )
