"""
app/services/slack_messages.py

Business logic for reading and sending Slack messages.

Fetch flow:
  Slack API (conversations.history) → normalise → optionally sync to Supabase

Send flow:
  Validate request → load token → call chat.postMessage → return result

Rate limit + retry handling is delegated to app/utils/retry.py.
"""

import logging
import time
from typing import Optional

from slack_sdk.errors import SlackApiError
from slack_sdk.web.async_client import AsyncWebClient

from app.models.slack_models import (
    FetchMessagesResponse,
    SendMessageRequest,
    SendMessageResponse,
    SlackChannel,
    SlackMessage,
    SlackMessageCreate,
)
from app.services import supabase_service
from app.services.slack_auth import get_token_or_raise
from app.config.settings import get_settings
from app.utils.retry import with_slack_retry

logger = logging.getLogger(__name__)
settings = get_settings()
_channel_name_cache: dict[tuple[str, str], tuple[float, Optional[str]]] = {}
_user_name_cache: dict[tuple[str, str], tuple[float, Optional[str]]] = {}


# ---------------------------------------------------------------------------
# Internal helper — build an AsyncWebClient for a workspace
# ---------------------------------------------------------------------------

async def _client_for(team_id: str) -> AsyncWebClient:
    """Load the stored token for `team_id` and return a ready-to-use SDK client."""
    token = await get_token_or_raise(team_id)
    return AsyncWebClient(token=token.access_token)


async def _get_user_name(
    client: AsyncWebClient,
    *,
    team_id: str,
    user_id: str,
) -> Optional[str]:
    cache_key = (team_id, user_id)
    cached = _user_name_cache.get(cache_key)
    now = time.time()
    if cached and now - cached[0] <= settings.channel_cache_ttl_seconds:
        return cached[1]

    try:
        resp = await with_slack_retry(client.users_info, user=user_id)
        user = resp.get("user", {})
        profile = user.get("profile", {})
        name = profile.get("display_name") or profile.get("real_name") or user.get("name")
        _user_name_cache[cache_key] = (now, name)
        return name
    except Exception:
        return cached[1] if cached else None


async def _get_channel_name(
    client: AsyncWebClient,
    *,
    team_id: str,
    channel_id: str,
) -> Optional[str]:
    cache_key = (team_id, channel_id)
    cached = _channel_name_cache.get(cache_key)
    now = time.time()
    if cached and now - cached[0] <= settings.channel_cache_ttl_seconds:
        return cached[1]

    try:
        info_resp = await with_slack_retry(client.conversations_info, channel=channel_id)
        channel_name = info_resp.get("channel", {}).get("name")
        _channel_name_cache[cache_key] = (now, channel_name)
        return channel_name
    except Exception:
        return cached[1] if cached else None


# ---------------------------------------------------------------------------
# Normalise raw Slack message dict → SlackMessageCreate
# ---------------------------------------------------------------------------

async def _normalise_message(
    raw: dict,
    team_id: str,
    channel_id: str,
    client: AsyncWebClient,
    channel_name: Optional[str] = None,
) -> SlackMessageCreate:
    """
    Convert a raw message dict from the Slack API into our internal model.
    Resolves user_id → display name via users.info (cached).
    """
    user_id = raw.get("user") or raw.get("bot_id")
    username = raw.get("username")  # already set on some bot messages

    if user_id and not username:
        username = await _get_user_name(client, team_id=team_id, user_id=user_id)

    return SlackMessageCreate(
        team_id=team_id,
        channel_id=channel_id,
        channel_name=channel_name,
        user_id=user_id,
        username=username,
        text=raw.get("text", ""),
        ts=raw["ts"],
        thread_ts=raw.get("thread_ts"),
        message_type=raw.get("subtype", "message"),
        raw_payload=raw,
    )


# ---------------------------------------------------------------------------
# Fetch channel messages
# ---------------------------------------------------------------------------

