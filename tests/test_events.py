"""
tests/test_events.py

Unit tests for:
  - app/services/slack_events.py   (event processing logic)
  - app/api/events.py              (webhook HTTP endpoint)

Run:
    pytest tests/test_events.py -v
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.models.event_models import ParsedEvent
from app.services import slack_events


# ---------------------------------------------------------------------------
# Fixtures — raw webhook payloads
# ---------------------------------------------------------------------------

@pytest.fixture
def url_verification_payload() -> dict:
    return {
        "type": "url_verification",
        "token": "deprecated-token",
        "challenge": "test-challenge-xyz",
    }


@pytest.fixture
def message_event_payload() -> dict:
    return {
        "type": "event_callback",
        "team_id": "T012AB3C4",
        "api_app_id": "A012AB3C4",
        "event_id": "Ev012AB3C4",
        "event_time": 1700000001,
        "event": {
            "type": "message",
            "channel": "C001",
            "user": "U111",
            "text": "Hello from Slack",
            "ts": "1700000001.000100",
            "channel_type": "channel",
        },
    }


@pytest.fixture
def bot_message_payload() -> dict:
    """bot_message subtype should still be processed (not skipped)."""
    return {
        "type": "event_callback",
        "team_id": "T012AB3C4",
        "api_app_id": "A012AB3C4",
        "event_id": "Ev012AB3C4BOT",
        "event_time": 1700000002,
        "event": {
            "type": "message",
            "subtype": "bot_message",
            "channel": "C001",
            "bot_id": "B001",
            "text": "Automated message",
            "ts": "1700000002.000200",
        },
    }


@pytest.fixture
def message_changed_payload() -> dict:
    """message_changed subtype — should be ignored."""
    return {
        "type": "event_callback",
        "team_id": "T012AB3C4",
        "api_app_id": "A012AB3C4",
        "event_id": "Ev012AB3C4CHG",
        "event_time": 1700000003,
        "event": {
            "type": "message",
            "subtype": "message_changed",
            "channel": "C001",
            "ts": "1700000003.000300",
        },
    }


@pytest.fixture
def app_mention_payload() -> dict:
    return {
        "type": "event_callback",
        "team_id": "T012AB3C4",
        "api_app_id": "A012AB3C4",
        "event_id": "Ev012AB3C4MNT",
        "event_time": 1700000004,
        "event": {
            "type": "app_mention",
            "user": "U222",
            "text": "<@UBOT> help me please",
            "ts": "1700000004.000400",
            "channel": "C001",
        },
    }


@pytest.fixture
def unknown_event_payload() -> dict:
    return {
        "type": "event_callback",
        "team_id": "T012AB3C4",
        "api_app_id": "A012AB3C4",
        "event_id": "Ev012AB3C4UNK",
        "event_time": 1700000005,
        "event": {"type": "reaction_added", "user": "U1", "reaction": "thumbsup",
                  "item": {}, "event_ts": "1700000005.000000"},
    }


# ---------------------------------------------------------------------------
# handle_webhook_payload — top-level dispatcher
# ---------------------------------------------------------------------------

class TestHandleWebhookPayload:
    @pytest.mark.asyncio
    async def test_url_verification_returns_challenge(self, url_verification_payload):
        result = await slack_events.handle_webhook_payload(url_verification_payload)
        assert result == {"challenge": "test-challenge-xyz"}

    @pytest.mark.asyncio
    async def test_unknown_type_returns_none(self):
        result = await slack_events.handle_webhook_payload({"type": "mystery_type"})
        assert result is None

    @pytest.mark.asyncio
    async def test_app_rate_limited_returns_none(self):
        payload = {
            "type": "app_rate_limited",
            "team_id": "T012AB3C4",
            "minute_rate_limited": 1700000000,
            "api_app_id": "A012AB3C4",
        }
        result = await slack_events.handle_webhook_payload(payload)
        assert result is None


# ---------------------------------------------------------------------------
# Message event handling
# ---------------------------------------------------------------------------

class TestMessageEventHandling:
    @pytest.mark.asyncio
    async def test_message_event_synced_to_supabase(self, message_event_payload):
        with patch(
            "app.services.slack_events.supabase_service.upsert_message",
            new_callable=AsyncMock,
        ) as mock_upsert:
            result = await slack_events.handle_webhook_payload(message_event_payload)

        assert isinstance(result, ParsedEvent)
        assert result.handled is True
        assert result.synced is True
        assert result.event_type == "message"
        mock_upsert.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_message_changed_is_ignored(self, message_changed_payload):
        with patch(
            "app.services.slack_events.supabase_service.upsert_message",
            new_callable=AsyncMock,
        ) as mock_upsert:
            result = await slack_events.handle_webhook_payload(message_changed_payload)

        assert result.handled is False
        mock_upsert.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_bot_message_is_synced(self, bot_message_payload):
        """bot_message should be processed — we want to track bot activity."""
        with patch(
            "app.services.slack_events.supabase_service.upsert_message",
            new_callable=AsyncMock,
        ) as mock_upsert:
            result = await slack_events.handle_webhook_payload(bot_message_payload)

        # bot_message has text so it should sync
        assert result.event_type == "message"
        mock_upsert.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_supabase_failure_does_not_raise(self, message_event_payload):
        """If Supabase is down, the event should still return a ParsedEvent (synced=False)."""
        with patch(
            "app.services.slack_events.supabase_service.upsert_message",
            new_callable=AsyncMock,
            side_effect=Exception("Supabase connection refused"),
        ):
            result = await slack_events.handle_webhook_payload(message_event_payload)

        assert isinstance(result, ParsedEvent)
        assert result.synced is False
        assert result.handled is True  # we handled it, just couldn't persist

    @pytest.mark.asyncio
    async def test_message_data_payload_shape(self, message_event_payload):
        with patch(
            "app.services.slack_events.supabase_service.upsert_message",
            new_callable=AsyncMock,
        ):
            result = await slack_events.handle_webhook_payload(message_event_payload)

        assert result.data is not None
        assert result.data["channel"] == "C001"
        assert result.data["user"] == "U111"
        assert result.data["text"] == "Hello from Slack"
        assert result.data["ts"] == "1700000001.000100"

    @pytest.mark.asyncio
    async def test_empty_text_message_is_skipped(self):
        """Messages with no text (pure file uploads etc.) should be ignored."""
        payload = {
            "type": "event_callback",
            "team_id": "T012AB3C4",
            "api_app_id": "A012AB3C4",
            "event_id": "Ev_NOTEXT",
            "event_time": 1700000010,
            "event": {
                "type": "message",
                "channel": "C001",
                "user": "U111",
                "text": "",        # empty
                "ts": "1700000010.000010",
            },
        }
        with patch(
            "app.services.slack_events.supabase_service.upsert_message",
            new_callable=AsyncMock,
        ) as mock_upsert:
            result = await slack_events.handle_webhook_payload(payload)

        assert result.handled is False
        mock_upsert.assert_not_awaited()


# ---------------------------------------------------------------------------
# App mention handling
# ---------------------------------------------------------------------------

class TestAppMentionHandling:
    @pytest.mark.asyncio
    async def test_mention_is_synced(self, app_mention_payload):
        with patch(
            "app.services.slack_events.supabase_service.upsert_message",
            new_callable=AsyncMock,
        ) as mock_upsert:
            result = await slack_events.handle_webhook_payload(app_mention_payload)

        assert result.event_type == "app_mention"
        assert result.handled is True
        assert result.synced is True
        mock_upsert.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_mention_data_contains_text(self, app_mention_payload):
        with patch(
            "app.services.slack_events.supabase_service.upsert_message",
            new_callable=AsyncMock,
        ):
            result = await slack_events.handle_webhook_payload(app_mention_payload)

        assert result.data["text"] == "<@UBOT> help me please"
        assert result.data["user"] == "U222"


# ---------------------------------------------------------------------------
# Unknown event type
# ---------------------------------------------------------------------------

class TestUnknownEvent:
    @pytest.mark.asyncio
    async def test_unknown_event_type_not_handled(self, unknown_event_payload):
        result = await slack_events.handle_webhook_payload(unknown_event_payload)
        assert isinstance(result, ParsedEvent)
        assert result.handled is False
        assert result.event_type == "reaction_added"


# ---------------------------------------------------------------------------
# HTTP endpoint — app/api/events.py
# ---------------------------------------------------------------------------

class TestEventsWebhookEndpoint:
    """
    Integration-level tests for POST /api/events/webhook.
    Signature verification is bypassed by mocking verify_slack_signature.
    """

    @pytest.fixture
    def client(self):
        """TestClient with signature verification disabled."""
        from app.api.events import router
        from fastapi import FastAPI
        app = FastAPI()
        app.include_router(router)
        return TestClient(app, raise_server_exceptions=False)

    def _post(self, client, payload: dict, bypass_sig: bool = True):
        with patch(
            "app.api.events.verify_slack_signature",
            return_value=bypass_sig,
        ):
            return client.post(
                "/api/events/webhook",
                json=payload,
                headers={
                    "X-Slack-Request-Timestamp": "1700000000",
                    "X-Slack-Signature": "v0=fakesignature",
                },
            )

    def test_url_verification_returns_challenge(self, client, url_verification_payload):
        with patch(
            "app.api.events.verify_slack_signature", return_value=True
        ), patch(
            "app.api.events.slack_events.handle_webhook_payload",
            new_callable=AsyncMock,
            return_value={"challenge": "test-challenge-xyz"},
        ):
            resp = client.post(
                "/api/events/webhook",
                json=url_verification_payload,
                headers={
                    "X-Slack-Request-Timestamp": "1700000000",
                    "X-Slack-Signature": "v0=fake",
                },
            )
        assert resp.status_code == 200
        assert resp.json() == {"challenge": "test-challenge-xyz"}

    def test_event_callback_returns_200_immediately(self, client, message_event_payload):
        with patch("app.api.events.verify_slack_signature", return_value=True), \
             patch("app.api.events.slack_events.handle_webhook_payload", new_callable=AsyncMock):
            resp = client.post(
                "/api/events/webhook",
                json=message_event_payload,
                headers={
                    "X-Slack-Request-Timestamp": "1700000000",
                    "X-Slack-Signature": "v0=fake",
                },
            )
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}

    def test_invalid_signature_returns_403(self, client, message_event_payload):
        with patch("app.api.events.verify_slack_signature", return_value=False):
            resp = client.post(
                "/api/events/webhook",
                json=message_event_payload,
                headers={
                    "X-Slack-Request-Timestamp": "1700000000",
                    "X-Slack-Signature": "v0=badsig",
                },
            )
        assert resp.status_code == 403

    def test_health_endpoint(self, client):
        resp = client.get("/api/events/health")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True