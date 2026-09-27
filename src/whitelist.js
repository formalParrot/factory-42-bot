// Two things live here, both about the whitelist:
//
//  1. The request queue. Anyone can ask to be whitelisted through the public
//     endpoint (rate limited, no key); an admin then approves or denies.
//     Approving types the same `whitelist add <player>` command into every
//     configured service console, which is how each server's own whitelist is
//     maintained. The queue is in-memory like the rest of the bot's transient
//     state, so pending requests do not survive a bot restart — approvals are
//     not lost by that, since the servers keep their whitelists either way.
//
//  2. Reads of the servers' real whitelists (`<cwd>/whitelist.json`), so an
//     admin can see who is actually able to join rather than who merely asked.
//     Velocity has no such file — it delegates whitelisting to a plugin — so
//     those reads report `exists: false` rather than pretending it is empty.
//
// A service opts out of the whole feature with `"whitelist": false` in
// config.json. Skipped services are never read from disk and never sent the
// `whitelist add` command, and every response says so explicitly with
// `skipped: true`, so a caller can tell "not whitelisted" from "we don't check
// there" instead of guessing.
import { join } from 'node:path';
import config from './config.js';
import { sendConsole, sessionExists } from './tmux.js';
import { catAsRoot, existsAsRoot } from './root.js';

// Strict false comparison, so a typo like "whitelist": "no" cannot accidentally
// look like an opt-out; config.js rejects non-booleans at load time.
function isWhitelistEnabled(index) {
  return config.services[index].whitelist !== false;
}

// Minecraft usernames: 3-16 characters, no spaces or punctuation.
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const MAX_CONTACT_LENGTH = 200;
// Keeps the queue bounded even though intake is rate limited per IP.
const MAX_TRACKED = 500;

const STATUS = { PENDING: 'pending', APPROVED: 'approved', DENIED: 'denied' };

// Lowercased player name -> request record. Insertion order is request order.
const requests = new Map();

const key = (name) => String(name).toLowerCase();

export function isValidPlayerName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function trimOldest() {
  for (const [k, request] of requests) {
    if (request.status !== STATUS.PENDING) {
      requests.delete(k);
      return;
    }
  }
  // Every tracked request is still pending; drop the oldest of those instead.
  const oldest = requests.keys().next();
  if (!oldest.done) requests.delete(oldest.value);
}

// Newest-last so admin listings read oldest-first.
export function listRequests(status) {
  const all = [...requests.values()];
  return status ? all.filter((request) => request.status === status) : all;
}

export function getRequest(name) {
  return requests.get(key(name)) ?? null;
}

export function createRequest(name, contact, ip) {
  const existing = requests.get(key(name));
  if (existing) return { request: existing, already: true };
  const request = {
    name,
    contact: typeof contact === 'string' ? contact.trim().slice(0, MAX_CONTACT_LENGTH) : '',
    ip: ip || '',
    status: STATUS.PENDING,
    requestedAt: new Date().toISOString(),
    decidedAt: null,
    command: null,
    services: null,
  };
  if (requests.size >= MAX_TRACKED) trimOldest();
  requests.set(key(name), request);
  return { request, already: false };
}

export function denyRequest(name) {
  const request = requests.get(key(name));
  if (!request) return null;
  request.status = STATUS.DENIED;
  request.decidedAt = new Date().toISOString();
  return request;
}

// Runs the whitelist command on every service that actually maintains a
// whitelist, and reports each one separately, so the caller can see which
// consoles took the command and which did not. Re-approving is allowed: it
// simply runs the command again.
export async function approveRequest(name) {
  const request = requests.get(key(name));
  if (!request) return null;
  const command = `whitelist add ${request.name}`;
  const services = await Promise.all(
    config.services.map(async (service, index) => {
      if (!isWhitelistEnabled(index)) {
        return { name: service.name, running: null, sent: false, skipped: true, error: null };
      }
      const running = await sessionExists(service.tmuxSession);
      if (!running) {
        return { name: service.name, running: false, sent: false, skipped: false, error: 'Service is not running.' };
      }
      try {
        await sendConsole(service.tmuxSession, command);
        return { name: service.name, running: true, sent: true, skipped: false, error: null };
      } catch (err) {
        return { name: service.name, running: true, sent: false, skipped: false, error: err.message };
      }
    }),
  );
  request.status = STATUS.APPROVED;
  request.decidedAt = new Date().toISOString();
  request.command = command;
  request.services = services;
  return { request, command, services };
}