async def fetch_channel_messages(
    team_id: str,
    channel_id: str,
    limit: int = 50,
    oldest: Optional[str] = None,
    latest: Optional[str] = None,
    cursor: Optional[str] = None,
    sync_to_db: bool = True,
) -> FetchMessagesResponse:
    """
    Fetch messages from a Slack channel using conversations.history.

    Args:
        team_id     : Slack workspace ID
        channel_id  : Channel to read (C...)
        limit       : Max messages per page (1–200)
        oldest      : Only messages after this ts
        latest      : Only messages before this ts
        cursor      : Pagination cursor from a previous call
        sync_to_db  : Write fetched messages to Supabase after fetching

    Returns:
        FetchMessagesResponse with messages list and pagination info.

    Raises:
        ValueError              : workspace not installed
        SlackApiError           : Slack API call failed (not_in_channel, etc.)
    """
    client = await _client_for(team_id)

    # Build kwargs — only pass non-None values so Slack uses its own defaults
    kwargs: dict = {"channel": channel_id, "limit": limit}
    if oldest:
        kwargs["oldest"] = oldest
    if latest:
        kwargs["latest"] = latest
    if cursor:
        kwargs["cursor"] = cursor

    logger.debug(
        "conversations.history team=%s channel=%s limit=%d", team_id, channel_id, limit
    )

    # with_slack_retry handles 429 rate-limit retries automatically
    try:
        response = await with_slack_retry(client.conversations_history, **kwargs)
    except SlackApiError as exc:
        if exc.response.get("error") == "not_in_channel":
            logger.info("Bot not in channel %s — joining automatically", channel_id)
            await with_slack_retry(client.conversations_join, channel=channel_id)
            response = await with_slack_retry(client.conversations_history, **kwargs)
        else:
            raise

    raw_messages: list[dict] = response.get("messages", [])
    response_meta: dict = response.get("response_metadata", {})
    next_cursor: str = response_meta.get("next_cursor", "")
    has_more: bool = bool(next_cursor)

    channel_name = await _get_channel_name(client, team_id=team_id, channel_id=channel_id)

    deduped_by_ts: dict[str, dict] = {}
    for message in raw_messages:
        ts = message.get("ts")
        if ts:
            deduped_by_ts[ts] = message

    # Normalise into our models (resolves usernames)
    normalised = [
        await _normalise_message(m, team_id, channel_id, client, channel_name)
        for m in deduped_by_ts.values()
        if "ts" in m  # skip malformed entries
    ]

    # Sync to Supabase in bulk
    if sync_to_db and normalised:
        try:
            synced = await supabase_service.bulk_upsert_messages(normalised)
            logger.info("Synced %d/%d messages to Supabase", synced, len(normalised))
        except Exception as exc:
            # Log but don't fail the API response — syncing is best-effort here
            logger.error("Supabase bulk upsert failed: %s", exc)

    messages = [
        SlackMessage(
            team_id=m.team_id,
            channel_id=m.channel_id,
            channel_name=m.channel_name,
            user_id=m.user_id,
            username=m.username,
            text=m.text,
            ts=m.ts,
            thread_ts=m.thread_ts,
            message_type=m.message_type,
        )
        for m in normalised
    ]

    return FetchMessagesResponse(
        ok=True,
        messages=messages,
        has_more=has_more,
        next_cursor=next_cursor or None,
    )


# ---------------------------------------------------------------------------
# Fetch ALL messages (auto-paginate)
# ---------------------------------------------------------------------------

async def fetch_all_channel_messages(
    team_id: str,
    channel_id: str,
    sync_to_db: bool = True,
) -> list[SlackMessage]:
    """
    Fetches every message in a channel by auto-paginating through all pages.
    200 messages per page (Slack's max). Syncs to Supabase if sync_to_db=True.
    """
    all_messages: list[SlackMessage] = []
    cursor: Optional[str] = None

    while True:
        result = await fetch_channel_messages(
            team_id=team_id,
            channel_id=channel_id,
            limit=200,
            cursor=cursor,
            sync_to_db=sync_to_db,
        )
        all_messages.extend(result.messages)
        if not result.has_more or not result.next_cursor:
            break
        cursor = result.next_cursor

    logger.info("Fetched %d total messages from %s/%s", len(all_messages), team_id, channel_id)
    return all_messages


