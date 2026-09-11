import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { onLine, onRotate, readLogTail } from './consoleLog.js';

// Per-service online player tracking derived from each server's console log.
// Joins ("joined the game") and leaves ("left the game" / "lost connection:")
// mutate an in-memory Set per service. On startup and on log rotation (server
// restart) the tracker backfills the log tail to reconstruct who is online.
// Minecraft usernames are [A-Za-z0-9_], so \S/word boundaries are safe.

// The current roster is persisted to data/players.json (gitignored) on every
// change so it survives bot restarts; it seeds the in-memory sets before the
// log tail backfill converges.

const DATA_FILE = fileURLToPath(new URL('../data/players.json', import.meta.url));
const SAVE_DELAY_MS = 500;
let saveTimer = null;

function savedPlayers() {
  try {
    const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    const byName = new Map();
    for (const service of config.services) {
      const names = raw[service.name];
      if (Array.isArray(names)) byName.set(service.name, new Set(names.filter((n) => typeof n === 'string')));
    }
    return byName;
  } catch {
    return new Map();
  }
}

function snapshot() {
  const out = {};
  for (const [index, set] of players) {
    out[config.services[index].name] = [...set];
  }
  return out;
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, `${JSON.stringify(snapshot(), null, 2)}\n`);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
  if (saveTimer.unref) saveTimer.unref();
}

const saved = savedPlayers();

const NAME = '[A-Za-z0-9_]{1,16}';

const RULES = [
  // Paper / vanilla
  { event: 'join', re: new RegExp(`\\b(${NAME}) joined the game`) },
  { event: 'leave', re: new RegExp(`\\b(${NAME}) (?:left the game|lost connection:)`) },
  // Paper periodically logs an authoritative snapshot; use it to correct drift.
  {
    event: 'sync',
    re: /There are \d+ of a max of \d+ players online:\s*(.*)/,
  },
  // Velocity / proxy best-effort
  { event: 'join', re: new RegExp(`\\[connected player\\]\\s*(${NAME})\\s+connected`) },
  { event: 'leave', re: new RegExp(`\\[connected player\\]\\s*(${NAME})\\s+disconnected`) },
];

export function parsePlayerLine(line) {
  for (const rule of RULES) {
    const match = line.match(rule.re);
    if (!match) continue;
    if (rule.event === 'sync') {
      return {
        event: 'sync',
        names: match[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };
    }
    return { event: rule.event, name: match[1] };
  }
  return null;
}

function apply(parsed, set) {
  if (!parsed) return;
  if (parsed.event === 'join') set.add(parsed.name);
  else if (parsed.event === 'leave') set.delete(parsed.name);
  else if (parsed.event === 'sync') {
    set.clear();
    for (const name of parsed.names) set.add(name);
  }
  scheduleSave();
}

const players = new Map();
let started = false;

function trackService(index) {
  const service = config.services[index];
  const set = saved.get(service.name) ?? new Set();
  players.set(index, set);

  onLine(index, (line) => apply(parsePlayerLine(line), set));

  onRotate(index, () => {
    set.clear();
    readLogTail(index)
      .then((lines) => {
        for (const line of lines) apply(parsePlayerLine(line), set);
      })
      .catch(() => {});
  });

  readLogTail(index)
    .then((lines) => {
      for (const line of lines) apply(parsePlayerLine(line), set);
    })
    .catch(() => {});
}

export function startPlayerTracking() {
  if (started) return;
  started = true;
  for (let i = 0; i < config.services.length; i++) trackService(i);
  process.on('exit', flushSave);
}

export function getOnlinePlayers(index) {
  if (!started) return [];
  return [...(players.get(index) ?? [])];
}

export function getPlayerCount(index) {
  if (!started) return null;
  return players.get(index)?.size ?? null;
}