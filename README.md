# server-manage-bot

Discord bot that manages a Velocity proxy and a Minecraft server running in tmux sessions on the same machine. It provides a live dashboard embed with per-service status and player count, a separate System embed showing the whole container's uptime, CPU and RAM pulled from the Proxmox panel API, and a mod-only control message with Start / Stop / Restart buttons posted in a separate channel.

## Requirements

- Node.js 18+
- tmux
- The bot must run on the same machine as the Minecraft server and Velocity, under a user that can run `tmux`, `ps` and `pgrep`.
- A Proxmox panel API key (for the System embed's uptime/CPU/RAM).

## Setup

1. Create an application at the Discord Developer Portal, add a Bot, and copy its token.
2. Invite the bot to your server with the `bot` and `applications.commands` scopes and permission to send messages in the status channel.
3. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` (and optionally `GUILD_ID` for instant command registration). Set `API_BASE_URL` (e.g. `https://panel.awdevhardware.org/api`) and `PANEL_TOKEN` (a `pvd_k_...` bearer key) for the System embed.
4. Edit `config.json`:
   - `adminRoleId` — role allowed to use the control buttons (server administrators are always allowed).
   - `panel` — Proxmox container the System embed reports on:
     - `node` — Proxmox node name (e.g. `awdevHardware6`).
     - `vmid` — container ID (e.g. `185`).
     - `refreshSeconds` — how often to poll the panel and refresh the System embed.
   - `services` — one entry per process. Each needs:
     - `name` — display name in the embed.
     - `tmuxSession` — tmux session name the bot creates/controls.
     - `cwd` — working directory containing the server jar.
     - `startCommand` — command that runs the server in the foreground.
     - `stopConsoleCommand` — console command for a graceful shutdown (`stop` for Paper/Vanilla, `shutdown` for Velocity).
     - `ping` (optional) — `host`/`port` to query for player count and version.
5. Install and run:

   ```sh
   npm install
   npm start
   ```

6. In Discord, run `/dashboard setup controls:#your-mod-channel` in the channel where the dashboard should live. The status and System embeds are posted in the current channel; the control buttons are posted in the mod-only channel you pass as `controls`. The embeds update every 30 seconds.

## Commands

| Command | Access | Description |
|---|---|---|
| `/dashboard setup controls:` | Admin | Posts the live dashboard in the current channel: a per-service status embed (refreshed every 30 seconds) plus a System embed with the container's uptime, CPU and RAM (refreshed every `refreshSeconds`). The Start/Stop/Restart control buttons are posted as a separate message in the mod-only `controls` channel. |
| `/status` | Everyone | One-time status snapshot of all services, plus the System stats. |
| `/announce [channel]` | Admin | Opens a form (title + multi-line message) and posts it as an embed in the chosen channel (defaults to the current one). |
| `/modpack file: [channel]` | Admin | Attach a `.mrpack`/`.zip`, then fill in a version + changelog form. Posts an embed with the changelog and the file attached for download. |

"Admin" means members with the `adminRoleId` role from `config.json`, or the server Administrator permission.

### Control buttons (admin only)

The control message lives in the mod-only `controls` channel. Each service has its own row:

- **Start** — creates the tmux session and launches the server. Disabled while running.
- **Stop** — asks for confirmation, then sends the graceful stop command; force-kills after 60 seconds. Disabled while offline.
- **Restart** — asks for confirmation, then stops and starts the service. Disabled while offline.

## Behavior notes

- tmux is the process supervisor, not the bot: restarting or crashing the bot never stops the servers. On startup the bot re-detects running sessions and resumes the dashboard.
- Stop is graceful: the bot types the stop command into the server console and waits up to 60 seconds before force-killing the session.
- Stop and Restart ask for confirmation, since they disconnect online players.
- Uptime, CPU and RAM in the System embed are the whole container's, read live from the Proxmox panel API rather than per-service — so they stay correct across bot restarts and don't depend on `ps` parsing.
- Online player names/counts are tracked by parsing each server's `logs/latest.log` and persisted to `data/players.json` (gitignored), so they survive bot restarts and are re-seeded before the log backfill catches up.

## Console API

The bot exposes an authenticated HTTP + WebSocket API (routes under `/f42`) that lets you read each service's console and send commands. It reads from each server's `logs/latest.log` (which Minecraft and Velocity write live), so you get the full console output including scrollback. Sending commands uses the same tmux path as the Discord controls.

Configure it in `.env`:

- `API_HOST` — bind address (default `127.0.0.1`)
- `API_PORT` — port (default `8080`)
- `API_TOKEN` — shared secret, required; sent on the `x-api-key` header (override with `API_HEADER`)
- `WEBHOOK_TOKEN` — optional read-only token, sent on the `x-webhook-token` header (override with `WEBHOOK_HEADER`). It can only `GET` `/f42/services/:name` (single-service status); it cannot list services, read the console, send commands, start/stop/restart, or open a WebSocket. Useful for external integrations that just need to check one service.
- Each service in `config.json` optionally has `latestLog`, which defaults to `<cwd>/logs/latest.log`.

### Endpoints

All requests carry the token on the `x-api-key` header.

`WEBHOOK_TOKEN` (if set) is sent on the `x-webhook-token` header and unlocks only
`GET /f42/services/:name`; every other route needs `API_TOKEN`.

| Method | Route | Description |
|---|---|---|
| `GET` | `/f42/health` | Liveness + uptime. |
| `POST` | `/f42/refresh` | Run `git pull` in the repo, then `pm2 restart 0` to redeploy the bot. |
| `GET` | `/f42/services` | List services with running state, port and log path. |
| `GET` | `/f42/services/:name` | Single-service status. |
| `GET` | `/f42/services/:name/console?lines=200` | Last N lines of console output. |
| `POST` | `/f42/services/:name/console` | Send a command, body `{ "command": "list" }`. |
| `POST` | `/f42/services/:name/start` / `stop` / `restart` | Start/stop/restart (stop waits up to 60s). |
| `GET` | `/f42/services/:name/files` | List files in the service's `<cwd>/mods` directory. |
| `POST` | `/f42/services/:name/files/upload` | Upload mod(s) to the mods directory (multipart, max 250 MB). |
| `DELETE` | `/f42/services/:name/files/:file` | Delete a mod. |
| `POST` | `/f42/services/:name/files/:file/disable` | Disable a `.jar` (renames it to `:file.dis`). |
| `POST` | `/f42/services/:name/files/:file/enable` | Enable a `.jar.dis` (renames it back to `:file`). |
| `GET` | `/f42/services/:name/server.properties` | Read the service's `server.properties` as a parsed key-value object. |
| `POST` | `/f42/services/:name/server.properties` | Change individual properties (backs up to `server.properties.bak` first). |
| `GET` | `/f42/ws?service=:name&token=...` | WebSocket console: streams history then live lines; send `{ "command": "..." }` to run commands over the same socket. |

`stop`/`restart` act like the Discord buttons (graceful stop, force-kill after 60s).

`POST /f42/refresh` runs in the bot's own repo directory: it executes `git pull`, then
triggers `pm2 restart 0`. The response is sent before the restart so the request isn't
cut off; the pm2 process is detached from the bot so it survives the bot exiting.

### Example responses

`GET /f42/health`:

```json
{ "ok": true, "uptimeSeconds": 3817 }
```

`GET /f42/services`:

```json
{
  "services": [
    {
      "name": "Survival",
      "running": true,
      "port": 25566,
      "latestLog": "/root/server/logs/latest.log",
      "playerCount": 3,
      "players": ["Notch", "jeb_", "Herobrine"]
    }
  ]
}
```

`GET /f42/services/Survival` returns the same single-service object (404 with
`{ "error": "Service \"X\" not found." }` for an unknown name).

`GET /f42/services/Survival/console?lines=200`:

```json
{
  "name": "Survival",
  "running": true,
  "lines": ["[12:00:01 INFO]: Starting minecraft server version 1.21.1", "..." ]
}
```

`POST /f42/services/Survival/console` with body `{ "command": "list" }`:

```json
{ "name": "Survival", "command": "list", "sent": true }
```

`POST /f42/services/Survival/start` (also `stop`/`restart`):

```json
{
  "name": "Survival",
  "action": "start",
  "result": "started",
  "running": true
}
```

`GET /f42/ws?service=Survival&token=...` — the WebSocket sends JSON frames:
`{ "type": "status", "name": "Survival", "running": true }`, then one
`{ "type": "line", "text": "..." }` per console line (history then live). Send
`{ "command": "list" }` to run a command; you get back
`{ "type": "echo", "text": "list" }` on success or
`{ "type": "error", "error": "..." }` on failure.

Notes:

- Typed commands are not written to `latest.log` by default (Velocity has `log-command-executions = false`); the API echoes sent commands back on the WebSocket so the console stays coherent.
- `latest.log` is recreated on each server start; the bot detects the rotation and picks up the new file automatically.
- There is no TLS in the API server. It binds to loopback by default; if you expose it beyond localhost, front it with a reverse proxy.

### File management (mods)

Files live in each service's `<cwd>/mods` directory (e.g. Survival with `cwd: "/root/server"` uses `/root/server/mods`). The mods directory is created on first upload.

Upload mods via `multipart/form-data` (each `file` field is stored under its original filename; multiple files per request are supported, up to 250 MB total):

```
POST /f42/services/Survival/files/upload
x-api-key: $API_TOKEN
Content-Type: multipart/form-data

file=@/local/path/MyMod.jar
```

Response: `201 { "name": "Survival", "uploaded": ["MyMod.jar"] }`

List files:

```
GET /f42/services/Survival/files
x-api-key: $API_TOKEN
```

Response:

```json
{
  "name": "Survival",
  "files": [
    { "name": "MyMod.jar", "size": 482031, "modified": "2026-09-15T10:30:00.000Z", "enabled": true },
    { "name": "OldMod.jar.dis", "size": 12984, "modified": "2026-09-01T08:12:00.000Z", "enabled": false }
  ]
}
```

Disable a mod (renames `MyMod.jar` → `MyMod.jar.dis` so the server skips it; only works on `.jar` files):

```
POST /f42/services/Survival/files/MyMod.jar/disable
x-api-key: $API_TOKEN
```

Enable it again (`MyMod.jar.dis` → `MyMod.jar`):

```
POST /f42/services/Survival/files/MyMod.jar.dis/enable
x-api-key: $API_TOKEN
```

Delete a mod (pass the filename URL-encoded):

```
DELETE /f42/services/Survival/files/MyMod.jar
x-api-key: $API_TOKEN
```

Filenames are validated against path traversal; uploading into subdirectories is not allowed. Disabled files keep a `name` ending in `.dis` and report `"enabled": false` in the listing.

### server.properties

Each Minecraft server's `server.properties` lives at its `cwd/server.properties`. Read it or update individual keys without touching comments, blank lines or the rest of the file. The old file is backed up to `server.properties.bak` before each write.

Returns 404 for services without a `server.properties` (e.g. Velocity, which uses `velocity.toml`).

Read the current config:

```
GET /f42/services/Survival/server.properties
x-api-key: $API_TOKEN
```

Response:

```json
{
  "name": "Survival",
  "path": "/root/server/server.properties",
  "exists": true,
  "properties": {
    "enable-jmx-monitoring": "false",
    "gamemode": "survival",
    "max-players": "20",
    "view-distance": "12"
  }
}
```

Change one or more properties (only the listed keys are updated; the rest of the file is preserved):

```
POST /f42/services/Survival/server.properties
x-api-key: $API_TOKEN
Content-Type: application/json

{
  "properties": {
    "max-players": "50",
    "gamemode": "creative"
  }
}
```

Response:

```json
{
  "name": "Survival",
  "path": "/root/server/server.properties",
  "exists": true,
  "updated": { "max-players": "50", "gamemode": "creative" },
  "properties": {
    "enable-jmx-monitoring": "false",
    "gamemode": "creative",
    "max-players": "50",
    "view-distance": "12"
  }
}
```

Property names containing `=`, `:`, whitespace, `#`, `!`, or `\` are rejected with a `400` error.

Note: `server.properties` is read on server startup. Changes made via this endpoint take effect the next time the server is restarted.

## Running the bot itself in the background

Run the bot under its own tmux session or a process manager, e.g.:

```sh
tmux new-session -d -s manage-bot 'npm start'
```