# ---------------------------------------------------------------------------
# Send a message
# ---------------------------------------------------------------------------

async def send_message(request: SendMessageRequest) -> SendMessageResponse:
    """
    Post a message to a Slack channel via chat.postMessage.

    Args:
        request: SendMessageRequest — team_id, channel, text, optional blocks/thread_ts

    Returns:
        SendMessageResponse with the new message's ts.

    Raises:
        ValueError       : workspace not installed
        SlackApiError    : Slack rejected the message (channel_not_found, not_in_channel…)
    """
    client = await _client_for(request.team_id)

    kwargs: dict = {
        "channel": request.channel,
        "text": request.text,
    }
    if request.thread_ts:
        kwargs["thread_ts"] = request.thread_ts
    if request.blocks:
        kwargs["blocks"] = request.blocks

    logger.info(
        "Sending message to %s / %s (thread=%s)",
        request.team_id,
        request.channel,
        request.thread_ts,
    )

    response = await with_slack_retry(client.chat_postMessage, **kwargs)

    if not response.get("ok"):
        raise SlackApiError(
            message=f"chat.postMessage failed: {response.get('error')}",
            response=response,
        )

    return SendMessageResponse(
        ok=True,
        channel=response["channel"],
        ts=response["ts"],
        message=response.get("message"),
    )


# ---------------------------------------------------------------------------
# List channels
# ---------------------------------------------------------------------------

async def list_channels(
    team_id: str,
    exclude_archived: bool = True,
    limit: int = 200,
) -> list[SlackChannel]:
    """
    Return public channels the bot can see via conversations.list.
    Auto-paginates until all channels are retrieved.
    """
    client = await _client_for(team_id)
    channels: list[SlackChannel] = []
    cursor: Optional[str] = None

    while True:
        kwargs: dict = {
            "exclude_archived": exclude_archived,
            "limit": min(limit, 200),   # Slack max is 200 per page
            "types": "public_channel,private_channel",
        }
        if cursor:
            kwargs["cursor"] = cursor

        response = await with_slack_retry(client.conversations_list, **kwargs)

        for ch in response.get("channels", []):
            channels.append(
                SlackChannel(
                    id=ch["id"],
                    name=ch.get("name", ""),
                    is_private=ch.get("is_private", False),
                    is_member=ch.get("is_member", False),
                    num_members=ch.get("num_members"),
                    topic=ch.get("topic", {}).get("value"),
                    purpose=ch.get("purpose", {}).get("value"),
                )
            )

        next_cursor = response.get("response_metadata", {}).get("next_cursor", "")
        if not next_cursor or len(channels) >= limit:
            break
        cursor = next_cursor

    logger.debug("Listed %d channels for workspace %s", len(channels), team_id)
    return channels[:limit]


# ---------------------------------------------------------------------------
# Fetch a single message by ts (useful for event handlers)
# ---------------------------------------------------------------------------

async def fetch_message(
    team_id: str,
    channel_id: str,
    ts: str,
) -> Optional[SlackMessage]:
    """
    Retrieve a single message by its timestamp using conversations.history
    with oldest=ts and limit=1.  Returns None if not found.
    """
    try:
        result = await fetch_channel_messages(
            team_id=team_id,
            channel_id=channel_id,
            limit=1,
            oldest=ts,
            sync_to_db=False,
        )
        if result.messages and result.messages[0].ts == ts:
            return result.messages[0]
    except SlackApiError as exc:
        logger.warning("fetch_message failed: %s", exc)
    return None
