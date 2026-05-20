"""
tests/test_messages.py

Unit tests for app/services/slack_messages.py and app/api/messages.py.

Run:
    pytest tests/test_messages.py -v
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from slack_sdk.errors import SlackApiError

from app.models.slack_models import (
    FetchMessagesResponse,
    SendMessageRequest,
    SendMessageResponse,
    SlackChannel,
    SlackMessage,
    SlackToken,
)
from app.services import slack_messages


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_token() -> SlackToken:
    return SlackToken(
        team_id="T012AB3C4",
        team_name="Acme Corp",
        bot_user_id="UBOT",
        access_token="xoxb-fake",
        scope="channels:history,chat:write",
    )


@pytest.fixture
def raw_messages() -> list[dict]:
    """A realistic conversations.history messages array."""
    return [
        {
            "type": "message",
            "user": "U111",
            "text": "Hello world",
            "ts": "1700000001.000100",
        },
        {
            "type": "message",
            "user": "U222",
            "text": "Hey there",
            "ts": "1700000002.000200",
            "thread_ts": "1700000001.000100",
        },
        {
            "type": "message",
            "subtype": "bot_message",
            "bot_id": "B001",
            "text": "Automated update",
            "ts": "1700000003.000300",
        },
    ]


@pytest.fixture
def mock_history_response(raw_messages) -> dict:
    return {
        "ok": True,
        "messages": raw_messages,
        "has_more": False,
        "response_metadata": {"next_cursor": ""},
    }


# ---------------------------------------------------------------------------
# fetch_channel_messages
# ---------------------------------------------------------------------------

class TestFetchChannelMessages:
    @pytest.mark.asyncio
    async def test_returns_normalised_messages(self, fake_token, mock_history_response):
        mock_client = AsyncMock()
        mock_client.conversations_history.return_value = mock_history_response
        mock_client.conversations_info.return_value = {
            "channel": {"id": "C001", "name": "general"}
        }

        with (
            patch("app.services.slack_messages.get_token_or_raise",
                  new_callable=AsyncMock, return_value=fake_token),
            patch("app.services.slack_messages.AsyncWebClient", return_value=mock_client),
            patch("app.services.slack_messages.supabase_service.bulk_upsert_messages",
                  new_callable=AsyncMock, return_value=3),
        ):
            result = await slack_messages.fetch_channel_messages(
                team_id="T012AB3C4",
                channel_id="C001",
                limit=50,
            )

        assert result.ok is True
        assert len(result.messages) == 3
        assert result.has_more is False
        assert result.next_cursor is None

    @pytest.mark.asyncio
    async def test_messages_have_correct_fields(self, fake_token, mock_history_response):
        mock_client = AsyncMock()
        mock_client.conversations_history.return_value = mock_history_response
        mock_client.conversations_info.return_value = {"channel": {"name": "general"}}

        with (
            patch("app.services.slack_messages.get_token_or_raise",
                  new_callable=AsyncMock, return_value=fake_token),
            patch("app.services.slack_messages.AsyncWebClient", return_value=mock_client),
            patch("app.services.slack_messages.supabase_service.bulk_upsert_messages",
                  new_callable=AsyncMock, return_value=3),
        ):
            result = await slack_messages.fetch_channel_messages(
                "T012AB3C4", "C001", sync_to_db=True
            )

        first = result.messages[0]
        assert first.ts == "1700000001.000100"
        assert first.text == "Hello world"
        assert first.user_id == "U111"

        # Thread reply should have thread_ts set
        second = result.messages[1]
        assert second.thread_ts == "1700000001.000100"

    @pytest.mark.asyncio
    async def test_pagination_cursor_forwarded(self, fake_token):
        mock_client = AsyncMock()
        mock_client.conversations_history.return_value = {
            "ok": True,
            "messages": [{"type": "message", "user": "U1", "text": "hi", "ts": "1.0"}],
            "has_more": True,
            "response_metadata": {"next_cursor": "abc123cursor"},
        }
        mock_client.conversations_info.return_value = {"channel": {"name": "general"}}

        with (
            patch("app.services.slack_messages.get_token_or_raise",
                  new_callable=AsyncMock, return_value=fake_token),
            patch("app.services.slack_messages.AsyncWebClient", return_value=mock_client),
            patch("app.services.slack_messages.supabase_service.bulk_upsert_messages",
                  new_callable=AsyncMock, return_value=1),
        ):
            result = await slack_messages.fetch_channel_messages(
                "T012AB3C4", "C001", cursor="prevCursor"
            )

        assert result.has_more is True
        assert result.next_cursor == "abc123cursor"
        # Verify cursor was passed to Slack
        call_kwargs = mock_client.conversations_history.call_args.kwargs
        assert call_kwargs["cursor"] == "prevCursor"

    @pytest.mark.asyncio
    async def test_sync_false_skips_supabase(self, fake_token, mock_history_response):
        mock_client = AsyncMock()
        mock_client.conversations_history.return_value = mock_history_response
        mock_client.conversations_info.return_value = {"channel": {"name": "general"}}

        with (
            patch("app.services.slack_messages.get_token_or_raise",
                  new_callable=AsyncMock, return_value=fake_token),
            patch("app.services.slack_messages.AsyncWebClient", return_value=mock_client),
            patch("app.services.slack_messages.supabase_service.bulk_upsert_messages",
                  new_callable=AsyncMock) as mock_upsert,
        ):
            await slack_messages.fetch_channel_messages(
                "T012AB3C4", "C001", sync_to_db=False
            )

        mock_upsert.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_workspace_not_installed_raises_valueerror(self):
        with patch(
            "app.services.slack_messages.get_token_or_raise",
            new_callable=AsyncMock,
            side_effect=ValueError("not installed"),
        ):
            with pytest.raises(ValueError, match="not installed"):
                await slack_messages.fetch_channel_messages("T_GHOST", "C001")


# ---------------------------------------------------------------------------
# send_message
# ---------------------------------------------------------------------------

class TestSendMessage:
    @pytest.mark.asyncio
    async def test_successful_send(self, fake_token):
        mock_client = AsyncMock()
        mock_client.chat_postMessage.return_value = {
            "ok": True,
            "channel": "C001",
            "ts": "1700000099.000999",
            "message": {"text": "Hello channel!"},
        }

        with (
            patch("app.services.slack_messages.get_token_or_raise",
                  new_callable=AsyncMock, return_value=fake_token),
            patch("app.services.slack_messages.AsyncWebClient", return_value=mock_client),
        ):
            result = await slack_messages.send_message(
                SendMessageRequest(
                    team_id="T012AB3C4",
                    channel="C001",
                    text="Hello channel!",
                )
            )

        assert result.ok is True
        assert result.channel == "C001"
        assert result.ts == "1700000099.000999"

    @pytest.mark.asyncio
    async def test_send_with_thread_ts(self, fake_token):
        mock_client = AsyncMock()
        mock_client.chat_postMessage.return_value = {
            "ok": True, "channel": "C001", "ts": "1700000100.000001",
        }

        with (
            patch("app.services.slack_messages.get_token_or_raise",
                  new_callable=AsyncMock, return_value=fake_token),
            patch("app.services.slack_messages.AsyncWebClient", return_value=mock_client),
        ):
            await slack_messages.send_message(
                SendMessageRequest(
                    team_id="T012AB3C4",
                    channel="C001",
                    text="A reply",
                    thread_ts="1700000001.000100",
                )
            )

        call_kwargs = mock_client.chat_postMessage.call_args.kwargs
        assert call_kwargs["thread_ts"] == "1700000001.000100"

    @pytest.mark.asyncio
    async def test_send_with_blocks(self, fake_token):
        mock_client = AsyncMock()
        mock_client.chat_postMessage.return_value = {
            "ok": True, "channel": "C001", "ts": "1.0",
        }
        blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": "*bold*"}}]

        with (
            patch("app.services.slack_messages.get_token_or_raise",
                  new_callable=AsyncMock, return_value=fake_token),
            patch("app.services.slack_messages.AsyncWebClient", return_value=mock_client),
        ):
            await slack_messages.send_message(
                SendMessageRequest(
                    team_id="T012AB3C4",
                    channel="C001",
                    text="fallback",
                    blocks=blocks,
                )
            )

        call_kwargs = mock_client.chat_postMessage.call_args.kwargs
        assert call_kwargs["blocks"] == blocks

    @pytest.mark.asyncio
    async def test_slack_not_ok_raises(self, fake_token):
        mock_client = AsyncMock()
        mock_client.chat_postMessage.return_value = {
            "ok": False, "error": "not_in_channel",
        }

        with (
            patch("app.services.slack_messages.get_token_or_raise",
                  new_callable=AsyncMock, return_value=fake_token),
            patch("app.services.slack_messages.AsyncWebClient", return_value=mock_client),
        ):
            with pytest.raises(SlackApiError):
                await slack_messages.send_message(
                    SendMessageRequest(
                        team_id="T012AB3C4", channel="C001", text="hi"
                    )
                )


# ---------------------------------------------------------------------------
# list_channels
# ---------------------------------------------------------------------------

class TestListChannels:
    @pytest.mark.asyncio
    async def test_returns_channels(self, fake_token):
        mock_client = AsyncMock()
        mock_client.conversations_list.return_value = {
            "ok": True,
            "channels": [
                {"id": "C001", "name": "general", "is_private": False,
                 "is_member": True, "num_members": 42},
                {"id": "C002", "name": "random", "is_private": False,
                 "is_member": False, "num_members": 10},
            ],
            "response_metadata": {"next_cursor": ""},
        }

        with (
            patch("app.services.slack_messages.get_token_or_raise",
                  new_callable=AsyncMock, return_value=fake_token),
            patch("app.services.slack_messages.AsyncWebClient", return_value=mock_client),
        ):
            channels = await slack_messages.list_channels("T012AB3C4")

        assert len(channels) == 2
        assert channels[0].id == "C001"
        assert channels[0].name == "general"
        assert channels[0].is_member is True

    @pytest.mark.asyncio
    async def test_autopaginates(self, fake_token):
        """Should keep calling until next_cursor is empty."""
        page1 = {
            "ok": True,
            "channels": [{"id": "C001", "name": "a", "is_private": False, "is_member": True}],
            "response_metadata": {"next_cursor": "cursor_page2"},
        }
        page2 = {
            "ok": True,
            "channels": [{"id": "C002", "name": "b", "is_private": False, "is_member": True}],
            "response_metadata": {"next_cursor": ""},
        }
        mock_client = AsyncMock()
        mock_client.conversations_list.side_effect = [page1, page2]

        with (
            patch("app.services.slack_messages.get_token_or_raise",
                  new_callable=AsyncMock, return_value=fake_token),
            patch("app.services.slack_messages.AsyncWebClient", return_value=mock_client),
        ):
            channels = await slack_messages.list_channels("T012AB3C4", limit=100)

        assert len(channels) == 2
        assert mock_client.conversations_list.await_count == 2