"""
app/api/oauth.py

FastAPI router for the Slack OAuth 2.0 installation flow.

Routes:
  GET /api/oauth/install   → redirect browser to Slack's authorisation page
  GET /api/oauth/callback  → receive the code, exchange for token, redirect to success

Security notes:
  - The `state` parameter prevents CSRF.  In production, generate a random
    token, store it server-side (Redis / signed JWT), and verify it here
    before calling exchange_code_for_token.
  - Never log or return the access_token to the browser.
"""

import logging
import secrets
import time

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse

from app.services import slack_auth

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/oauth", tags=["OAuth"])

# In-memory state store — replace with Redis in production
_state_store: dict[str, float] = {}
_STATE_TTL_SECONDS = 600


def _prune_state_store() -> None:
    now = time.time()
    expired = [state for state, created_at in _state_store.items() if now - created_at > _STATE_TTL_SECONDS]
    for state in expired:
        _state_store.pop(state, None)


# ---------------------------------------------------------------------------
# Install — redirect to Slack
# ---------------------------------------------------------------------------

@router.get("/install", summary="Begin Slack OAuth installation")
async def install():
    """
    Generates a Slack OAuth authorisation URL and redirects the user's
    browser to it.  Slack will ask the user to approve the requested scopes
    and then redirect back to /api/oauth/callback.
    """
    # Generate a cryptographically random state token to prevent CSRF
    state = secrets.token_urlsafe(32)
    _prune_state_store()
    _state_store[state] = time.time()

    install_url = slack_auth.build_install_url(state=state)
    logger.info("Redirecting to Slack install URL (state=%s...)", state[:8])
    return RedirectResponse(url=install_url)


# ---------------------------------------------------------------------------
# Callback — exchange code for token
# ---------------------------------------------------------------------------

@router.get("/callback", summary="Handle Slack OAuth callback")
async def oauth_callback(
    code: str = Query(..., description="One-time authorisation code from Slack"),
    state: str = Query(..., description="CSRF state token we sent in the install URL"),
    error: str = Query(None, description="Error code if user denied the install"),
):
    """
    Slack redirects here after the user approves (or denies) the install.

    On success:
      - Exchanges `code` for a bot access token via oauth.v2.access
      - Persists the token to Supabase
      - Redirects to a success page (or returns JSON in dev mode)

    On failure:
      - Returns a 400 with the error reason
    """
    # User cancelled the install
    if error:
        logger.warning("OAuth install cancelled or failed: %s", error)
        raise HTTPException(status_code=400, detail=f"Slack OAuth error: {error}")

    # Verify state to prevent CSRF
    _prune_state_store()
    if state not in _state_store:
        logger.error("OAuth callback received unknown state token: %s", state[:8])
        raise HTTPException(status_code=400, detail="Invalid state parameter — possible CSRF")

    del _state_store[state]  # One-time use

    try:
        token = await slack_auth.exchange_code_for_token(code)
    except Exception as exc:
        logger.error("Token exchange failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Token exchange failed: {exc}")

    logger.info(
        "Successfully installed for workspace %s (%s)",
        token.team_id,
        token.team_name,
    )

    # Close the popup and notify the opener window (for frontend popup flow)
    html = f"""
    <html><body>
    <script>
      if (window.opener) {{
        window.opener.postMessage({{
          type: "SLACK_OAUTH_SUCCESS",
          team_id: "{token.team_id}",
          team_name: "{token.team_name}"
        }}, "*");
        window.close();
      }} else {{
        document.body.innerHTML = "<p>Slack connected: <strong>{token.team_name}</strong>. You can close this window.</p>";
      }}
    </script>
    </body></html>
    """
    from fastapi.responses import HTMLResponse
    return HTMLResponse(content=html)


# ---------------------------------------------------------------------------
# Revoke / uninstall
# ---------------------------------------------------------------------------

@router.delete(
    "/revoke/{team_id}",
    summary="Revoke a workspace installation",
)
async def revoke_workspace(team_id: str):
    """
    Revokes the bot token for the given workspace on Slack's side and
    removes the row from Supabase.  Call this on app_uninstalled events
    or when an admin removes the integration from your platform.
    """
    try:
        removed = await slack_auth.revoke_token(team_id)
    except Exception as exc:
        logger.error("revoke_token failed for %s: %s", team_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))

    if not removed:
        raise HTTPException(status_code=404, detail=f"Workspace {team_id!r} not found")

    return {"ok": True, "message": f"Workspace {team_id} revoked and removed"}


# ---------------------------------------------------------------------------
# List installed workspaces (admin / debug use)
# ---------------------------------------------------------------------------

@router.get("/workspaces", summary="List all installed workspaces")
async def list_workspaces():
    """Returns all workspaces that have installed the app (tokens redacted)."""
    workspaces = await slack_auth.list_installed_workspaces()
    return {
        "ok": True,
        "count": len(workspaces),
        "workspaces": [
            {
                "team_id": w.team_id,
                "team_name": w.team_name,
                "bot_user_id": w.bot_user_id,
                "scope": w.scope,
                "installed_by": w.installed_by,
            }
            for w in workspaces
        ],
    }
