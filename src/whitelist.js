// Whitelist requests. Anyone can ask to be whitelisted through the public
// endpoint (rate limited, no key); an admin then approves or denies. Approving
// types the same `whitelist add <player>` command into every configured service
// console, which is how each server's own whitelist is maintained.
//
// The queue is in-memory like the rest of the bot's transient state, so pending
// requests do not survive a bot restart. Approvals are not lost by that: the
// servers keep their whitelists, and a fresh request can be made at any time.
import config from './config.js';
import { sendConsole, sessionExists } from './tmux.js';

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

// Runs the whitelist command on every service and reports each one separately,
// so the caller can see which consoles took the command and which did not.
// Re-approving is allowed: it simply runs the command again.
export async function approveRequest(name) {
  const request = requests.get(key(name));
  if (!request) return null;
  const command = `whitelist add ${request.name}`;
  const services = await Promise.all(
    config.services.map(async (service) => {
      const running = await sessionExists(service.tmuxSession);
      if (!running) {
        return { name: service.name, running: false, sent: false, error: 'Service is not running.' };
      }
      try {
        await sendConsole(service.tmuxSession, command);
        return { name: service.name, running: true, sent: true, error: null };
      } catch (err) {
        return { name: service.name, running: true, sent: false, error: err.message };
      }
    }),
  );
  request.status = STATUS.APPROVED;
  request.decidedAt = new Date().toISOString();
  request.command = command;
  request.services = services;
  return { request, command, services };
}
