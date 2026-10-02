# server-manage-bot

A Discord bot and HTTP API for running a Minecraft network — a Velocity proxy and
any number of Minecraft servers — in tmux sessions on a single machine.

It gives you a live dashboard in Discord (per-service status, online players,
container CPU/RAM), admin-only Start/Stop/Restart buttons, and a full
authenticated HTTP + WebSocket API for reading consoles, sending commands,
managing mods and configs, installing server cores, and taking whitelist
requests from the public internet.

---

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Setup](#setup)
- [Discord usage](#discord-usage)
- [Console API](#console-api)
  - [Authentication](#authentication)
  - [Rate limiting](#rate-limiting)
  - [Endpoint reference](#endpoint-reference)
  - [Whitelist](#whitelist)
  - [Services and consoles](#services-and-consoles)
  - [WebSockets](#websockets)
  - [Mods](#mods)
  - [server.properties](#serverproperties)
  - [Config files](#config-files)
  - [Banned players](#banned-players)
  - [Server cores](#server-cores)
- [Operations and security](#operations-and-security)
- [Running in the background](#running-in-the-background)
- [Code layout](#code-layout)

---

## What it does

**In Discord**

- A live dashboard embed with each service's status, player count and online
  player names, refreshed every 30 seconds.
- A System embed with the whole container's uptime, CPU and RAM, read live from
  the Proxmox panel API.
- Admin-only Start / Stop / Restart buttons in a separate mod-only channel, with
  confirmation prompts and graceful shutdown.
- Slash commands to set the dashboard up, post announcements and announce modpack
  updates.

**Over HTTP**

- Status for every service, per-service console scrollback and live streaming.
- Send console commands to any service, or a `sudo -i` root shell.
- Full file management for mods and per-service config directories, including
  upload, edit, enable/disable and delete.
- Read and patch `server.properties` without disturbing comments or formatting.
- Ban and unban players, with Mojang UUID resolution.
- Install and upgrade NeoForge server cores without leaving the API.
- Accept whitelist requests from anyone, and approve or deny them as an admin —
  approval runs the command on every service at once — plus check whether a
  player is actually whitelisted anywhere in the network.

---

## How it works

tmux is the process supervisor, not the bot. Each service is a tmux session whose
`startCommand` runs in the foreground; the bot only creates sessions, types
commands into them, and watches their logs. Restarting or crashing the bot
therefore never takes a server down.

The bot learns what is happening by reading each service's `logs/latest.log`,
which Minecraft and Velocity write live. That is where the console scrollback,
the online player roster and the "server is up" signal all come from. The
`latest.log` path is configurable per service and defaults to
`<cwd>/logs/latest.log`.

Everything the bot does to a server goes through the same three primitives:

| Primitive | Used for |
|---|---|
| `tmux send-keys` | Sending console commands, including the whitelist command |
| `tmux new-session` / `has-session` / `kill-session` | Start, status and force-kill |
| `sudo` file operations | Mods, configs, `server.properties`, ban lists, core installs |

Because Discord buttons, the HTTP API and the WebSocket API all funnel into those
primitives, everything behaves identically no matter which surface you use.

---

## Requirements

- **Node.js 18+**
- **tmux**
- The bot must run on the same machine as the servers, as a user that can run
  `tmux` and has **passwordless `sudo`** (needed to read/write server files and to
  run the NeoForge installer).
- A **Proxmox panel API key** (`pvd_k_...`) if you want the System embed.
- `curl` and `java` on the machine if you use the core installer.

---

## Setup

### 1. Create the Discord application

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications),
   add a Bot, and copy its token.
2. Invite it with the `bot` and `applications.commands` scopes and permission to
   send messages in the status channel.

### 2. Configure the environment

```sh
cp .env.example .env
```

| Variable | Required | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token. The process refuses to start without it. |
| `GUILD_ID` | no | Registers slash commands to one guild for instant availability. Omit it and Discord takes up to an hour to propagate them globally. |
| `API_HOST` | no | Bind address for the HTTP API (default `127.0.0.1`). |
| `API_PORT` | no | Port for the HTTP API (default `8080`). |
| `API_TOKEN` | yes | Full-access shared secret for the API. The process refuses to start the API without it. |
| `API_HEADER` | no | Header carrying `API_TOKEN` (default `x-api-key`). |
| `WEBHOOK_TOKEN` | no | Read-only token, see [Authentication](#authentication). |
| `WEBHOOK_HEADER` | no | Header carrying `WEBHOOK_TOKEN` (default `x-webhook-token`). |
| `TRUST_PROXY` | no | Set to `1` to take the client IP from `x-forwarded-for`. Only do this behind a proxy that sets it. |
| `WHITELIST_REQUESTS_PER_HOUR` | no | Whitelist requests allowed per IP per hour (default `5`, minimum `1`). |
| `WHITELIST_READS_PER_MINUTE` | no | Whitelist lookups allowed per IP per minute (default `60`). `0` disables the limit. |
| `API_BASE_URL` | no | Proxmox panel base URL, e.g. `https://panel.example.org/api`. |
| `PANEL_TOKEN` | no | Proxmox panel key, sent as `Authorization: Bearer`. |
| `START_STOP_WEBHOOK_URL` | no | Endpoint POSTed to whenever a service starts or stops. |
| `START_STOP_WEBHOOK_TOKEN` | no | Token for that webhook (default header `x-admin-key`). |

### 3. Configure the services

`config.json` is read once at startup, so restart the bot after editing it.

```json
{
  "adminRoleId": "1534270776876863623",
  "techRoleId": "1534838499155640381",
  "panel": { "node": "awdevHardware6", "vmid": 185, "refreshSeconds": 2 },
  "services": [
    {
      "name": "Survival",
      "tmuxSession": "mcserver",
      "cwd": "/root/server",
      "latestLog": "/root/server/logs/latest.log",
      "startCommand": "bash run.sh",
      "stopConsoleCommand": "stop",
      "core": { "type": "neoforge" },
      "whitelist": false,
      "ping": { "host": "127.0.0.1", "port": 25566 }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `adminRoleId` | Role that may use admin slash commands. Members with the Administrator permission always pass. |
| `techRoleId` | Role that may additionally use the Start/Stop/Restart buttons. |
| `panel.node` | Proxmox node name. |
| `panel.vmid` | Proxmox container/LXC ID. |
| `panel.refreshSeconds` | How often to poll the panel API. |
| `services[]` | One entry per process. **1 to 5 entries** — Discord allows 5 action rows per message, and each service needs one. |

Per service:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Display name, and the lookup key for `:name` in API routes (case-insensitive). |
| `tmuxSession` | yes | tmux session name the bot creates and types into. |
| `cwd` | yes | Working directory holding the server jar, `mods/`, `config/`, `server.properties`. |
| `startCommand` | yes | Command run in the foreground inside the tmux session. |
| `stopConsoleCommand` | yes | Console command for a graceful shutdown (`stop` for Paper/Vanilla, `shutdown` for Velocity). |
| `latestLog` | no | Defaults to `<cwd>/logs/latest.log`. |
| `core` | no | `{ "type": "neoforge" }` enables the core endpoints. Add `"mcVersion"` to override the auto-detected Minecraft version. |
| `whitelist` | no | `false` opts the service out of the whitelist entirely — never read, never sent the command. For services with no built-in whitelist, e.g. Velocity. Defaults to `true`. |
| `ping` | no | `{ "host", "port" }` queried with the Minecraft Server List Ping for an authoritative player count. |

### 4. Install and run

```sh
npm install
npm start
```

### 5. Post the dashboard

In Discord, run:

```
/dashboard setup controls:#your-mod-channel
```

The status and System embeds are posted in the channel you run the command in;
the Start/Stop/Restart buttons are posted in the mod-only channel you pass. The
message IDs are remembered in `data/dashboard.json`, so the bot keeps editing
the same message across restarts. Re-running the command is safe and repairs a
dashboard whose message was deleted.

---

## Discord usage

| Command | Access | Description |
|---|---|---|
| `/status` | Everyone | One-time ephemeral snapshot of every service plus the System stats. |
| `/dashboard setup controls:` | Admin | Posts or repairs the live dashboard and the control buttons. |
| `/announce [channel]` | Admin | Opens a form (title + body) and posts it as an embed. Defaults to the current channel. |
| `/modpack file: [channel]` | Admin | Attach a `.mrpack`/`.zip`, fill in a version + changelog form, and post the changelog with the file attached. |

**Admin** means the `adminRoleId` role from `config.json` or the Administrator
permission. The control buttons additionally accept the `techRoleId` role.

### Control buttons

Each service gets its own row: a label, then Start, Stop and Restart.

- **Start** creates the tmux session and runs `startCommand`. Disabled while running.
- **Stop** asks for confirmation, types `stopConsoleCommand` into the console and
  waits up to 60 seconds before force-killing the session. Disabled while offline.
- **Restart** asks for confirmation, then stops and starts the service. Disabled while offline.

All three are disabled while that service is mid-transition. Stop and Restart
always confirm first, because they disconnect online players.

### Behaviour worth knowing

- **tmux is the supervisor.** A bot crash or redeploy never stops a server.
- **Stops are graceful.** The bot types the stop command and polls for up to 60
  seconds before resorting to `tmux kill-session`.
- **The dashboard self-heals.** If a message is deleted, the bot notices the
  Discord `Unknown Message` error, forgets the ID, and tells you to re-run
  `/dashboard setup`.
- **Player rosters are reconstructed from logs.** On startup and after every
  log rotation (each server restart) the bot re-scans the tail of `latest.log`
  for join/leave lines, and Paper's periodic "There are N of a max of M players
  online" line is treated as an authoritative correction.
- **State on disk.** Only `data/dashboard.json` (message IDs) and
  `data/players.json` (last known roster) are persisted; both live in the
  gitignored `data/` directory. Everything else is in-memory and rebuilt on
  startup.

---

## Console API

The bot serves an HTTP + WebSocket API under `/f42` for scripting and external
integrations. It reuses the same tmux and file operations as the Discord
controls, so behaviour matches.

```sh
# Public — no key needed.
curl http://127.0.0.1:8080/f42/services

# Everything else needs the admin key.
curl -H "x-api-key: $API_TOKEN" http://127.0.0.1:8080/f42/health
```

Six routes are public: the two service status reads and the four whitelist ones
(see [Authentication](#authentication)). Every other route needs a token,
`GET /f42/health` included — an uptime monitor should hold `WEBHOOK_TOKEN` if it
only wants to poll one service's status.

Every response is JSON. Errors are always `{"error": "..."}` with a meaningful
status code (`400` bad input, `401` missing/bad key, `403` insufficient key,
`404` unknown service or route, `405` wrong method, `409` wrong state, `429`
rate limited, `500` internal, `502` upstream failure).

### Authentication

Two tokens with very different powers:

| Token | Header | Can do |
|---|---|---|
| `API_TOKEN` (required) | `x-api-key` (override with `API_HEADER`) | Everything. This is the admin key. |
| `WEBHOOK_TOKEN` (optional) | `x-webhook-token` (override with `WEBHOOK_HEADER`) | `GET /f42/services/:name` and nothing else. |

A `WEBHOOK_TOKEN` cannot list services, read a console, send a command,
start/stop/restart, touch files or cores, or open a WebSocket. It exists so an
external monitor can check one service without holding an admin key. Sending a
webhook token to any other route returns `403`.

**Six routes need no token at all**, so a public page can show server status,
submit a request and poll whether a player is whitelisted yet:

| Route | Purpose |
|---|---|
| `GET /f42/services` | Is the network up, and who is on each server? |
| `GET /f42/services/:name` | One server's status. |
| `POST /f42/whitelist/request` | Queue a whitelist request. |
| `GET /f42/whitelist?player=Notch` | Is this player whitelisted, per service? |
| `GET /f42/whitelist` | Every service's whitelist, plus the union of names. |
| `GET /f42/services/:name/whitelist` | One server's whitelist. |

The four whitelist reads are rate limited instead, and `GET /f42/whitelist/requests`,
`POST /f42/whitelist/approve` and `POST /f42/whitelist/deny` still need
`API_TOKEN` — the queue, its contact details and the IP each request came from
are never public. Note that the bare `GET /f42/whitelist` publishes the full
player roster to anyone, and that service status includes who is currently
online; `?player=` is the lookup that only reveals a name the caller already
knows. See [Whitelist](#whitelist).

The list of public routes is one function, `isPublicRequest` in `src/api.js`,
sitting directly under the auth gate so the whole unauthenticated surface is
readable in one screen. Everything else under `/f42/services/:name` stays keyed
on purpose — see [Security](#security-and-hardening).

WebSocket upgrades cannot carry custom headers from a browser, so they also
accept the admin key as a `?token=` query parameter.

### Rate limiting

Only the whitelist routes are rate limited, on two separate budgets:

| Routes | Default | Env var |
|---|---|---|
| `POST /f42/whitelist/request` | 5 per IP per hour | `WHITELIST_REQUESTS_PER_HOUR` |
| The four public whitelist GETs | 60 per IP per minute | `WHITELIST_READS_PER_MINUTE` (0 disables) |

The POST is tight because it writes to the queue. The GETs are loose because
they only read and polling them is the intended use; the limit exists to stop a
flood, since each lookup costs a `sudo` read per service. Both windows slide, so
a counter refills gradually rather than all at once. Exceeding either returns
`429` with a `Retry-After` header and a `retryAfterSeconds` field.

The request limit is charged before the body is even parsed, so a flood of
malformed requests costs the caller their quota rather than the server its time.

The client IP comes from the socket. If the API sits behind a reverse proxy, set
`TRUST_PROXY=1` to use the first `x-forwarded-for` entry instead — without it,
every client behind the proxy shares one bucket, and with it trusted while the
API is directly exposed, a client could spoof the header to mint fresh buckets.

Everything else is protected by holding `API_TOKEN`.

### Endpoint reference

Everything below needs `API_TOKEN` on `x-api-key` unless the row says
**none**. A `WEBHOOK_TOKEN` gets `403` on all of them.

#### General

| Method | Route | Description |
|---|---|---|
| `GET` | `/f42/health` | Liveness and bot uptime in seconds. |
| `POST` | `/f42/refresh` | `git stash && git pull` in the bot's repo, then `pm2 restart 0`. Responds before restarting. |

#### Whitelist

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/f42/whitelist/request` | **none** | Queue a request. Rate limited to 5/hour per IP. |
| `GET` | `/f42/whitelist?player=Notch` | **none** | Is this player on each server's real whitelist? |
| `GET` | `/f42/whitelist` | **none** | Every service's whitelist, plus the union of names. |
| `GET` | `/f42/services/:name/whitelist` | **none** | That server's own `whitelist.json`. |
| `GET` | `/f42/whitelist/requests` | admin | The request queue. Optional `?status=pending\|approved\|denied`. |
| `POST` | `/f42/whitelist/approve` | admin | Approve a request; runs the command on every service. |
| `POST` | `/f42/whitelist/deny` | admin | Reject a pending request. |

The four un-authenticated rows are rate limited per IP — 5/hour for the POST, 60
per minute for the GETs, so a page can poll them. The rest need `API_TOKEN`.

#### Services

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/f42/services` | **none** | List every service: running state, port, log path, online players. |
| `GET` | `/f42/services/:name` | **none** | Single-service status. A `WEBHOOK_TOKEN` may call this too. |
| `GET` | `/f42/services/:name/console?lines=200` | admin | Last N console lines (default 500). |
| `POST` | `/f42/services/:name/console` | admin | Send a console command, body `{ "command": "list" }`. |
| `POST` | `/f42/services/:name/start` | admin | Create the tmux session and launch the server. |
| `POST` | `/f42/services/:name/stop` | admin | Graceful stop, force-kill after 60s. |
| `POST` | `/f42/services/:name/restart` | admin | Stop then start. |
| `GET` | `/f42/services/:name/banned-players` | admin | Ban list entries. |
| `POST` | `/f42/services/:name/banned-players` | admin | Ban a player, body `{ "name": "Player", "reason?": "..." }`. |
| `DELETE` | `/f42/services/:name/banned-players/:player` | admin | Unban. |

Only the two status reads are public. The console and the ban list are not:
scrollback contains every UUID that has connected, and ban reasons are
moderation notes, so those stay behind `API_TOKEN`.

#### Files

Everything in this table needs `API_TOKEN`. Mod names and config file contents
are not status — a Forge or NeoForge config routinely holds database passwords,
API keys and webhook URLs.

| Method | Route | Description |
|---|---|---|
| `GET` | `/f42/services/:name/files` | List `<cwd>/mods`. |
| `POST` | `/f42/services/:name/files/upload` | Upload mods (multipart, 250 MB total). |
| `DELETE` | `/f42/services/:name/files/:file` | Delete a mod. |
| `POST` | `/f42/services/:name/files/:file/disable` | Rename `Foo.jar` → `Foo.jar.dis`. |
| `POST` | `/f42/services/:name/files/:file/enable` | Rename `Foo.jar.dis` → `Foo.jar`. |
| `GET` | `/f42/services/:name/config` | List `<cwd>/config` recursively, `.toml` only. Takes `?dir=`, `?recursive=0`, `?maxDepth=`, `?extensions=`. |
| `GET` | `/f42/services/:name/config/:file` | Read a config file (1 MB cap). `?view=raw` skips the reformatted copy. |
| `PUT` | `/f42/services/:name/config/:file` | Edit a file, body `{ "startLine", "endLine"?, "content" }` or `{ "search", "replace", "expect"? }`. Backs up first. |
| `POST` | `/f42/services/:name/config/:file` | Create/overwrite, body `{ "content": "..." }`. Backs up first. |
| `DELETE` | `/f42/services/:name/config/:file` | Delete a config file. |
| `GET` | `/f42/services/:name/server.properties` | Parsed `server.properties`. |
| `POST` | `/f42/services/:name/server.properties` | Patch keys, body `{ "properties": { "max-players": "50" } }`. Backs up first. |

#### Cores

Also `API_TOKEN` only.

| Method | Route | Description |
|---|---|---|
| `GET` | `/f42/services/:name/core` | Installed core, Minecraft version, available NeoForge builds, in-flight update. |
| `POST` | `/f42/services/:name/core` | Install a version, body `{ "version": "21.1.159" }`. Stops, installs, restarts. |

#### WebSockets

| Route | Description |
|---|---|
| `/f42/ws?service=:name&token=...` | Console stream: history, then live lines; send commands over the socket. |
| `/f42/root?token=...` | A real `sudo -i` root shell with the same message protocol. |

### Whitelist

Minecraft whitelists are per server, so joining one network usually means being
whitelisted on the proxy and every backend. This is the workflow that automates
it: a public form posts a name, an admin approves it once, and the bot types
`whitelist add <player>` into **every** configured service. The same section
then covers the other half — reading each server's real `whitelist.json` back,
so you can check a username without guessing.

#### 1. Anyone can ask — no key required

```
POST /f42/whitelist/request
Content-Type: application/json

{ "name": "Playername", "contact": "discord or email, optional" }
```

`name` must be 3–16 characters of letters, digits or underscore (a Minecraft
username). `contact` is free text up to 200 characters, stored for the admin's
benefit only. Anything else is a `400`.

| Status | Meaning |
|---|---|
| `202` | New request queued. |
| `200` | A request for that name already exists — `already: true`. No duplicate is created. |
| `429` | Over the hourly limit. Includes `Retry-After`. |

```json
{
  "status": "pending",
  "name": "Playername",
  "requestedAt": "2026-09-27T10:15:00.000Z",
  "already": false,
  "note": "Request received. An admin still has to approve it before you can join."
}
```

The limit is counted before the body is even parsed, so a flood of malformed
requests costs the caller their quota rather than the server its time. Each
request costs one slot whether or not it was valid, and a repeat request for a
name already in the queue is deduplicated rather than stored twice.

The response deliberately contains nothing about the server: no service names, no
whitelist contents, no IP address. The IP is recorded internally for abuse
tracking and is only visible to admins.

#### 2. An admin reviews the queue

```
GET /f42/whitelist/requests
x-api-key: $API_TOKEN
```

```json
{
  "requests": [
    {
      "name": "Playername",
      "contact": "discord or email, optional",
      "ip": "203.0.113.7",
      "status": "pending",
      "requestedAt": "2026-09-27T10:15:00.000Z",
      "decidedAt": null,
      "command": null,
      "services": null
    }
  ],
  "rateLimit": { "requestsPerHour": 5 }
}
```

`?status=pending` filters the list; without it you get every request the bot is
still tracking, oldest first.

#### 3. An admin approves — it runs on all services

```
POST /f42/whitelist/approve
x-api-key: $API_TOKEN
Content-Type: application/json

{ "name": "Playername" }
```

```json
{
  "command": "whitelist add Playername",
  "services": [
    { "name": "Survival", "running": true, "sent": true, "skipped": false, "error": null },
    { "name": "Creative", "running": true, "sent": true, "skipped": false, "error": null },
    { "name": "Lobby", "running": true, "sent": true, "skipped": false, "error": null },
    { "name": "Velocity", "running": null, "sent": false, "skipped": true, "error": null }
  ],
  "request": { "name": "Playername", "status": "approved", "decidedAt": "2026-09-27T10:20:00.000Z", "...": "..." },
  "note": "Ran \"whitelist add Playername\" on every whitelisting service. Skipped Velocity (\"whitelist\": false)."
}
```

Every service is attempted concurrently and reported separately, so a single
stuck session never blocks the rest. A service that is not running is reported
with `sent: false` and an `error`; it is **not** started for you — approve again
after it is up, which is safe because the command is idempotent.

Services with `"whitelist": false` in `config.json` are skipped here too, so
Velocity never gets a command it cannot answer. They are reported with
`"skipped": true` and left out of the `note` counts rather than counted as
failures.

> **Velocity has no built-in `whitelist` command**, which is why the shipped
> `config.json` sets `"whitelist": false` on it — with that set, approvals skip
> the proxy entirely instead of typing a command it will reject as unknown. If
> you *do* run a whitelist plugin on Velocity and want the bot to keep the proxy
> in sync, remove the opt-out; the plugin's command should be the same. Sending a
> console command is fire-and-forget, so `sent: true` confirms the keystrokes
> reached the console, not that the server understood them — check
> `GET /f42/services/Velocity/console` to read what a service actually said.

#### 4. An admin denies

```
POST /f42/whitelist/deny
x-api-key: $API_TOKEN
Content-Type: application/json

{ "name": "Playername" }
```

Marks the request `denied` and returns it. Denying does not touch the servers —
if the player was already approved and whitelisted, use the console to run
`whitelist remove <player>`. Both endpoints return `404` if there is no tracked
request for that name, which keeps them from becoming a way to act on arbitrary
usernames.

#### 5. Checking a username — no key required

The queue tells you who *asked*. These reads tell you who is *actually
whitelisted*, straight from each server's `whitelist.json` — the same file the
`whitelist add` command makes the server write. This is the check to run before
approving, the one to run when someone says they were approved but cannot join,
and the one a public page can poll to show someone their own status.

All three need no token, so they are meant to be called without one:

```
GET /f42/whitelist?player=Notch
```

```json
{
  "player": "Notch",
  "services": [
    { "name": "Survival", "skipped": false, "exists": true, "error": null, "whitelisted": true, "entry": { "uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5", "name": "Notch" } },
    { "name": "Creative", "skipped": false, "exists": true, "error": null, "whitelisted": false, "entry": null },
    { "name": "Lobby", "skipped": false, "exists": true, "error": null, "whitelisted": true, "entry": { "uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5", "name": "Notch" } },
    { "name": "Velocity", "skipped": true, "exists": false, "error": null, "whitelisted": false, "entry": null }
  ],
  "checkedServices": ["Survival", "Creative", "Lobby"],
  "whitelistedEverywhere": false
}
```

`whitelistedEverywhere` is the headline answer: `true` only when the player is on
every service that actually maintains a whitelist. `checkedServices` names
exactly which services that verdict was based on, and the two ways a service can
be left out of it are both explicit:

| Case | Reported as | Counted in the verdict |
|---|---|---|
| `"whitelist": false` in `config.json` | `"skipped": true` | No — you told the bot not to look there. |
| No `whitelist.json` on disk | `"exists": false` | No — nothing to check. |

Velocity is normally the first case, which is why the shipped `config.json` sets
`"whitelist": false` on it. Without that opt-out, a service that cannot answer
would otherwise drag `whitelistedEverywhere` down to a permanent `false`.

Per-service, without the cross-network verdict:

```
GET /f42/services/Survival/whitelist
```

```json
{
  "name": "Survival",
  "path": "/root/server/whitelist.json",
  "skipped": false,
  "exists": true,
  "count": 2,
  "players": [
    { "uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5", "name": "Notch" },
    { "uuid": "853c80ef-3c37-49fd-aa49-938b674adae6", "name": "jeb_" }
  ],
  "error": null
}
```

And the network-wide view, which is the union of every service's whitelist:

```
GET /f42/whitelist
```

```json
{
  "services": [ { "name": "Survival", "path": "...", "skipped": false, "exists": true, "count": 2, "players": [], "error": null } ],
  "players": ["jeb_", "Notch"]
}
```

Being unauthenticated, these three are limited to 60 per IP per minute
(`WHITELIST_READS_PER_MINUTE`, `0` disables) rather than the POST's 5 per hour.
They are read-only, but the bare `GET /f42/whitelist` does publish the whole
roster and every UUID in it to anyone who asks — `?player=` is the one that only
reveals a name the caller already knows, so prefer it for anything user-facing.

Reading the files:

- **`skipped`** is `true` when the service opted out via `"whitelist": false` in
  `config.json`. Its file is not even touched and the other fields are not
  meaningful. This is the switch to flip for Velocity, or for any service whose
  whitelist lives somewhere the bot should not be poking at.
- **`exists`** is `false` when an opted-in service has no `whitelist.json` yet,
  which is the normal state before anyone has been approved. It is deliberately
  *not* reported as an empty whitelist.
- **`whitelist` has to be a real boolean.** `config.json` is rejected at startup
  if the field is anything else, so `"whitelist": "false"` cannot quietly pass
  for an opt-out.
- **`error`** carries a message when the file exists but could not be read or
  parsed, so a broken file is never silently reported as "not whitelisted".
- **Entries with `"name": null`** are players the server recorded by UUID only.
  They appear in listings but can never match a name lookup, because the file
  does not say what they are called.
- **Names are matched case-insensitively**, and entries without dashes in the
  UUID are returned exactly as the server wrote them.
- **These are file reads, not console commands**, so they reflect what is on
  disk right now. Minecraft applies `whitelist add` immediately, so no restart
  is needed; but a service that is stopped still reports its last saved state,
  which may be stale.
- `WEBHOOK_TOKEN` is irrelevant here — these routes are public, so a webhook
  token is neither needed nor rejected.

#### Notes

- **The queue is in memory.** Pending requests do not survive a bot restart. The
  servers' own whitelists are unaffected — they are ordinary Minecraft files.
- **Names are case-insensitive.** `Notch` and `notch` are the same request, and
  the casing is preserved for the console command so the server stores the
  canonical name.
- **The queue is bounded** at 500 entries; the oldest decided request is dropped
  to make room for a new one. The hourly limit keeps this far away in practice.
- **No Discord UI.** Approvals are API-only today; point any admin panel, script
  or `curl` at it.

### Services and consoles

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

`GET /f42/services/:name` returns that same object for one service (`404` for an
unknown name). `:name` is matched case-insensitively against `config.json`.

`GET /f42/services/:name/console?lines=200`:

```json
{
  "name": "Survival",
  "running": true,
  "lines": ["[12:00:01 INFO]: Starting minecraft server version 1.21.1", "..."]
}
```

`POST /f42/services/:name/console` with `{ "command": "list" }`:

```json
{ "name": "Survival", "command": "list", "sent": true }
```

Commands are typed into the console literally (`tmux send-keys -l`), so a command
containing key names is not mangled. A stopped service returns `409` instead of
silently buffering keystrokes.

`POST /f42/services/:name/start` (also `stop` and `restart`):

```json
{ "name": "Survival", "action": "start", "result": "started", "running": true }
```

`result` is one of `already-running`, `started`, `already-stopped`, `stopped`,
`killed`, `restarted`, `killed-restarted` — `killed` means the graceful stop timed
out after 60 seconds.

Commands typed through the API are not echoed into `latest.log` by default
(Velocity has `log-command-executions = false`), so the WebSocket echoes them
back instead; see below.

### WebSockets

Both sockets use the same JSON frame protocol:

| Frame | Meaning |
|---|---|
| `{"type":"status", ...}` | Sent once on connect. |
| `{"type":"line","text":"..."}` | One console line. |
| `{"type":"echo","text":"..."}` | A command you sent was delivered. |
| `{"type":"error","error":"..."}` | Something went wrong. |

`/f42/ws?service=Survival&token=...` streams up to 500 lines of history, then
every new line live. Send `{"command":"list"}` to run a console command and get
an `echo` or `error` back on the same socket.

```
const ws = new WebSocket(`ws://127.0.0.1:8080/f42/ws?service=Survival&token=${token}`);
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.onopen = () => ws.send(JSON.stringify({ command: 'list' }));
```

`/f42/root?token=...` opens a real `sudo -i` login shell with the same protocol,
except commands are executed by bash rather than a server console: shell state
(cwd, environment, variables) persists between commands, and output streams back
as `line` frames. It connects with
`{"type":"status","name":"root","running":true,"shell":"sudo -i"}` and closes
after `exit`. There is no scrollback replay — it is a live terminal.

Keep the admin key out of shell history and browser history where you can; the
`?token=` form exists because browsers cannot set headers on a WebSocket
handshake. Prefer the `x-api-key` header from non-browser clients.

### Mods

Mods live in each service's `<cwd>/mods` directory, created on first upload.
Upload with `multipart/form-data`, where each `file` field keeps its original
filename; up to 250 MB total per request.

```
POST /f42/services/Survival/files/upload
x-api-key: $API_TOKEN
Content-Type: multipart/form-data

file=@/local/path/MyMod.jar
```

`201 { "name": "Survival", "uploaded": ["MyMod.jar"] }`

Listing:

```json
{
  "name": "Survival",
  "files": [
    { "name": "MyMod.jar", "size": 482031, "modified": "2026-09-15T10:30:00.000Z", "enabled": true },
    { "name": "OldMod.jar.dis", "size": 12984, "modified": "2026-09-01T08:12:00.000Z", "enabled": false }
  ]
}
```

Disabling renames `MyMod.jar` → `MyMod.jar.dis`, which the server skips;
enabling renames it back. Both are `POST` to
`/f42/services/:name/files/<filename>/disable` (or `/enable`), and deletion is
`DELETE /f42/services/:name/files/<filename>` — URL-encode the filename.

Filenames are validated against path traversal, and uploading into
subdirectories is not supported. A disabled file keeps a `.dis` suffix and
reports `"enabled": false`.

### server.properties

Each Minecraft server's `server.properties` lives at `<cwd>/server.properties`.
It is read and rewritten in place, preserving comments, ordering and blank
lines; the previous version is copied to `server.properties.bak` before each
write. Services without one (Velocity) get a `404`.

```
GET /f42/services/Survival/server.properties
```

```json
{
  "name": "Survival",
  "path": "/root/server/server.properties",
  "exists": true,
  "properties": { "max-players": "20", "gamemode": "survival", "view-distance": "12" }
}
```

```
POST /f42/services/Survival/server.properties
Content-Type: application/json

{ "properties": { "max-players": "50", "gamemode": "creative" } }
```

Only the listed keys change; `updated` echoes what was applied and `properties`
returns the full new state. Property names containing `=`, `:`, whitespace, `#`,
`!` or `\` are rejected with a `400`.

`server.properties` is read when the server starts, so changes take effect on the
next restart.

### Config files

Mod and plugin configs live in each service's `<cwd>/config` directory. Subpaths
are supported (`config/jei/something.toml`) and are validated against path
traversal.

Listing walks the whole tree, so `config/<mod>/` files come back without a second
request. A config directory is mostly *not* config — mods ship assets, locale
dumps, jars and world databases next to their settings — so a listing reports only
`.toml` files, plus the directories that hold them. `name` is always
relative to `<cwd>/config`, so any entry can be handed straight back as a request
path, and `depth` says how far below the listed directory it sits:

```
GET /f42/services/:name/config                        # .toml only, recursively
GET /f42/services/:name/config?recursive=0            # top level only
GET /f42/services/:name/config?dir=jei                # start inside a subdirectory
GET /f42/services/:name/config?maxDepth=2             # stop after 2 levels
GET /f42/services/:name/config?extensions=toml,json   # other extensions
GET /f42/services/:name/config?extensions=all         # everything, directories included
```

```json
{
  "name": "Survival",
  "path": "/root/server/config",
  "subdir": "",
  "recursive": true,
  "extensions": ["toml", "json"],
  "exists": true,
  "depth": 8,
  "count": 3,
  "truncated": false,
  "files": [
    { "name": "jei", "isDir": true, "size": 0, "modified": "2026-09-15T10:30:00.000Z", "depth": 0 },
    { "name": "jei/world", "isDir": true, "size": 0, "modified": "2026-09-15T10:30:00.000Z", "depth": 1 },
    { "name": "server.toml", "isDir": false, "size": 2314, "modified": "2026-09-15T10:30:00.000Z", "depth": 0 }
  ]
}
```

`?extensions` replaces the default filter (`.toml`); `all` turns it off and
lists every file, which is also the only mode where directories are reported
regardless of what they hold. With `?recursive=0` only that one level is listed,
and directories are always kept there so the tree can be walked by hand. At most
5000 entries come back; past that `truncated` is true. `?recursive=0`, `?dir=` and
`?maxDepth=` are combined freely.

Reading caps at 1 MB; anything larger returns `"truncated": true` with the first
1 MB. Alongside the byte-exact `content`, the response carries `format`,
`lineCount`, `lines` and `formatted`: a reformatted copy meant for reading and
for diffing in a panel. Nothing is ever written back from `formatted` — POST
always uses `content`, so a round-trip is byte-for-byte — and `?view=raw` omits
it entirely.

Mods tend to write TOML in NightConfig's style: tab-indented to one level per
table, with a `#.` separator line before every block. The reformatted copy drops
the separators, moves keys and `[table]` headers back to column 0 (TOML has no
indentation semantics), normalises `#Comment` to `# Comment`, wraps long comment
lines at 100 columns, and collapses runs of blank lines to one. The result
parses to exactly the same document, and anything inside a string value — tabs
included — is left byte-identical:

```json
{
  "service": "Survival",
  "name": "northstar-server.toml",
  "kind": "file",
  "format": "toml",
  "size": 1948,
  "lineCount": 29,
  "view": "clean",
  "truncated": false
}
```

Writing takes `{ "content": "..." }`, backs up to `:file.bak`, and returns `201`
for a new file or `200` for an overwrite. Missing parent directories are created,
so a first write to `config/newmod/client.toml` works. Deleting is
`DELETE /f42/services/:name/config/:file` with the path URL-encoded.
Directories cannot be read or deleted, and paths escaping `config/` are rejected
with a `400`.

To change part of a file without re-sending the whole thing, `PUT` the same path
with `startLine`/`endLine` (1-based, inclusive) and the `content` that replaces
them — `""` deletes the lines, and omitting `endLine` replaces one line:

```json
{ "startLine": 12, "endLine": 14, "content": "[general]\n  foo = true" }
```

`endLine` one below `startLine` inserts without removing anything, so
`{ "startLine": 1, "endLine": 0, "content": "# top of file\n" }` prepends and
`startLine: lineCount + 1` appends. Lines outside the range are copied through
unchanged, the file is backed up first, and the response reports the new
`lineCount`, `replacedLines` and `modified`. A range past the end of the file is
a `400` that names the file's real line count rather than writing something
wrong.

The same `PUT` takes `search`/`replace` instead, which needs no line numbers at
all — `search` is a literal substring and may span lines:

```json
{ "search": "  motd = \"hello\"", "replace": "  motd = \"survival\"", "expect": 1 }
```

`expect` is how many matches the caller thinks are in the file (1 by default) and
the write only happens when the file agrees. A key that got renamed or a setting
that appears in two tables therefore fails with a `400` telling you the real
count, rather than rewriting every occurrence. Nothing is written when the
replacement is identical to what was found (`"changed": false`), and the response
reports `matches`, `replaced`, `firstLine` and `lineCount`.

### Banned players

Each service's ban list lives at `<cwd>/banned-players.json` in the standard
Minecraft format. `GET` lists it, `POST` bans a player with
`{ "name": "Player", "reason?": "..." }` and `DELETE .../:player` unbans. The
bot resolves the UUID from Mojang's API at ban time; if the player has never
joined an online-mode server the ban still succeeds with an empty `uuid`.

These are file edits, not console commands, so they take effect on the next
server start unless the server re-reads the list itself.

### Server cores

For services with a `core` field, the bot can install the NeoForge **installer**
for a chosen version and run `java -jar ... --installServer` in the service's
`cwd`. That regenerates `run.sh`, `user_jvm_args.txt` and
`libraries/net/neoforged/neoforge/<version>/`, so the existing
`startCommand: "bash run.sh"` picks up the new version. Mods are untouched.

```
GET /f42/services/Survival/core
```

```json
{
  "name": "Survival",
  "type": "neoforge",
  "installed": "21.1.153",
  "mcVersion": "1.21.1",
  "latest": "21.1.159",
  "versions": ["21.1.159", "21.1.153", "..."],
  "busy": false,
  "lastUpdate": null
}
```

`options` (returned in the full response) shows the newest build per Minecraft
version; once the MC version is known, `versions` is the full list for that MC
line, newest first.

Installing takes a version and returns immediately, because the install can take
minutes (stop, download, run installer, start):

```
POST /f42/services/Survival/core
Content-Type: application/json

{ "version": "21.1.159" }
```

```json
{ "name": "Survival", "version": "21.1.159", "started": true, "note": "Core update started. Poll GET /f42/services/<name>/core to track it." }
```

Poll `GET .../core` — `busy` stays `true` while it runs, and a second `POST`
while busy is a `409`. The server is gracefully stopped, the installer is
downloaded and run, and the server is only brought back up if it was running
before. When it finishes, `lastUpdate` holds the outcome:

```json
{
  "installed": "21.1.159",
  "busy": false,
  "lastUpdate": {
    "version": "21.1.159",
    "startedAt": "2026-09-16T10:00:00.000Z",
    "finishedAt": "2026-09-16T10:03:12.000Z",
    "ok": true,
    "restarted": "restarted",
    "error": null,
    "output": "...installer output tail..."
  }
}
```

The MC version is derived from the installed NeoForge build (`21.1.x` →
Minecraft `1.21.1`); override it with `core.mcVersion` in `config.json`.
Downgrades and cross-MC switches work the same way — the previous install is
removed first, as the official install script does.

---

## Operations and security

- **No TLS.** The API server speaks plain HTTP and binds to loopback by default.
  If you expose it, put a reverse proxy in front of it and terminate TLS there.
- **Tokens are shared secrets** compared verbatim against a header, or against
  `?token=` on a WebSocket upgrade. There is no per-client identity, no scoping
  beyond the read-only webhook token, and no rotation mechanism — rotate by
  changing the env var and restarting.
- **`sudo` is passwordless and full.** The bot runs `sudo cat/cp/rm/mkdir/chattr`
  and a root shell, and file writes are `cp`'d over the original (clearing an
  immutable flag if needed). Anyone who can talk to the API can therefore read
  and write anything the root user can. Treat `API_TOKEN` as root on that host.
- **The root WebSocket is a root login shell.** `/f42/root` is the single most
  powerful endpoint here. If you do not need it, keep the API on loopback.
- **Path handling is centralised.** Filenames and config paths are validated
  against traversal in one place per module (`files.js`, `configFiles.js`), and
  all shell arguments are quoted in one helper (`root.js`).
- **Size caps** exist where a flood would hurt: 64 KB request bodies (512 KB for
  config writes), 250 MB uploads, 1 MB config reads, a 1500-line console ring
  buffer, a 1 MB log poll chunk, and a 5000-entry ceiling on a recursive config
  listing (8 levels deep at most).
- **The unauthenticated surface is six routes**: the two service status reads and
  the four whitelist ones. Three of them read `whitelist.json`, so anyone who can
  reach the API can read who is whitelisted and every whitelisted player's UUID
  — including the bare `GET /f42/whitelist`, which returns the whole roster. The
  status reads additionally publish each server's port, log path, player count
  and the names of who is online right now. None of it reveals IP addresses,
  contact details, queue state, credentials or the console. If any of that
  matters for your network, put those six behind the reverse proxy rather than
  exposing the API directly, or drop the bare whitelist GET.
- **The public list is one function.** `isPublicRequest` in `src/api.js`, right
  under the auth gate. Anything that is not named there is keyed, so widening
  the public surface is a one-line, reviewable change — and worth a second look,
  because the routes next to these ones (console scrollback, `config/:file`
  contents, ban reasons) are exactly the ones that hold secrets.
- **Logs follow the servers.** Typed commands are not written to `latest.log` by
  default, so command history is not retained server-side.

### Redeploying

```
POST /f42/refresh
x-api-key: $API_TOKEN
```

Runs `git stash && git pull` in the bot's own checkout, sends the response, then
triggers a detached `pm2 restart 0` so the restart outlives the process it is
killing. Uncommitted local changes are stashed, not committed — expect to pop
them after a redeploy.

---

## Running in the background

Keep the bot out of your SSH session's job control:

```sh
tmux new-session -d -s manage-bot 'npm start'
```

Or use pm2, which `POST /f42/refresh` assumes:

```sh
pm2 start src/index.js --name manage-bot
pm2 save
```

The bot re-detects running tmux sessions on startup, so it can be restarted or
redeployed at any time without touching the servers.

---

## Code layout

Plain ESM JavaScript on `node:http` and `ws` — no framework, no build step.
`npm start` runs `src/index.js`.

| Module | Responsibility |
|---|---|
| `index.js` | Bootstrap: load `.env`, start log tailing, player tracking and the API, log in, register commands. |
| `config.js` | Reads and validates `config.json` once at import. |
| `actions.js` | `startService` / `stopService` / `restartService` and the start/stop state. |
| `services.js` | Fan-out status snapshot across all services. |
| `tmux.js` | The only module that calls `tmux`. Every console command goes through `sendConsole`. |
| `state.js` | In-memory `serviceState` map (service index → `starting`/`stopping`). |
| `consoleLog.js` | Tails `latest.log` per service, keeps a ring buffer, detects rotation, reads log tails. |
| `players.js` | Parses join/leave lines into an online roster, persisted to `data/players.json`. |
| `dashboard.js` | Builds and edits the Discord embeds and control rows on a 30s loop. |
| `interactions.js` | Slash commands, buttons, modals, and the Discord permission checks. |
| `commands.js` | Slash command definitions and registration. |
| `panel.js` | Proxmox panel API client and usage formatting. |
| `api.js` | The HTTP + WebSocket API: routing, auth, body handling. |
| `whitelist.js` | Whitelist request queue, the all-services approve fan-out, and reads of each server's real `whitelist.json`. |
| `rateLimit.js` | Sliding-window rate limiter. |
| `files.js` | Mods directory: list, upload, delete, enable/disable. |
| `configFiles.js` | Config directory: recursive list, read (raw + reformatted), write, delete, path validation. |
| `properties.js` | `server.properties` parse/serialise preserving comments. |
| `bans.js` | `banned-players.json` CRUD with Mojang UUID lookup. |
| `cores.js` | NeoForge version list, download, installer run, status polling. |
| `shell.js` | The `sudo -i` root WebSocket shell. |
| `root.js` | Root-owned file operations, shell quoting, long-running root commands. |
| `mcping.js` | Minecraft Server List Ping. |
| `stats.js` | Duration formatting for embeds. |
| `webhook.js` | Start/stop notification POST. |

There is no test suite and no lint configuration; the code is plain
Node-standard JavaScript, so `node --check` on any file is a syntax check and the
running bot is the real test.
