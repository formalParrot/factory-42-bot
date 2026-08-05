# server-manage-bot

Discord bot that manages a Velocity proxy and a Minecraft server running in tmux sessions on the same machine. It provides a live dashboard embed with per-service status, CPU, RAM, uptime and player count, plus Start / Stop / Restart buttons.

## Requirements

- Node.js 18+
- tmux
- The bot must run on the same machine as the Minecraft server and Velocity, under a user that can run `tmux`, `ps` and `pgrep`.

## Setup

1. Create an application at the Discord Developer Portal, add a Bot, and copy its token.
2. Invite the bot to your server with the `bot` and `applications.commands` scopes and permission to send messages in the status channel.
3. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` (and optionally `GUILD_ID` for instant command registration).
4. Edit `config.json`:
   - `adminRoleId` — role allowed to use the control buttons (server administrators are always allowed).
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

6. In Discord, run `/dashboard setup` in the channel where the dashboard should live. The embed updates every 30 seconds.

## Commands

| Command | Access | Description |
|---|---|---|
| `/dashboard setup` | Admin | Posts the live dashboard in the current channel. Auto-updates every 30 seconds with status, CPU, RAM, uptime and player count per service. |
| `/status` | Everyone | One-time status snapshot of all services. |
| `/announce [channel]` | Admin | Opens a form (title + multi-line message) and posts it as an embed in the chosen channel (defaults to the current one). |
| `/modpack file: [channel]` | Admin | Attach a `.mrpack`/`.zip`, then fill in a version + changelog form. Posts an embed with the changelog and the file attached for download. |

"Admin" means members with the `adminRoleId` role from `config.json`, or the server Administrator permission.

### Dashboard buttons (admin only)

Each service on the dashboard has its own row:

- **Start** — creates the tmux session and launches the server. Disabled while running.
- **Stop** — asks for confirmation, then sends the graceful stop command; force-kills after 60 seconds. Disabled while offline.
- **Restart** — asks for confirmation, then stops and starts the service. Disabled while offline.

## Behavior notes

- tmux is the process supervisor, not the bot: restarting or crashing the bot never stops the servers. On startup the bot re-detects running sessions and resumes the dashboard.
- Stop is graceful: the bot types the stop command into the server console and waits up to 60 seconds before force-killing the session.
- Stop and Restart ask for confirmation, since they disconnect online players.
- CPU/RAM are measured on the actual java process found inside the tmux session; uptime comes from `ps` so it stays correct across bot restarts.

## Running the bot itself in the background

Run the bot under its own tmux session or a process manager, e.g.:

```sh
tmux new-session -d -s manage-bot 'npm start'
```
