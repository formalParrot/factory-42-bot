import http from 'node:http';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import config from './config.js';
import { catAsRoot, cpAsRoot, writePropertiesAsRoot } from './root.js';
import { sessionExists, sendConsole } from './tmux.js';
import { startService, stopService, restartService } from './actions.js';
import { getLastLines, latestLogPath, onLine } from './consoleLog.js';
import { getOnlinePlayers } from './players.js';
import { listFiles, uploadFiles, deleteFile, disableFile, enableFile } from './files.js';
import {
  listConfigFiles,
  readConfigFile,
  writeConfigFile,
  deleteConfigFile,
} from './configFiles.js';
import { entriesToObject, parseProperties, serializeProperties, setEntry } from './properties.js';
import { coreBusy, coreConfigured, getCoreStatus, listAllVersions, updateCore } from './cores.js';
import { listBannedPlayers, addBannedPlayer, removeBannedPlayer } from './bans.js';
import { attachRootShell } from './shell.js';
import { createRateLimiter } from './rateLimit.js';
import {
  approveRequest,
  checkPlayerEverywhere,
  createRequest,
  denyRequest,
  isValidPlayerName,
  listRequests,
  listWhitelistEverywhere,
  listWhitelistedPlayers,
} from './whitelist.js';

// Authenticated HTTP + WebSocket API exposing each service's console via its
// logs/latest.log. All routes are under /f42. Sending commands reuses the same
// tmux path the Discord controls use. The exception is the whitelist: its
// request intake and lookups are unauthenticated and rate limited instead, so
// a public page can submit a request and poll whether a player is whitelisted.

