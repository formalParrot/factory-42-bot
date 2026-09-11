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
- Each service in `config.json` optionally has `latestLog`, which defaults to `<cwd>/logs/latest.log`.

### Endpoints

All requests carry the token on the `x-api-key` header.

| Method | Route | Description |
|---|---|---|
| `GET` | `/f42/health` | Liveness + uptime. |
| `GET` | `/f42/services` | List services with running state, port and log path. |
| `GET` | `/f42/services/:name` | Single-service status. |
| `GET` | `/f42/services/:name/console?lines=200` | Last N lines of console output. |
| `POST` | `/f42/services/:name/console` | Send a command, body `{ "command": "list" }`. |
| `POST` | `/f42/services/:name/start` / `stop` / `restart` | Start/stop/restart (stop waits up to 60s). |
| `GET` | `/f42/ws?service=:name&token=...` | WebSocket console: streams history then live lines; send `{ "command": "..." }` to run commands over the same socket. |

`stop`/`restart` act like the Discord buttons (graceful stop, force-kill after 60s).

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

## Running the bot itself in the background

Run the bot under its own tmux session or a process manager, e.g.:

```sh
tmux new-session -d -s manage-bot 'npm start'
```
