"""
tests/test_oauth.py

Unit tests for app/services/slack_auth.py.

All Slack SDK and Supabase calls are mocked — no real credentials needed.

Run:
    pytest tests/test_oauth.py -v
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.models.slack_models import SlackToken, SlackTokenCreate
from app.services import slack_auth


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_token() -> SlackToken:
    return SlackToken(
        id="00000000-0000-0000-0000-000000000001",
        team_id="T012AB3C4",
        team_name="Acme Corp",
        bot_user_id="U012AB3C4",
        access_token="xoxb-fake-token",
        scope="channels:history,channels:read,chat:write",
        installed_by="U999INSTALLER",
    )


@pytest.fixture
def fake_oauth_response() -> dict:
    return {
        "ok": True,
        "access_token": "xoxb-fake-token",
        "token_type": "bot",
        "scope": "channels:history,channels:read,chat:write",
        "bot_user_id": "U012AB3C4",
        "app_id": "A012AB3C4",
        "team": {"id": "T012AB3C4", "name": "Acme Corp"},
        "authed_user": {"id": "U999INSTALLER"},
    }


# ---------------------------------------------------------------------------
# build_install_url
# ---------------------------------------------------------------------------

class TestBuildInstallUrl:
    def test_returns_non_empty_string(self):
        url = slack_auth.build_install_url(state="test-state-123")
        assert isinstance(url, str) and len(url) > 20

    def test_includes_state_param(self):
        url = slack_auth.build_install_url(state="my-csrf-state")
        assert "my-csrf-state" in url

    def test_different_states_produce_different_urls(self):
        url1 = slack_auth.build_install_url(state="state-aaa")
        url2 = slack_auth.build_install_url(state="state-bbb")
        assert url1 != url2


# ---------------------------------------------------------------------------
# exchange_code_for_token
# ---------------------------------------------------------------------------

class TestExchangeCodeForToken:
    @pytest.mark.asyncio
    async def test_successful_exchange(self, fake_token, fake_oauth_response):
        mock_client = AsyncMock()
        mock_client.oauth_v2_access.return_value = fake_oauth_response

        with (
            patch("app.services.slack_auth.AsyncWebClient", return_value=mock_client),
            patch(
                "app.services.slack_auth.supabase_service.upsert_token",
                new_callable=AsyncMock,
                return_value=fake_token,
            ),
        ):
            result = await slack_auth.exchange_code_for_token("valid-code")

        assert result.team_id == "T012AB3C4"
        assert result.team_name == "Acme Corp"
        assert result.access_token == "xoxb-fake-token"
        mock_client.oauth_v2_access.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_slack_returns_error_raises(self):
        mock_client = AsyncMock()
        mock_client.oauth_v2_access.return_value = {"ok": False, "error": "invalid_code"}

        with patch("app.services.slack_auth.AsyncWebClient", return_value=mock_client):
            with pytest.raises(RuntimeError, match="invalid_code"):
                await slack_auth.exchange_code_for_token("bad-code")

    @pytest.mark.asyncio
    async def test_empty_access_token_raises(self):
        mock_client = AsyncMock()
        mock_client.oauth_v2_access.return_value = {
            "ok": True,
            "access_token": "",
            "bot_user_id": "U1",
            "scope": "chat:write",
            "team": {"id": "T1", "name": "Test"},
        }

        with patch("app.services.slack_auth.AsyncWebClient", return_value=mock_client):
            with pytest.raises(RuntimeError, match="No access_token"):
                await slack_auth.exchange_code_for_token("code")

    @pytest.mark.asyncio
    async def test_upsert_called_with_correct_payload(self, fake_oauth_response):
        mock_client = AsyncMock()
        mock_client.oauth_v2_access.return_value = fake_oauth_response
        captured: list[SlackTokenCreate] = []

        async def capture(data: SlackTokenCreate):
            captured.append(data)
            return SlackToken(
                team_id=data.team_id, team_name=data.team_name,
                bot_user_id=data.bot_user_id, access_token=data.access_token,
                scope=data.scope,
            )

        with (
            patch("app.services.slack_auth.AsyncWebClient", return_value=mock_client),
            patch("app.services.slack_auth.supabase_service.upsert_token", side_effect=capture),
        ):
            await slack_auth.exchange_code_for_token("code")

        assert len(captured) == 1
        assert captured[0].team_id == "T012AB3C4"
        assert captured[0].installed_by == "U999INSTALLER"


# ---------------------------------------------------------------------------
# get_token / get_token_or_raise
# ---------------------------------------------------------------------------

class TestGetToken:
    @pytest.mark.asyncio
    async def test_returns_token_when_found(self, fake_token):
        with patch(
            "app.services.slack_auth.supabase_service.get_token",
            new_callable=AsyncMock, return_value=fake_token,
        ):
            result = await slack_auth.get_token("T012AB3C4")

        assert result is not None
        assert result.team_id == "T012AB3C4"

    @pytest.mark.asyncio
    async def test_returns_none_when_missing(self):
        with patch(
            "app.services.slack_auth.supabase_service.get_token",
            new_callable=AsyncMock, return_value=None,
        ):
            result = await slack_auth.get_token("T_UNKNOWN")
        assert result is None

    @pytest.mark.asyncio
    async def test_get_token_or_raise_on_missing(self):
        with patch(
            "app.services.slack_auth.supabase_service.get_token_or_raise",
            new_callable=AsyncMock,
            side_effect=ValueError("has not installed this app"),
        ):
            with pytest.raises(ValueError, match="has not installed"):
                await slack_auth.get_token_or_raise("T_UNKNOWN")


# ---------------------------------------------------------------------------
# revoke_token
# ---------------------------------------------------------------------------

class TestRevokeToken:
    @pytest.mark.asyncio
    async def test_revokes_and_deletes(self, fake_token):
        mock_client = AsyncMock()
        mock_client.auth_revoke = AsyncMock(return_value={"ok": True})

        with (
            patch("app.services.slack_auth.supabase_service.get_token",
                  new_callable=AsyncMock, return_value=fake_token),
            patch("app.services.slack_auth.AsyncWebClient", return_value=mock_client),
            patch("app.services.slack_auth.supabase_service.delete_token",
                  new_callable=AsyncMock, return_value=True),
        ):
            result = await slack_auth.revoke_token("T012AB3C4")

        assert result is True
        mock_client.auth_revoke.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_returns_false_when_not_found(self):
        with patch(
            "app.services.slack_auth.supabase_service.get_token",
            new_callable=AsyncMock, return_value=None,
        ):
            result = await slack_auth.revoke_token("T_GHOST")
        assert result is False

    @pytest.mark.asyncio
    async def test_still_deletes_if_slack_revoke_fails(self, fake_token):
        mock_client = AsyncMock()
        mock_client.auth_revoke.side_effect = Exception("Slack unreachable")

        with (
            patch("app.services.slack_auth.supabase_service.get_token",
                  new_callable=AsyncMock, return_value=fake_token),
            patch("app.services.slack_auth.AsyncWebClient", return_value=mock_client),
            patch("app.services.slack_auth.supabase_service.delete_token",
                  new_callable=AsyncMock, return_value=True) as mock_del,
        ):
            result = await slack_auth.revoke_token("T012AB3C4")

        assert result is True
        mock_del.assert_awaited_once_with("T012AB3C4")