const HOST = process.env.API_HOST || '127.0.0.1';
const PORT = Number(process.env.API_PORT || 8080);
const TOKEN = process.env.API_TOKEN;
const AUTH_HEADER = (process.env.API_HEADER || 'x-api-key').toLowerCase();
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;
const WEBHOOK_HEADER = (process.env.WEBHOOK_HEADER || 'x-webhook-token').toLowerCase();
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
// Clamped so a typo in .env cannot disable the limiter (NaN compares false
// against every count) or lock the endpoint out entirely.
const WHITELIST_REQUESTS_PER_HOUR = Math.max(1, Number(process.env.WHITELIST_REQUESTS_PER_HOUR) || 5);
// The public lookups are polled rather than submitted, so they get their own,
// far more generous limit. 0 disables it; see rejectIfRateLimited.
const WHITELIST_READS_PER_MINUTE = Number(process.env.WHITELIST_READS_PER_MINUTE ?? 60);
const WHITELIST_STATUSES = ['pending', 'approved', 'denied'];
const WS_HISTORY_LINES = 500;
const MAX_BODY = 64 * 1024;
const MAX_CONFIG_BODY = 512 * 1024;
const KEY_RE = /^[^=:#!\s\\]+$/;
const REPO_DIR = fileURLToPath(new URL('../', import.meta.url));
const execAsync = promisify(exec);

const startedAt = Date.now();

const whitelistLimiter = createRateLimiter({
  limit: WHITELIST_REQUESTS_PER_HOUR,
  windowMs: 60 * 60 * 1000,
});

const whitelistReadLimiter =
  WHITELIST_READS_PER_MINUTE > 0
    ? createRateLimiter({ limit: WHITELIST_READS_PER_MINUTE, windowMs: 60 * 1000 })
    : null;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`body too large (> ${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, maxBytes = MAX_BODY) {
  return JSON.parse((await readBody(req, maxBytes)).toString('utf8') || '{}');
}

function authorized(req) {
  return Boolean(TOKEN) && req.headers[AUTH_HEADER] === TOKEN;
}

function authorizedByWebhook(req) {
  return Boolean(WEBHOOK_TOKEN) && req.headers[WEBHOOK_HEADER] === WEBHOOK_TOKEN;
}

function authorizedByToken(req) {
  if (!TOKEN) return false;
  const url = new URL(req.url, 'http://localhost');
  return req.headers[AUTH_HEADER] === TOKEN || url.searchParams.get('token') === TOKEN;
}

function findService(name) {
  const needle = String(name).toLowerCase();
  return config.services.findIndex((s) => s.name.toLowerCase() === needle);
}

function resolveServiceOr(res, name, callback) {
  const index = findService(name);
  if (index === -1) return json(res, 404, { error: `Service "${name}" not found.` });
  return callback(index);
}

async function runningFor(index) {
  return sessionExists(config.services[index].tmuxSession);
}

// Rate-limit bucket for the caller. x-forwarded-for is only honoured when
// TRUST_PROXY is set, because a client can put anything in that header and
// would otherwise be able to mint an unlimited number of buckets for itself.
function clientKey(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Applies the (deliberately loose) limit on the public whitelist lookups, which
// exist to be polled. Every lookup costs a sudo read per service, so this only
// exists to stop a flood, not to ration use. Responds 429 and returns true when
// the caller is over the limit.
function rejectIfRateLimited(req, res) {
  if (!whitelistReadLimiter) return false;
  const result = whitelistReadLimiter.check(clientKey(req));
  if (result.allowed) return false;
  const retryAfter = Math.ceil(result.retryAfterMs / 1000);
  res.setHeader('Retry-After', String(retryAfter));
  json(res, 429, {
    error: `Rate limit exceeded: ${whitelistReadLimiter.limit} whitelist lookups per minute. Try again in ${retryAfter}s.`,
    retryAfterSeconds: retryAfter,
  });
  return true;
}

async function handleRequest(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  const method = req.method;

  if (parts[0] !== 'f42') return json(res, 404, { error: 'Not found.' });

  const [resource, name, action] = parts.slice(1);

  // ── Whitelist: public ──────────────────────────────────────────────────
  // These take no key so a public page can post a request and poll whether a
  // player is whitelisted yet. The POST is rate limited hard because it writes
  // to the queue; the GETs are limited loosely because they only read, and
  // polling them is the intended use. Anything else under /f42/whitelist falls
  // through to the auth check below.
  if (resource === 'whitelist' && (name === 'request' || !name)) {
    // POST /f42/whitelist/request — queue a request for an admin to action.
    if (name === 'request') {
      if (method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
      const key = clientKey(req);
      const limit = whitelistLimiter.check(key);
      if (!limit.allowed) {
        const retryAfter = Math.ceil(limit.retryAfterMs / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        return json(res, 429, {
          error: `Rate limit exceeded: ${whitelistLimiter.limit} whitelist requests per hour. Try again in ${retryAfter}s.`,
          retryAfterSeconds: retryAfter,
        });
      }

      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        return json(res, 400, { error: `Could not read JSON body: ${err.message}` });
      }
      const playerName = typeof body.name === 'string' ? body.name.trim() : '';
      if (!playerName) return json(res, 400, { error: 'Missing "name" string in body, e.g. {"name":"Playername"}.' });
      if (!isValidPlayerName(playerName)) {
        return json(res, 400, { error: 'Name must be 3-16 characters of letters, digits or underscore.' });
      }

      const { request, already } = createRequest(playerName, body.contact, key);
      return json(res, already ? 200 : 202, {
        status: request.status,
        name: request.name,
        requestedAt: request.requestedAt,
        already,
        note: 'Request received. An admin still has to approve it before you can join.',
      });
    }

    // GET /f42/whitelist?player=Notch — where a player stands, per service,
    // read from each server's own whitelist.json. Without ?player it is the
    // network-wide view instead.
    if (method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    if (rejectIfRateLimited(req, res)) return;
    const player = (new URL(req.url, 'http://localhost').searchParams.get('player') || '').trim();
    if (!player) return json(res, 200, await listWhitelistEverywhere());
    if (!isValidPlayerName(player)) {
      return json(res, 400, { error: 'Name must be 3-16 characters of letters, digits or underscore.' });
    }
    return json(res, 200, await checkPlayerEverywhere(player));
  }

  // GET /f42/services/:name/whitelist — one server's whitelist, public for the
  // same reason as /f42/whitelist, and rate limited by the same bucket.
  if (resource === 'services' && name && parts[3] === 'whitelist' && !parts[4] && method === 'GET') {
    if (rejectIfRateLimited(req, res)) return;
    return resolveServiceOr(res, name, async (index) => {
      const result = await listWhitelistedPlayers(index);
      return json(res, 200, { name: config.services[index].name, ...result });
    });
  }

  const fullAuth = authorized(req);
  const webhookAuth = authorizedByWebhook(req);
  if (!fullAuth && !webhookAuth) return json(res, 401, { error: 'Unauthorized.' });

  // Webhook tokens are limited to reading a single service's status, nothing else.
  if (webhookAuth && !fullAuth) {
    const allowed = resource === 'services' && name && !action && method === 'GET';
    if (!allowed) return json(res, 403, { error: 'Forbidden.' });
  }

  if (resource === 'health') {
    if (method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    return json(res, 200, { ok: true, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
  }

  // ── Whitelist: admin ────────────────────────────────────────────────────
  // The public request intake and lookups are handled above, before the auth
  // gate; what remains is the queue and the approvals.
  if (resource === 'whitelist') {
    if (name === 'requests' && !action) {
      if (method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
      const status = (new URL(req.url, 'http://localhost').searchParams.get('status') || '')
        .trim()
        .toLowerCase();
      if (status && !WHITELIST_STATUSES.includes(status)) {
        return json(res, 400, { error: `Unknown status "${status}". Use one of: ${WHITELIST_STATUSES.join(', ')}.` });
      }
      return json(res, 200, {
        requests: listRequests(status),
        rateLimit: { requestsPerHour: whitelistLimiter.limit },
      });
    }

    // Approve and deny both take the player name in the body rather than the
    // path so the caller never has to URL-encode a username.
    if ((name === 'approve' || name === 'deny') && !action) {
      if (method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        return json(res, 400, { error: `Could not read JSON body: ${err.message}` });
      }
      const playerName = typeof body.name === 'string' ? body.name.trim() : '';
      if (!playerName) return json(res, 400, { error: 'Missing "name" string in body, e.g. {"name":"Playername"}.' });
      if (!isValidPlayerName(playerName)) {
        return json(res, 400, { error: 'Name must be 3-16 characters of letters, digits or underscore.' });
      }

      if (name === 'deny') {
        const request = denyRequest(playerName);
        if (!request) {
          return json(res, 404, { error: `No whitelist request found for "${playerName}".` });
        }
        return json(res, 200, { request });
      }

      const result = await approveRequest(playerName);
      if (!result) {
        return json(res, 404, { error: `No whitelist request found for "${playerName}".` });
      }
      const skipped = result.services.filter((service) => service.skipped);
      const failed = result.services.filter((service) => !service.sent && !service.skipped);
      const skippedNote = skipped.length > 0 ? ` Skipped ${skipped.map((s) => s.name).join(', ')} ("whitelist": false).` : '';
      return json(res, 200, {
        command: result.command,
        services: result.services,
        request: result.request,
        note:
          (failed.length === 0
            ? `Ran "${result.command}" on every whitelisting service.`
            : `Ran "${result.command}" on ${result.services.length - failed.length - skipped.length}/${result.services.length - skipped.length} services; check the console of the others.`) + skippedNote,
      });
    }

    return json(res, 404, { error: 'Not found.' });
  }

  if (resource === 'refresh' && method === 'POST') {
    try {
      const { stdout, stderr } = await execAsync('git stash && git pull', { cwd: REPO_DIR });
      // Respond first, then restart via pm2 (detached so it survives this process dying).
      res.once('finish', () => {
        spawn('pm2', ['restart', '0'], { detached: true, stdio: 'ignore' }).unref();
      });
      return json(res, 200, { ok: true, restarting: true, gitPull: [stdout, stderr].filter(Boolean).join('') });
    } catch (err) {
      return json(res, 502, { ok: false, error: `git pull failed: ${err.stderr?.trim?.() || err.message}` });
    }
  }

  if (resource === 'services' && parts.length === 2) {
    if (method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    const services = await Promise.all(
      config.services.map(async (service, index) => ({
        name: service.name,
        running: await runningFor(index),
        port: service.ping?.port ?? null,
        latestLog: latestLogPath(index),
        playerCount: getOnlinePlayers(index).length,
        players: getOnlinePlayers(index),
      })),
    );
    return json(res, 200, { services });
  }

  if (resource === 'ws') return json(res, 404, { error: 'Use the WebSocket endpoint at /f42/ws?service=<name>.' });

  if (resource === 'root') return json(res, 404, { error: 'Use the WebSocket endpoint at /f42/root.' });

  if (resource === 'services' && name && !action) {
    if (method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    return resolveServiceOr(res, name, async (index) => {
      const running = await runningFor(index);
      return json(res, 200, {
        name: config.services[index].name,
        running,
        port: config.services[index].ping?.port ?? null,
        latestLog: latestLogPath(index),
        playerCount: getOnlinePlayers(index).length,
        players: getOnlinePlayers(index),
      });
    });
  }

  if (resource === 'services' && name && action === 'console') {
    return resolveServiceOr(res, name, async (index) => {
      if (method === 'GET') {
        const running = await runningFor(index);
        const linesParam = Number(new URL(req.url, 'http://localhost').searchParams.get('lines'));
        const lines = Number.isFinite(linesParam) && linesParam > 0 ? Math.floor(linesParam) : WS_HISTORY_LINES;
        return json(res, 200, { name: config.services[index].name, running, lines: getLastLines(index, lines) });
      }
      if (method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const command = typeof body.command === 'string' ? body.command.trim() : '';
        if (!command) return json(res, 400, { error: 'Missing "command" string in body.' });
        if (!(await runningFor(index))) {
          return json(res, 409, { error: `${config.services[index].name} is not running.` });
        }
        await sendConsole(config.services[index].tmuxSession, command);
        return json(res, 200, { name: config.services[index].name, command, sent: true });
      }
      return json(res, 405, { error: 'Method not allowed.' });
    });
  }

  if (resource === 'services' && name && ['start', 'stop', 'restart'].includes(action)) {
    if (method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
    return resolveServiceOr(res, name, async (index) => {
      const result =
        action === 'start' ? await startService(index) : action === 'stop' ? await stopService(index) : await restartService(index);
      const running = await runningFor(index);
      return json(res, 200, { name: config.services[index].name, action, result, running });
    });
  }

  // ── File management ────────────────────────────────────────────────────
  if (resource === 'services' && name && parts[3] === 'files') {
    return resolveServiceOr(res, name, async (index) => {
      const modsDir = `${config.services[index].cwd}/mods`;
      const fileAction = parts[4]; // undefined | 'upload' | <filename>
      const subAction = parts[5];  // undefined | 'disable' | 'enable'

      // GET /f42/services/<name>/files — list
      if (!fileAction && method === 'GET') {
        const files = await listFiles(modsDir);
        return json(res, 200, { name: config.services[index].name, files });
      }

      // POST /f42/services/<name>/files/upload — upload
      if (fileAction === 'upload' && !subAction && method === 'POST') {
        const result = await uploadFiles(req, modsDir);
        if (result.error) return json(res, 400, { error: result.error });
        return json(res, 201, { name: config.services[index].name, ...result });
      }

      // DELETE /f42/services/<name>/files/<filename> — delete
      if (fileAction && !subAction && method === 'DELETE') {
        const result = await deleteFile(modsDir, fileAction);
        if (result.error) return json(res, result.error.includes('not found') ? 404 : 400, result);
        return json(res, 200, { name: config.services[index].name, ...result });
      }

      // POST /f42/services/<name>/files/<filename>/disable — disable
      if (fileAction && subAction === 'disable' && method === 'POST') {
        const result = await disableFile(modsDir, fileAction);
        if (result.error) return json(res, result.error.includes('not found') ? 404 : 400, result);
        return json(res, 200, { name: config.services[index].name, ...result });
      }

      // POST /f42/services/<name>/files/<filename>/enable — enable
      if (fileAction && subAction === 'enable' && method === 'POST') {
        const result = await enableFile(modsDir, fileAction);
        if (result.error) return json(res, result.error.includes('not found') ? 404 : 400, result);
        return json(res, 200, { name: config.services[index].name, ...result });
      }

      return json(res, 405, { error: 'Method not allowed.' });
    });
  }

  // ── server.properties ───────────────────────────────────────────────────
  if (resource === 'services' && name && parts[3] === 'server.properties' && !parts[4]) {
    return resolveServiceOr(res, name, async (index) => {
      const path = `${config.services[index].cwd}/server.properties`;

      if (method === 'GET') {
        let text;
        try {
          text = await catAsRoot(path);
        } catch (err) {
          if (/No such file or directory/.test(err.stderr || err.message)) {
            return json(res, 404, { error: `server.properties not found for service "${config.services[index].name}".` });
          }
          throw err;
        }
        const entries = parseProperties(text);
        return json(res, 200, {
          name: config.services[index].name,
          path,
          exists: true,
          properties: entriesToObject(entries),
        });
      }

      if (method === 'POST') {
        let exists;
        try {
          await catAsRoot(path);
          exists = true;
        } catch {
          exists = false;
        }
        if (!exists) {
          return json(res, 404, { error: `server.properties not found for service "${config.services[index].name}".` });
        }

        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const updates = body.properties;
        if (!updates || typeof updates !== 'object' || Array.isArray(updates) || Object.keys(updates).length === 0) {
          return json(res, 400, { error: 'Body must contain a non-empty "properties" object, e.g. {"properties":{"max-players":"20"}}.' });
        }

        const invalid = Object.keys(updates).filter((key) => !KEY_RE.test(key));
        if (invalid.length > 0) {
          return json(res, 400, { error: `Invalid property name(s): ${invalid.join(', ')}.` });
        }

        const text = await catAsRoot(path);
        const entries = parseProperties(text);
        const applied = {};
        for (const [key, value] of Object.entries(updates)) {
          setEntry(entries, key, String(value));
          applied[key] = String(value);
        }
        await cpAsRoot(path, `${path}.bak`);
        await writePropertiesAsRoot(path, serializeProperties(entries));

        return json(res, 200, {
          name: config.services[index].name,
          path,
          exists: true,
          updated: applied,
          properties: entriesToObject(entries),
        });
      }

      return json(res, 405, { error: 'Method not allowed.' });
    });
  }

  // ── Config files ────────────────────────────────────────────────────────
  // GET  /f42/services/<name>/config            — list files in <cwd>/config
  // GET  /f42/services/<name>/config/<file>     — read a file's contents
  // POST /f42/services/<name>/config/<file>     — create/overwrite (backs up first)
  // DELETE /f42/services/<name>/config/<file>   — delete a file
  if (resource === 'services' && name && parts[3] === 'config') {
    const filePath = parts[4] ? decodeURIComponent(parts.slice(4).join('/')) : '';

    if (!filePath) {
      return resolveServiceOr(res, name, async (index) => {
        if (method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
        const result = await listConfigFiles(config.services[index].cwd);
        return json(res, 200, { name: config.services[index].name, ...result });
      });
    }

    return resolveServiceOr(res, name, async (index) => {
      const serviceName = config.services[index].name;

      if (method === 'GET') {
        const result = await readConfigFile(config.services[index].cwd, filePath);
        if (result.error) {
          return json(res, result.error.includes('not found') ? 404 : 400, { name: serviceName, error: result.error });
        }
        return json(res, 200, { name: serviceName, ...result });
      }

      if (method === 'POST') {
        let body;
        try {
          body = JSON.parse((await readBody(req, MAX_CONFIG_BODY)).toString('utf8') || '{}');
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
        if (typeof body.content !== 'string') {
          return json(res, 400, { error: 'Body must contain a "content" string, e.g. {"content":"..."}.' });
        }
        const result = await writeConfigFile(config.services[index].cwd, filePath, body.content);
        if (result.error) {
          return json(res, 400, { name: serviceName, error: result.error });
        }
        return json(res, result.created ? 201 : 200, { name: serviceName, ...result });
      }

      if (method === 'DELETE') {
        const result = await deleteConfigFile(config.services[index].cwd, filePath);
        if (result.error) {
          return json(res, result.error.includes('not found') ? 404 : 400, { name: serviceName, error: result.error });
        }
        return json(res, 200, { name: serviceName, ...result });
      }

      return json(res, 405, { error: 'Method not allowed.' });
    });
  }

  // ── Server cores (NeoForge) ─────────────────────────────────────────────
  if (resource === 'services' && name && parts[3] === 'core' && !parts[4]) {
    return resolveServiceOr(res, name, async (index) => {
      if (!coreConfigured(index)) {
        return json(res, 404, {
          error: `No core configured for service "${config.services[index].name}". Add e.g. "core": {"type":"neoforge"} to config.json.`,
        });
      }
      if (method === 'GET') {
        return json(res, 200, await getCoreStatus(index));
      }
      if (method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const version = typeof body.version === 'string' ? body.version.trim() : '';
        if (!version) {
          return json(res, 400, { error: 'Missing "version" string in body, e.g. {"version":"21.1.153"}.' });
        }
        if (coreBusy(index)) {
          return json(res, 409, { error: `A core update for "${config.services[index].name}" is already in progress.` });
        }
        try {
          const all = await listAllVersions();
          if (!all.includes(version)) {
            return json(res, 400, {
              error: `Unknown NeoForge version "${version}". List available versions with GET /f42/services/${config.services[index].name}/core.`,
            });
          }
        } catch (err) {
          return json(res, 502, { error: `Could not fetch NeoForge versions: ${err.message}` });
        }
        // The install can take minutes (stop + download + installer + start), so
        // ack immediately and let the caller poll GET /core for progress.
        updateCore(index, version).catch((err) => {
          console.error(`Core update for ${config.services[index].name} failed:`, err);
        });
        return json(res, 200, {
          name: config.services[index].name,
          version,
          started: true,
          note: 'Core update started. Poll GET /f42/services/<name>/core to track it.',
        });
      }
      return json(res, 405, { error: 'Method not allowed.' });
    });
  }

  // ── Banned players ──────────────────────────────────────────────
  if (resource === 'services' && name && parts[3] === 'banned-players') {
    return resolveServiceOr(res, name, async (index) => {
      if (method === 'GET') {
        const banned = await listBannedPlayers(index);
        return json(res, 200, { name: config.services[index].name, banned });
      }
      if (method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const playerName = typeof body.name === 'string' ? body.name.trim() : '';
        if (!playerName) return json(res, 400, { error: 'Missing "name" string in body.' });
        const reason = typeof body.reason === 'string' ? body.reason : '';
        const result = await addBannedPlayer(index, playerName, reason);
        return json(res, 201, { name: config.services[index].name, ...result });
      }
      if (method === 'DELETE') {
        const playerName = parts[4];
        if (!playerName) return json(res, 400, { error: 'Missing player name in URL.' });
        const result = await removeBannedPlayer(index, decodeURIComponent(playerName));
        return json(res, result.removed ? 200 : 404, { name: config.services[index].name, ...result });
      }
      return json(res, 405, { error: 'Method not allowed.' });
    });
  }

  return json(res, 404, { error: 'Not found.' });
}

function attachConsoleSocket(wss, ws, index) {
  const { name, tmuxSession } = config.services[index];
  const send = (payload) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  runningFor(index).then((running) => {
    send({ type: 'status', name, running });
    if (!running) return;
    for (const line of getLastLines(index, WS_HISTORY_LINES)) {
      send({ type: 'line', text: line });
    }
  });

  const unsubscribe = onLine(index, (text) => send({ type: 'line', text }));

  ws.on('message', async (data) => {
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return send({ type: 'error', error: 'Messages must be JSON, e.g. {"command":"list"}.' });
    }
    if (typeof message.command !== 'string' || !message.command.trim()) {
      return send({ type: 'error', error: 'Send {"command":"..."} to run a console command.' });
    }
    if (!(await runningFor(index))) {
      return send({ type: 'error', error: `${name} is not running.` });
    }
    try {
      await sendConsole(tmuxSession, message.command.trim());
      send({ type: 'echo', text: message.command.trim() });
    } catch (err) {
      send({ type: 'error', error: err.message });
    }
  });

  ws.on('close', unsubscribe);
  ws.on('error', () => {});
}

export function startApiServer() {
  if (!TOKEN) {
    throw new Error(
      'API_TOKEN is not set. Copy .env.example to .env and set API_TOKEN to enable the /f42 console API.',
    );
  }

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      await handleRequest(req, res, pathname);
    } catch (err) {
      json(res, 500, { error: err.message || 'Internal error.' });
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/f42/ws' && url.pathname !== '/f42/root') {
      socket.destroy();
      return;
    }
    if (!authorizedByToken(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname === '/f42/root') {
      wss.handleUpgrade(req, socket, head, (ws) => attachRootShell(ws));
      return;
    }
    const index = findService(url.searchParams.get('service'));
    if (index === -1) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachConsoleSocket(wss, ws, index));
  });

  server.listen(PORT, HOST, () => {
    console.log(`Console API listening on http://${HOST}:${PORT}/f42`);
  });

  return server;
}
