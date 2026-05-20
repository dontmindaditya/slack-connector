"""
app/models/slack_models.py

Pydantic models representing Slack domain objects:
- SlackToken       : stored OAuth credentials per workspace
- SlackMessage     : a single Slack message (for DB sync + API responses)
- SlackChannel     : a Slack channel object
- SendMessageRequest / Response : payload shapes for the send-message endpoint
- FetchMessagesRequest           : query params for fetching channel history
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Token / workspace
# ---------------------------------------------------------------------------

class SlackToken(BaseModel):
    """
    Represents one installed Slack workspace's OAuth credentials.
    Stored in the `slack_tokens` Supabase table.
    """
    id: Optional[str] = None                        # Supabase row UUID (set on read)
    team_id: str                                    # Slack workspace ID  e.g. "T012AB3C4"
    team_name: str                                  # Human-readable workspace name
    bot_user_id: str                                # Bot's own user ID in this workspace
    access_token: str                               # xoxb-... bearer token
    scope: str                                      # Comma-separated OAuth scopes granted
    installed_by: Optional[str] = None              # Slack user ID who installed the app
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class SlackTokenCreate(BaseModel):
    """Payload used when persisting a freshly-exchanged OAuth token."""
    team_id: str
    team_name: str
    bot_user_id: str
    access_token: str
    scope: str
    installed_by: Optional[str] = None


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------

class SlackMessage(BaseModel):
    """
    Represents a single Slack message.
    Used both as the DB row model and the API response shape.
    """
    id: Optional[str] = None                        # Supabase row UUID
    team_id: str                                    # Workspace this message belongs to
    channel_id: str                                 # Channel ID  e.g. "C012AB3C4"
    channel_name: Optional[str] = None              # Human-readable channel name (if known)
    user_id: Optional[str] = None                   # Author's Slack user ID
    username: Optional[str] = None                  # Author's display name (denormalised)
    text: str                                       # Message body (may contain mrkdwn)
    ts: str                                         # Slack timestamp — unique message ID
    thread_ts: Optional[str] = None                 # Parent thread timestamp (if threaded)
    message_type: str = "message"                   # "message" | "bot_message" | etc.
    synced_at: Optional[datetime] = None            # When we wrote this row to Supabase
    raw_payload: Optional[dict] = None              # Full Slack payload (for debugging)

    model_config = ConfigDict(from_attributes=True)


class SlackMessageCreate(BaseModel):
    """Minimal payload to insert a new message row into Supabase."""
    team_id: str
    channel_id: str
    channel_name: Optional[str] = None
    user_id: Optional[str] = None
    username: Optional[str] = None
    text: str
    ts: str
    thread_ts: Optional[str] = None
    message_type: str = "message"
    raw_payload: Optional[dict] = None


# ---------------------------------------------------------------------------
# Channels
# ---------------------------------------------------------------------------

class SlackChannel(BaseModel):
    """Lightweight representation of a Slack channel."""
    id: str                                         # Channel ID  e.g. "C012AB3C4"
    name: str                                       # Channel name without #
    is_private: bool = False
    is_member: bool = False                         # Whether the bot is a member
    num_members: Optional[int] = None
    topic: Optional[str] = None
    purpose: Optional[str] = None


# ---------------------------------------------------------------------------
# API request / response shapes
# ---------------------------------------------------------------------------

class SendMessageRequest(BaseModel):
    """
    Body for POST /api/messages/send

    Either `team_id` must match a token stored in Supabase, or the caller
    may supply a raw `token` directly (useful for testing).
    """
    team_id: str = Field(..., description="Slack workspace ID")
    channel: str = Field(
        ...,
        description="Channel ID (C...) or name (#general)",
        examples=["C012AB3C4", "#general"],
    )
    text: str = Field(..., description="Message text (mrkdwn supported)")
    thread_ts: Optional[str] = Field(
        None,
        description="Reply into this thread (parent message ts)",
    )
    blocks: Optional[list] = Field(
        None,
        description="Block Kit blocks array (overrides plain text rendering)",
    )


class SendMessageResponse(BaseModel):
    """Response returned after successfully posting a message."""
    ok: bool
    channel: str
    ts: str                                         # Message timestamp (Slack's unique ID)
    message: Optional[dict] = None                  # Full message object from Slack


class FetchMessagesRequest(BaseModel):
    """Query parameters for GET /api/messages/{team_id}/{channel_id}"""
    limit: int = Field(default=50, ge=1, le=200, description="Max messages to return")
    oldest: Optional[str] = Field(None, description="Fetch messages after this ts")
    latest: Optional[str] = Field(None, description="Fetch messages before this ts")
    cursor: Optional[str] = Field(None, description="Pagination cursor from previous call")


class FetchMessagesResponse(BaseModel):
    """Paginated list of Slack messages."""
    ok: bool
    messages: list[SlackMessage]
    has_more: bool = False
    next_cursor: Optional[str] = None              # Pass as `cursor` in next request
