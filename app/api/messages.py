"""
app/api/messages.py

FastAPI router for reading and sending Slack messages.

Routes:
  GET  /api/messages/{team_id}/{channel_id}  → fetch channel history
  POST /api/messages/send                    → post a message to a channel
  GET  /api/messages/{team_id}/channels      → list available channels
  GET  /api/messages/synced/{team_id}/{channel_id} → read from Supabase (not Slack)
"""

import logging
from typing import Annotated, Optional

from fastapi import APIRouter, HTTPException, Query
from slack_sdk.errors import SlackApiError

from app.models.slack_models import (
    FetchMessagesResponse,
    SendMessageRequest,
    SendMessageResponse,
)
from app.services import slack_messages, supabase_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/messages", tags=["Messages"])


# ---------------------------------------------------------------------------
# Fetch channel history from Slack
# ---------------------------------------------------------------------------

@router.get(
    "/{team_id}/channels",
    summary="List public channels in a workspace",
)
async def list_channels(
    team_id: str,
    exclude_archived: bool = Query(True, description="Exclude archived channels"),
    limit: int = Query(200, ge=1, le=1000, description="Max channels to return"),
):
    """
    Returns a list of public channels the bot can see in the workspace.
    Auto-paginates internally so you always get the full list (up to `limit`).
    """
    try:
        channels = await slack_messages.list_channels(
            team_id=team_id,
            exclude_archived=exclude_archived,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except SlackApiError as exc:
        raise HTTPException(
            status_code=502, detail=f"Slack API error: {exc.response.get('error')}"
        )
    except Exception as exc:
        logger.exception("Unexpected error in list_channels")
        raise HTTPException(status_code=500, detail=str(exc))

    return {
        "ok": True,
        "team_id": team_id,
        "count": len(channels),
        "channels": [ch.model_dump() for ch in channels],
    }


@router.get(
    "/{team_id}/{channel_id}",
    response_model=FetchMessagesResponse,
    summary="Fetch messages from a Slack channel",
)
async def get_channel_messages(
    team_id: str,
    channel_id: str,
    limit: Annotated[int, Query(ge=1, le=200, description="Messages per page")] = 50,
    oldest: Annotated[Optional[str], Query(description="Fetch after this ts")] = None,
    latest: Annotated[Optional[str], Query(description="Fetch before this ts")] = None,
    cursor: Annotated[Optional[str], Query(description="Pagination cursor")] = None,
    sync: Annotated[bool, Query(description="Sync fetched messages to Supabase")] = True,
):
    """
    Fetches up to `limit` messages from the specified channel using
    `conversations.history`.  Pass `cursor` from the previous response's
    `next_cursor` field to paginate.

    Setting `sync=true` (default) writes all fetched messages to Supabase
    in a single bulk upsert after the Slack call returns.
    """
    try:
        result = await slack_messages.fetch_channel_messages(
            team_id=team_id,
            channel_id=channel_id,
            limit=limit,
            oldest=oldest,
            latest=latest,
            cursor=cursor,
            sync_to_db=sync,
        )
    except ValueError as exc:
        # Workspace not installed
        raise HTTPException(status_code=404, detail=str(exc))
    except SlackApiError as exc:
        error_code = exc.response.get("error", "unknown")
        status = 403 if error_code in ("not_in_channel", "channel_not_found") else 502
        raise HTTPException(status_code=status, detail=f"Slack API error: {error_code}")
    except Exception as exc:
        logger.exception("Unexpected error in get_channel_messages")
        raise HTTPException(status_code=500, detail=str(exc))

    return result


# ---------------------------------------------------------------------------
# Fetch ALL messages (auto-paginate)
# ---------------------------------------------------------------------------

@router.get(
    "/{team_id}/{channel_id}/all",
    summary="Fetch all messages from a channel (auto-paginates)",
)
async def get_all_channel_messages(
    team_id: str,
    channel_id: str,
    sync: bool = Query(True, description="Sync fetched messages to Supabase"),
):
    try:
        messages = await slack_messages.fetch_all_channel_messages(
            team_id=team_id,
            channel_id=channel_id,
            sync_to_db=sync,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except SlackApiError as exc:
        raise HTTPException(status_code=502, detail=f"Slack API error: {exc.response.get('error')}")
    except Exception as exc:
        logger.exception("Unexpected error in get_all_channel_messages")
        raise HTTPException(status_code=500, detail=str(exc))

    return {
        "ok": True,
        "team_id": team_id,
        "channel_id": channel_id,
        "count": len(messages),
        "messages": [m.model_dump() for m in messages],
    }


# ---------------------------------------------------------------------------
# Send a message
# ---------------------------------------------------------------------------

@router.post(
    "/send",
    response_model=SendMessageResponse,
    summary="Send a message to a Slack channel",
)
async def send_message(request: SendMessageRequest):
    """
    Posts a message to the specified Slack channel using `chat.postMessage`.

    Supply `thread_ts` to reply inside an existing thread.
    Supply `blocks` (Block Kit JSON array) for rich formatting — if provided,
    `text` is used as the notification fallback only.
    """
    try:
        result = await slack_messages.send_message(request)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except SlackApiError as exc:
        error_code = exc.response.get("error", "unknown")
        if error_code == "channel_not_found":
            raise HTTPException(status_code=404, detail="Channel not found")
        if error_code == "not_in_channel":
            raise HTTPException(
                status_code=403,
                detail="Bot is not a member of that channel — invite it first",
            )
        if error_code == "msg_too_long":
            raise HTTPException(status_code=400, detail="Message text is too long")
        raise HTTPException(status_code=502, detail=f"Slack API error: {error_code}")
    except Exception as exc:
        logger.exception("Unexpected error in send_message")
        raise HTTPException(status_code=500, detail=str(exc))

    return result


# ---------------------------------------------------------------------------
# Add reaction (like) to a message
# ---------------------------------------------------------------------------

@router.post(
    "/{team_id}/{channel_id}/{message_ts}/react",
    summary="Add an emoji reaction to a message",
)
async def add_reaction(
    team_id: str,
    channel_id: str,
    message_ts: str,
    emoji: str = Query(default="thumbsup", description="Emoji name without colons e.g. thumbsup"),
):
    try:
        client = await slack_messages._client_for(team_id)
        await client.reactions_add(
            channel=channel_id,
            timestamp=message_ts,
            name=emoji,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except SlackApiError as exc:
        error_code = exc.response.get("error", "unknown")
        if error_code == "already_reacted":
            return {"ok": True, "message": "Already reacted"}
        raise HTTPException(status_code=502, detail=f"Slack API error: {error_code}")

    return {"ok": True, "emoji": emoji, "ts": message_ts}


# ---------------------------------------------------------------------------
# Read synced messages from Supabase (no Slack API call)
# ---------------------------------------------------------------------------

@router.get(
    "/synced/{team_id}/{channel_id}",
    summary="Read previously-synced messages from the database",
)
async def get_synced_messages(
    team_id: str,
    channel_id: str,
    limit: int = Query(50, ge=1, le=200),
    before_ts: Optional[str] = Query(None, description="Return messages before this ts"),
):
    """
    Returns messages stored in Supabase without calling the Slack API.
    Use this for display/search when real-time freshness isn't required.
    """
    try:
        messages = await supabase_service.get_messages(
            team_id=team_id,
            channel_id=channel_id,
            limit=limit,
            before_ts=before_ts,
        )
    except Exception as exc:
        logger.exception("Error reading synced messages from Supabase")
        raise HTTPException(status_code=500, detail=str(exc))

    return {
        "ok": True,
        "team_id": team_id,
        "channel_id": channel_id,
        "count": len(messages),
        "messages": [m.model_dump() for m in messages],
    }