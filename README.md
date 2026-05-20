# 🔌 Collectium Slack MCP

> A FastAPI service that bridges Slack workspaces with Collectium — handling OAuth installation, real-time events, message history, and Supabase sync.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-green.svg)](https://fastapi.tiangolo.com)
[![Supabase](https://img.shields.io/badge/Supabase-integrated-3ECF8E.svg)](https://supabase.com)

---

## ✨ Features

- **OAuth 2.0 Installation** — One-click bot installation into any Slack workspace
- **Real-time Events** — Receives and processes Slack events via the Events API
- **Message History** — Fetch, paginate, and sync channel message history
- **Supabase Sync** — Bulk-upsert messages to Supabase for persistent storage
- **Send Messages** — Post messages or threaded replies to any channel
- **Mounted Architecture** — Reuses routers inside the main TrackA backend; no separate process needed
- **Signature Verification** — Every incoming Slack webhook is cryptographically verified
- **Duplicate Handling** — In-memory deduplication of Slack event IDs

---

## 🏗️ Architecture

The Slack handlers in `app/api/{events,oauth,messages}.py` are **reused, not redeployed**. The main TrackA backend (`intelligence/backend/app.py`) imports and mounts them automatically when all required environment variables are present. There is **no separate Slack process or container**.

```
collectium-slack-mcp/
├── app/
│   ├── api/           # FastAPI routers (oauth, messages, events)
│   ├── config/        # settings.py — env var parsing via pydantic-settings
│   ├── models/        # Pydantic models for Slack and Supabase data
│   ├── services/      # Business logic (slack_auth, slack_messages, supabase_service)
│   └── utils/         # retry, logging, Slack signature verification
├── tests/
├── main.py
├── requirements.txt
└── .env
```

---

## 🚀 Public URLs

When deployed, configure these URLs in your Slack app settings:

| Slack Setting | URL |
|---|---|
| Event Subscriptions | `https://staging.fairquanta.ai/slack/events/webhook` |
| OAuth Redirect | `https://staging.fairquanta.ai/slack/oauth/callback` |
| Install (browser) | `https://staging.fairquanta.ai/slack/oauth/install` |
| Webhook health check | `https://staging.fairquanta.ai/slack/events/health` |

> **Legacy paths** — `/api/events/webhook`, `/api/oauth/install`, `/api/oauth/callback`, `/api/messages/*` remain active for backward compatibility.

---

## 📋 Prerequisites

- Python 3.11+
- A [Slack App](https://api.slack.com/apps) created under your workspace
- A [Supabase](https://supabase.com) project
- [ngrok](https://ngrok.com) for local development (exposes localhost to Slack)

---

## ⚙️ Setup

### 1. Install dependencies

```bash
cd intelligence/backend/collectium-slack-mcp
pip install -r requirements.txt
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env` with your credentials:

```env
SLACK_CLIENT_ID=your_client_id
SLACK_CLIENT_SECRET=your_client_secret
SLACK_SIGNING_SECRET=your_signing_secret
SLACK_REDIRECT_URI=https://YOUR_NGROK_URL/api/oauth/callback

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

- **Slack credentials**: [api.slack.com/apps](https://api.slack.com/apps) → Your App → Basic Information
- **Supabase credentials**: [app.supabase.com](https://app.supabase.com) → Project → Settings → API

### 3. Start ngrok (local dev only)

Slack requires a public HTTPS URL to send events and OAuth callbacks.

```bash
ngrok http 8000
```

Copy the `https://xxxx.ngrok-free.app` URL and update your `.env` and Slack portal.

> **Note:** Free-tier ngrok URLs change on every restart. Remember to update both places.

### 4. Configure Slack App

In the [Slack API portal](https://api.slack.com/apps):

**OAuth & Permissions**
- Add redirect URL: `https://YOUR_NGROK_URL/api/oauth/callback`
- Add these Bot Token Scopes:

| Scope | Scope |
|---|---|
| `app_mentions:read` | `groups:history` |
| `channels:history` | `groups:read` |
| `channels:read` | `im:history` |
| `channels:join` | `im:read` |
| `chat:write` | `mpim:history` |
| `chat:write.public` | `mpim:read` |
| `reactions:read` | `users:read` |

**Event Subscriptions**
- Enable events: **On**
- Request URL: `https://YOUR_NGROK_URL/api/events/webhook`
- Subscribe to bot events: `message.channels`, `message.groups`, `app_mention`

**App Home**
- Enable **Home Tab** and **Messages Tab**
- Check "Allow users to send Slash commands and messages from the messages tab"

### 5. Run the server

```bash
python -m uvicorn main:app --reload
```

Server starts at `http://localhost:8000` — interactive API docs at `http://localhost:8000/docs`.

### 6. Install the bot to your workspace

```
https://YOUR_NGROK_URL/api/oauth/install
```

On success:

```json
{
  "ok": true,
  "message": "Collectium connected to Slack workspace 'YourWorkspace'",
  "team_id": "T...",
  "team_name": "YourWorkspace"
}
```

The bot will appear in the Slack left sidebar under **Apps**.

---

## 📡 API Reference

### List channels

```http
GET /api/messages/{team_id}/channels
```

### Fetch message history

```http
GET /api/messages/{team_id}/{channel_id}?limit=200
```

| Parameter | Default | Description |
|---|---|---|
| `limit` | 50 | Messages per page (max 200) |
| `cursor` | — | Pagination cursor from previous response |
| `oldest` | — | Fetch messages after this Unix timestamp |
| `latest` | — | Fetch messages before this Unix timestamp |
| `sync` | true | Save fetched messages to Supabase |

### Send a message

```http
POST /api/messages/send
```

```bash
curl -X POST http://localhost:8000/api/messages/send \
  -H "Content-Type: application/json" \
  -d '{
    "team_id": "T05EVKLDFA6",
    "channel": "C092ETQE4M8",
    "text": "Hello from Collectium!"
  }'
```

| Field | Required | Description |
|---|---|---|
| `team_id` | ✅ | Slack workspace ID |
| `channel` | ✅ | Channel ID (`C...`) or name (`#general`) |
| `text` | ✅ | Message text |
| `thread_ts` | ❌ | Reply in a thread |
| `blocks` | ❌ | Block Kit JSON array |

### Read synced messages (Supabase, no Slack API call)

```http
GET /api/messages/synced/{team_id}/{channel_id}?limit=50
```

### List installed workspaces

```http
GET /api/oauth/workspaces
```

### Health check

```http
GET /health
```

---

## 🗺️ Full Endpoint Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/docs` | Interactive API docs (Swagger) |
| `GET` | `/api/oauth/install` | Begin Slack OAuth installation |
| `GET` | `/api/oauth/callback` | OAuth callback handler |
| `DELETE` | `/api/oauth/revoke/{team_id}` | Revoke a workspace installation |
| `GET` | `/api/oauth/workspaces` | List all installed workspaces |
| `POST` | `/api/events/webhook` | Slack Events API webhook receiver |
| `GET` | `/api/messages/{team_id}/channels` | List channels in workspace |
| `GET` | `/api/messages/{team_id}/{channel_id}` | Fetch channel message history |
| `GET` | `/api/messages/synced/{team_id}/{channel_id}` | Read synced messages from Supabase |
| `POST` | `/api/messages/send` | Send a message to a channel |

---

## 🔒 Required Environment Variables

These must be set on the main backend's host:

```
SLACK_CLIENT_ID
SLACK_CLIENT_SECRET
SLACK_SIGNING_SECRET
SLACK_REDIRECT_URI            # must match the OAuth Redirect URL in Slack settings
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_KEY          # used by main app
SUPABASE_SERVICE_ROLE_KEY     # used by slack-mcp settings.py (same value as above)
```

### Startup verification

Check the main backend logs for one of:

```
[SLACK MCP] Mounted (preferred):  POST /slack/events/webhook  GET /slack/events/health  ...
[SLACK MCP] Mounted (legacy):     POST /api/events/webhook  ...
```

If you see `[SLACK MCP] Skipped` — env vars are missing on the host.  
If you see `[SLACK MCP] Mount failed` — check the logged exception; usually the slack-mcp dependencies aren't on the Python path of the main backend's process.

---

## 📝 Implementation Notes

- Slack webhook requests are verified using the signing secret on every incoming request
- Event callbacks are acknowledged immediately and processed asynchronously in the background
- Duplicate Slack event IDs are filtered in-memory to reduce retry noise
- Message sync uses bulk upsert for efficient Supabase writes
- Channel metadata is briefly cached to avoid redundant Slack API calls
- The bot auto-joins public channels when fetching messages if not already a member

---

## 🤝 Contributing

Contributions are welcome! Please open an issue to discuss what you'd like to change, or submit a pull request directly.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

## 🔗 Links

- [Slack API Docs](https://api.slack.com)
- [Supabase Docs](https://supabase.com/docs)
- [FastAPI Docs](https://fastapi.tiangolo.com)
- [ngrok Docs](https://ngrok.com/docs)