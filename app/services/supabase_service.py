"""
app/services/supabase_service.py

Lightweight Supabase REST client for the Slack MCP connector.
This avoids the heavier Supabase Python SDK dependency chain and keeps
the connector easier to run in constrained environments.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.config.settings import get_settings
from app.models.slack_models import (
    SlackMessage,
    SlackMessageCreate,
    SlackToken,
    SlackTokenCreate,
)

logger = logging.getLogger(__name__)
settings = get_settings()

_supabase_client: Optional[httpx.AsyncClient] = None


def _base_headers() -> dict[str, str]:
    service_key = settings.supabase_service_role_key
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


async def get_supabase() -> httpx.AsyncClient:
    global _supabase_client
    if _supabase_client is None:
        _supabase_client = httpx.AsyncClient(
            base_url=f"{settings.supabase_url}/rest/v1",
            headers=_base_headers(),
            timeout=30.0,
        )
        logger.info("Supabase REST client initialised")
    return _supabase_client


async def ping_supabase() -> bool:
    client = await get_supabase()
    response = await client.get("/slack_tokens", params={"select": "id", "limit": 1})
    response.raise_for_status()
    return True


async def _request_json(
    method: str,
    path: str,
    *,
    params: Optional[dict[str, Any]] = None,
    json: Any = None,
    headers: Optional[dict[str, str]] = None,
) -> Any:
    client = await get_supabase()
    response = await client.request(
        method,
        path,
        params=params,
        json=json,
        headers=headers,
    )
    response.raise_for_status()
    if not response.content:
        return None
    return response.json()


async def upsert_token(token_data: SlackTokenCreate) -> SlackToken:
    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "team_id": token_data.team_id,
        "team_name": token_data.team_name,
        "bot_user_id": token_data.bot_user_id,
        "access_token": token_data.access_token,
        "scope": token_data.scope,
        "installed_by": token_data.installed_by,
        "updated_at": now,
    }
    data = await _request_json(
        "POST",
        "/slack_tokens",
        params={"on_conflict": "team_id"},
        json=payload,
        headers={"Prefer": "resolution=merge-duplicates,return=representation"},
    )
    if not data:
        raise RuntimeError(f"Failed to upsert token for team {token_data.team_id}")
    logger.info("Upserted token for workspace %s (%s)", token_data.team_id, token_data.team_name)
    return SlackToken(**data[0])


async def get_token(team_id: str) -> Optional[SlackToken]:
    data = await _request_json(
        "GET",
        "/slack_tokens",
        params={
            "select": "*",
            "team_id": f"eq.{team_id}",
            "limit": 1,
        },
    )
    if not data:
        logger.warning("No token found for workspace %s", team_id)
        return None
    return SlackToken(**data[0])


async def get_token_or_raise(team_id: str) -> SlackToken:
    token = await get_token(team_id)
    if token is None:
        raise ValueError(
            f"Workspace {team_id!r} has not installed this app. "
            "Complete the OAuth flow first."
        )
    return token


async def delete_token(team_id: str) -> bool:
    data = await _request_json(
        "DELETE",
        "/slack_tokens",
        params={"team_id": f"eq.{team_id}"},
        headers={"Prefer": "return=representation"},
    )
    deleted = bool(data)
    if deleted:
        logger.info("Deleted token for workspace %s", team_id)
    return deleted


async def list_tokens() -> list[SlackToken]:
    data = await _request_json("GET", "/slack_tokens", params={"select": "*"})
    return [SlackToken(**row) for row in (data or [])]


def _message_payload(message: SlackMessageCreate, *, synced_at: str) -> dict[str, Any]:
    return {
        "team_id": message.team_id,
        "channel_id": message.channel_id,
        "channel_name": message.channel_name,
        "user_id": message.user_id,
        "username": message.username,
        "text": message.text,
        "ts": message.ts,
        "thread_ts": message.thread_ts,
        "message_type": message.message_type,
        "raw_payload": message.raw_payload,
        "synced_at": synced_at,
    }


async def upsert_message(msg: SlackMessageCreate) -> SlackMessage:
    now = datetime.now(timezone.utc).isoformat()
    data = await _request_json(
        "POST",
        "/slack_messages",
        params={"on_conflict": "team_id,channel_id,ts"},
        json=_message_payload(msg, synced_at=now),
        headers={"Prefer": "resolution=merge-duplicates,return=representation"},
    )
    if not data:
        raise RuntimeError(f"Failed to upsert message ts={msg.ts} in channel {msg.channel_id}")
    return SlackMessage(**data[0])


async def bulk_upsert_messages(messages: list[SlackMessageCreate]) -> int:
    if not messages:
        return 0

    now = datetime.now(timezone.utc).isoformat()
    total = 0
    batch_size = settings.supabase_batch_size

    for start in range(0, len(messages), batch_size):
        chunk = messages[start : start + batch_size]
        payload = [_message_payload(message, synced_at=now) for message in chunk]
        data = await _request_json(
            "POST",
            "/slack_messages",
            params={"on_conflict": "team_id,channel_id,ts"},
            json=payload,
            headers={"Prefer": "resolution=merge-duplicates,return=representation"},
        )
        total += len(data or [])

    logger.info("Bulk-upserted %d messages for team %s", total, messages[0].team_id)
    return total


async def get_messages(
    team_id: str,
    channel_id: str,
    limit: int = 50,
    before_ts: Optional[str] = None,
) -> list[SlackMessage]:
    params: dict[str, Any] = {
        "select": "*",
        "team_id": f"eq.{team_id}",
        "channel_id": f"eq.{channel_id}",
        "order": "ts.desc",
        "limit": limit,
    }
    if before_ts:
        params["ts"] = f"lt.{before_ts}"

    data = await _request_json("GET", "/slack_messages", params=params)
    return [SlackMessage(**row) for row in (data or [])]


async def message_exists(team_id: str, channel_id: str, ts: str) -> bool:
    data = await _request_json(
        "GET",
        "/slack_messages",
        params={
            "select": "id",
            "team_id": f"eq.{team_id}",
            "channel_id": f"eq.{channel_id}",
            "ts": f"eq.{ts}",
            "limit": 1,
        },
    )
    return bool(data)
