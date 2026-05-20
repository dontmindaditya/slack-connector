"""
app/models/event_models.py

Pydantic models for Slack Events API webhook payloads.

Slack sends a JSON POST to our /api/events/webhook endpoint whenever a
subscribed event fires.  The outer "envelope" is always EventCallback;
the inner `event` field varies by type.

References:
  https://docs.slack.dev/apis/events-api/
  https://docs.slack.dev/reference/events
"""

from typing import Any, Literal, Optional, Union
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# URL verification challenge (sent once when you first save the Events URL)
# ---------------------------------------------------------------------------

class UrlVerificationPayload(BaseModel):
    """
    Slack sends this exactly once to verify ownership of the endpoint.
    We must echo back the `challenge` value within 3 seconds.
    """
    type: Literal["url_verification"]
    token: Optional[str] = None           # Deprecated – ignore
    challenge: str


# ---------------------------------------------------------------------------
# Inner event types
# ---------------------------------------------------------------------------

class MessageEvent(BaseModel):
    """
    Inner event for `message.*` subscriptions.
    Covers messages in channels, DMs, and group DMs.
    """
    type: str                             # "message"
    subtype: Optional[str] = None        # "bot_message" | "message_changed" | etc.
    channel: str                          # Channel ID the message was posted in
    channel_type: Optional[str] = None   # "channel" | "im" | "mpim" | "group"
    user: Optional[str] = None           # Author's user ID (absent for bot messages)
    bot_id: Optional[str] = None         # Set when subtype == "bot_message"
    text: Optional[str] = None           # Message body
    ts: str                               # Slack timestamp / message ID
    thread_ts: Optional[str] = None      # Parent thread ts (if reply)
    event_ts: Optional[str] = None       # When this event was dispatched


class AppMentionEvent(BaseModel):
    """
    Inner event for `app_mention` — fired when the bot is @-mentioned.
    """
    type: Literal["app_mention"]
    user: str                             # User who mentioned the bot
    text: str                             # Full message text including the mention
    ts: str
    channel: str
    event_ts: Optional[str] = None
    thread_ts: Optional[str] = None


class ReactionAddedEvent(BaseModel):
    """Inner event for `reaction_added`."""
    type: Literal["reaction_added"]
    user: str                             # User who reacted
    reaction: str                         # Emoji name e.g. "thumbsup"
    item_user: Optional[str] = None
    item: dict                            # {"type": "message", "channel": "...", "ts": "..."}
    event_ts: str


class MemberJoinedChannelEvent(BaseModel):
    """Inner event for `member_joined_channel`."""
    type: Literal["member_joined_channel"]
    user: str
    channel: str
    channel_type: Optional[str] = None
    team: Optional[str] = None
    inviter: Optional[str] = None


# Generic fallback for event types we haven't modelled explicitly yet
class GenericEvent(BaseModel):
    type: str
    model_config = {"extra": "allow"}    # Accept unknown fields


# ---------------------------------------------------------------------------
# Outer event envelope
# ---------------------------------------------------------------------------

class Authorization(BaseModel):
    """One entry in the `authorizations` array on the outer envelope."""
    enterprise_id: Optional[str] = None
    team_id: str
    user_id: str
    is_bot: bool = False
    is_enterprise_install: bool = False


class EventCallback(BaseModel):
    """
    The standard outer envelope Slack wraps around every event callback.

    The `event` field holds the inner event object whose shape varies by
    `event.type`.  We keep it as `dict` here and parse it in the service
    layer where we know the type.
    """
    type: Literal["event_callback"]
    token: Optional[str] = None          # Deprecated — use signature verification instead
    team_id: str                          # Workspace where the event occurred
    api_app_id: str                       # Your Slack app ID
    event: dict                           # Raw inner event — parsed in service layer
    event_id: str                         # Globally unique event ID
    event_time: int                       # Unix epoch seconds
    authorizations: Optional[list[Authorization]] = None
    is_ext_shared_channel: bool = False
    context_team_id: Optional[str] = None
    context_enterprise_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Discriminated union — top-level webhook payload
# ---------------------------------------------------------------------------

# We accept either a url_verification or a real event_callback.
SlackWebhookPayload = Union[UrlVerificationPayload, EventCallback]


# ---------------------------------------------------------------------------
# App-rate-limited notification
# ---------------------------------------------------------------------------

class AppRateLimitedEvent(BaseModel):
    """
    Fired by Slack when our app exceeds 30,000 event deliveries per workspace
    per 60-minute window.
    """
    token: Optional[str] = None
    type: Literal["app_rate_limited"]
    team_id: str
    minute_rate_limited: int             # Rounded epoch minute rate-limiting began
    api_app_id: str


# ---------------------------------------------------------------------------
# Internal helper — parsed event wrapper returned by service layer
# ---------------------------------------------------------------------------

class ParsedEvent(BaseModel):
    """
    What the event service hands back to the route handler after processing
    the raw webhook payload.
    """
    event_id: str
    team_id: str
    event_type: str                       # "message", "app_mention", etc.
    handled: bool = True                  # False if we deliberately ignored it
    synced: bool = False                  # True if written to Supabase
    error: Optional[str] = None
    data: Optional[dict] = None           # Normalised event data for the caller