// ── The servers' real whitelists ────────────────────────────────────────
// Standard Minecraft format: an array of { uuid, name } entries. Some servers
// have historically written bare UUID strings, so those are accepted too and
// reported with a null name.
function normalizeEntry(entry) {
  if (typeof entry === 'string') return entry ? { uuid: entry, name: null } : null;
  if (!entry || typeof entry !== 'object') return null;
  const uuid = typeof entry.uuid === 'string' ? entry.uuid : '';
  const name = typeof entry.name === 'string' && entry.name ? entry.name : null;
  return uuid || name ? { uuid, name } : null;
}

function whitelistPath(index) {
  return join(config.services[index].cwd, 'whitelist.json');
}

async function readWhitelist(index) {
  try {
    const parsed = JSON.parse(await catAsRoot(whitelistPath(index)));
    if (!Array.isArray(parsed)) return { players: [], error: 'whitelist.json is not a JSON array.' };
    return { players: parsed.map(normalizeEntry).filter(Boolean), error: null };
  } catch (err) {
    // A missing file is the normal state for a server nobody has approved yet,
    // so it is not an error. Anything else is reported rather than swallowed,
    // because silently reading it as "not whitelisted" would be a wrong answer.
    const message = err.stderr || err.message;
    return { players: [], error: /No such file/.test(message) ? null : message };
  }
}

// One service's whitelist. `exists` distinguishes "the server has never had a
// whitelist" from "the whitelist is genuinely empty", which are very different
// things to an admin. `skipped` marks a service that opted out via config.
export async function listWhitelistedPlayers(index) {
  const path = whitelistPath(index);
  if (!isWhitelistEnabled(index)) {
    return { path, skipped: true, exists: false, count: 0, players: [], error: null };
  }
  const [{ players, error }, exists] = await Promise.all([
    readWhitelist(index),
    existsAsRoot(path),
  ]);
  return { path, skipped: false, exists, count: players.length, players, error };
}

export async function checkPlayerOnService(index, name) {
  const { players, exists, error, skipped } = await listWhitelistedPlayers(index);
  const needle = String(name).toLowerCase();
  const entry = players.find((player) => (player.name ?? '').toLowerCase() === needle) ?? null;
  return { name: config.services[index].name, skipped, exists, error, whitelisted: entry !== null, entry };
}

// The same username across every service, which is the question that actually
// matters: a player has to be whitelisted everywhere to be able to join.
// Services that opted out, and services with no whitelist.json (Velocity
// delegates to a plugin), are reported but excluded from the verdict so they
// cannot make it permanently false.
export async function checkPlayerEverywhere(name) {
  const services = await Promise.all(
    config.services.map((service, index) => checkPlayerOnService(index, name)),
  );
  const checked = services.filter((service) => !service.skipped && service.exists && !service.error);
  return {
    player: name,
    services,
    checkedServices: checked.map((service) => service.name),
    whitelistedEverywhere: checked.length > 0 && checked.every((service) => service.whitelisted),
  };
}

// Every service's whitelist plus the union of names, for a network-wide view.
export async function listWhitelistEverywhere() {
  const services = await Promise.all(
    config.services.map(async (service, index) => ({
      name: service.name,
      ...(await listWhitelistedPlayers(index)),
    })),
  );
  const names = new Set();
  for (const service of services) {
    for (const player of service.players) if (player.name) names.add(player.name);
  }
  return { services, players: [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) };
}
