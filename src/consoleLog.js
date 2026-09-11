import { open } from 'node:fs/promises';
import config from './config.js';

// Reads each service's console from its logs/latest.log (as the server writes
// it live) and keeps a small in-memory ring buffer for quick history fetches.
// Handles file rotation: latest.log is recreated on every server start, so we
// compare inode/device each poll and reset when it changes.

const TAIL_INTERVAL_MS = 500;
const MAX_LINES = 1500;
const MAX_POLL_BYTES = 1_048_576;
// How much of an existing log is scanned to reconstruct who is online when the
// bot starts (or when the log rotates, i.e. the server restarts).
const MAX_BACKFILL_BYTES = 1_048_576;

const tailers = new Map();

export function latestLogPath(index) {
  const service = config.services[index];
  return service.latestLog ?? `${service.cwd.replace(/\/+$/, '')}/logs/latest.log`;
}

export function startTailing() {
  for (let i = 0; i < config.services.length; i++) ensureTailer(i);
}

export function getLastLines(index, n) {
  const tailer = tailers.get(index);
  if (!tailer) return [];
  return tailer.lines.slice(-n);
}

// Registers a callback invoked with each new complete line. Returns an
// unsubscribe function.
export function onLine(index, cb) {
  const tailer = ensureTailer(index);
  tailer.listeners.add(cb);
  return () => tailer.listeners.delete(cb);
}

// Registers a callback invoked when the log file is replaced or truncated
// (latest.log is recreated on every server start). Returns an unsubscribe fn.
export function onRotate(index, cb) {
  const tailer = ensureTailer(index);
  tailer.rotateListeners.add(cb);
  return () => tailer.rotateListeners.delete(cb);
}

// Reads a slice of the tail of a service's current log. Used to reconstruct
// state (e.g. who was online before a restart) that predates the ring buffer.
export async function readLogTail(index, maxBytes = MAX_BACKFILL_BYTES) {
  const path = latestLogPath(index);
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    const chunk = Math.min(maxBytes, stat.size);
    const buf = Buffer.alloc(chunk);
    const { bytesRead } = await handle.read(buf, 0, chunk, stat.size - chunk);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    if (stat.size > chunk) lines.shift();
    return lines.map((line) => line.replace(/\r$/, '')).filter(Boolean);
  } finally {
    await handle.close().catch(() => {});
  }
}

function ensureTailer(index) {
  let tailer = tailers.get(index);
  if (tailer) return tailer;
  tailer = {
    path: latestLogPath(index),
    ino: null,
    dev: null,
    offset: 0,
    pending: '',
    lines: [],
    listeners: new Set(),
    rotateListeners: new Set(),
    timer: null,
    busy: false,
  };
  tailers.set(index, tailer);
  tailer.timer = setInterval(() => poll(tailer), TAIL_INTERVAL_MS);
  if (tailer.timer.unref) tailer.timer.unref();
  return tailer;
}

function notifyRotate(tailer) {
  for (const cb of tailer.rotateListeners) cb();
}

async function poll(tailer) {
  if (tailer.busy) return;
  tailer.busy = true;
  let handle;
  try {
    handle = await open(tailer.path, 'r');
    const stat = await handle.stat();
    if (stat.ino !== tailer.ino || stat.dev !== tailer.dev) {
      if (tailer.ino !== null) notifyRotate(tailer);
      tailer.ino = stat.ino;
      tailer.dev = stat.dev;
      tailer.offset = 0;
      tailer.pending = '';
      tailer.lines = [];
    }
    if (stat.size < tailer.offset) {
      notifyRotate(tailer);
      tailer.offset = 0;
      tailer.lines = [];
    }
    const available = stat.size - tailer.offset;
    if (available <= 0) return;

    const chunk = Math.min(available, MAX_POLL_BYTES);
    const buf = Buffer.alloc(chunk);
    const { bytesRead } = await handle.read(buf, 0, chunk, tailer.offset);
    tailer.offset += bytesRead;
    if (bytesRead === 0) return;

    const text = tailer.pending + buf.subarray(0, bytesRead).toString('utf8');
    const parts = text.split('\n');
    tailer.pending = parts.pop() ?? '';
    const complete = parts.map((line) => line.replace(/\r$/, ''));

    tailer.lines.push(...complete);
    if (tailer.lines.length > MAX_LINES) {
      tailer.lines.splice(0, tailer.lines.length - MAX_LINES);
    }

    for (const line of complete) {
      if (tailer.listeners.size === 0) break;
      for (const cb of tailer.listeners) cb(line);
    }
  } catch {
    // latest.log missing (server has never run or logs dir removed). Reset so a
    // later start is picked up cleanly.
    if (tailer.ino !== null) {
      notifyRotate(tailer);
      tailer.ino = null;
      tailer.dev = null;
      tailer.offset = 0;
      tailer.pending = '';
      tailer.lines = [];
    }
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    tailer.busy = false;
  }
}