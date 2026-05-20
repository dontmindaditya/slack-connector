"""
app/services/slack_auth.py

Handles the Slack OAuth 2.0 installation flow:

  1. /api/oauth/install   → redirect user to Slack's authorisation URL
  2. /api/oauth/callback  → exchange the `code` param for an access token,
                            then persist it via supabase_service

References:
  https://docs.slack.dev/authentication/installing-with-oauth
  https://docs.slack.dev/reference/methods/oauth.v2.access
"""

import logging
from urllib.parse import urlencode

from slack_sdk.oauth import AuthorizeUrlGenerator
from slack_sdk.oauth.installation_store.models.installation import Installation
from slack_sdk.web.async_client import AsyncWebClient

from app.config.settings import get_settings
from app.models.slack_models import SlackToken, SlackTokenCreate
from app.services import supabase_service

logger = logging.getLogger(__name__)
settings = get_settings()

# Scopes our bot needs — adjust as your feature set grows
BOT_SCOPES = [
    "channels:history",    # Read public channel messages
    "channels:read",       # List channels
    "chat:write",          # Post messages
    "groups:history",      # Read private channel messages (if invited)
    "groups:read",         # List private channels
    "im:history",          # Read DMs
    "im:read",             # List DMs
    "mpim:history",        # Read group DMs
    "mpim:read",           # List group DMs
    "reactions:read",      # Read emoji reactions
    "users:read",          # Lookup user profiles
]


# ---------------------------------------------------------------------------
# Build the install URL
# ---------------------------------------------------------------------------

def build_install_url(state: str) -> str:
    """
    Constructs the Slack OAuth authorisation URL.

    The `state` parameter is a random, opaque string you generate and later
    verify in the callback to prevent CSRF.  Store it in a short-lived
    server-side session (Redis, signed cookie, etc.) keyed to the browser.
    """
    generator = AuthorizeUrlGenerator(
        client_id=settings.slack_client_id,
        scopes=BOT_SCOPES,
        redirect_uri=settings.slack_redirect_uri,
    )
    url = generator.generate(state=state)
    logger.debug("Generated install URL (state=%s)", state)
    return url


# ---------------------------------------------------------------------------
# Exchange code → token
# ---------------------------------------------------------------------------

async def exchange_code_for_token(code: str) -> SlackToken:
    """
    Calls oauth.v2.access with the one-time `code` received in the callback.
    Persists the resulting token to Supabase and returns a SlackToken.

    Raises:
        slack_sdk.errors.SlackApiError  — if Slack rejects the exchange
        RuntimeError                    — if the response is missing expected fields
    """
    client = AsyncWebClient()  # No token needed for this call

    logger.info("Exchanging OAuth code for token")
    response = await client.oauth_v2_access(
        client_id=settings.slack_client_id,
        client_secret=settings.slack_client_secret,
        code=code,
        redirect_uri=settings.slack_redirect_uri,
    )

    if not response.get("ok"):
        raise RuntimeError(f"oauth.v2.access failed: {response.get('error')}")

    # The bot token lives under response["access_token"] for v2
    # (authed_user contains the installer's user token if you requested user scopes)
    team = response.get("team", {})
    bot_user_id = response.get("bot_user_id", "")
    access_token = response.get("access_token", "")
    scope = response.get("scope", "")
    installed_by = response.get("authed_user", {}).get("id")

    if not access_token:
        raise RuntimeError("No access_token in oauth.v2.access response")

    token_data = SlackTokenCreate(
        team_id=team.get("id", ""),
        team_name=team.get("name", ""),
        bot_user_id=bot_user_id,
        access_token=access_token,
        scope=scope,
        installed_by=installed_by,
    )

    token = await supabase_service.upsert_token(token_data)
    logger.info(
        "OAuth complete — workspace %s (%s) installed by %s",
        token.team_id,
        token.team_name,
        token.installed_by,
    )
    return token


# ---------------------------------------------------------------------------
# Token retrieval helpers (thin wrappers so routes don't import supabase directly)
# ---------------------------------------------------------------------------

async def get_token(team_id: str) -> SlackToken | None:
    """Retrieve stored token for a workspace."""
    return await supabase_service.get_token(team_id)


async def get_token_or_raise(team_id: str) -> SlackToken:
    """Retrieve stored token or raise ValueError if workspace not installed."""
    return await supabase_service.get_token_or_raise(team_id)


async def revoke_token(team_id: str) -> bool:
    """
    Revoke a workspace installation:
      1. Call auth.revoke on Slack to invalidate the token server-side.
      2. Delete the row from Supabase.

    Returns True if the workspace was found and removed.
    """
    token = await supabase_service.get_token(team_id)
    if token is None:
        logger.warning("revoke_token: no token for workspace %s", team_id)
        return False

    # Best-effort revoke on Slack's side (ignore errors — token may already be invalid)
    try:
        client = AsyncWebClient(token=token.access_token)
        await client.auth_revoke()
        logger.info("Revoked Slack token for workspace %s", team_id)
    except Exception as exc:
        logger.warning("auth.revoke call failed for %s: %s", team_id, exc)

    return await supabase_service.delete_token(team_id)


async def list_installed_workspaces() -> list[SlackToken]:
    """Return all installed workspaces (sanitised — no raw access_token)."""
    tokens = await supabase_service.list_tokens()
    # Mask the token for safety when returning to callers
    for t in tokens:
        t.access_token = "***redacted***"
    return tokens