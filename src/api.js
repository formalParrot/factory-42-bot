import http from 'node:http';
import { WebSocketServer } from 'ws';
import config from './config.js';
import { sessionExists, sendConsole } from './tmux.js';
import { startService, stopService, restartService } from './actions.js';
import { getLastLines, latestLogPath, onLine } from './consoleLog.js';

// Authenticated HTTP + WebSocket API exposing each service's console via its
// logs/latest.log. All routes are under /f42. Sending commands reuses the same
// tmux path the Discord controls use.

const HOST = process.env.API_HOST || '127.0.0.1';
const PORT = Number(process.env.API_PORT || 8080);
const TOKEN = process.env.API_TOKEN;
const AUTH_HEADER = (process.env.API_HEADER || 'x-api-key').toLowerCase();
const WS_HISTORY_LINES = 500;
const MAX_BODY = 64 * 1024;

const startedAt = Date.now();

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req) {
  return Boolean(TOKEN) && req.headers[AUTH_HEADER] === TOKEN;
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

async function runningFor(index) {
  return sessionExists(config.services[index].tmuxSession);
}

async function handleRequest(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  const method = req.method;

  if (parts[0] !== 'f42') return json(res, 404, { error: 'Not found.' });
  if (!authorized(req)) return json(res, 401, { error: 'Unauthorized.' });

  const [resource, name, action] = parts.slice(1);

  if (resource === 'health') {
    if (method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    return json(res, 200, { ok: true, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
  }

  if (resource === 'services' && parts.length === 2) {
    if (method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    const services = await Promise.all(
      config.services.map(async (service, index) => ({
        name: service.name,
        running: await runningFor(index),
        port: service.ping?.port ?? null,
        latestLog: latestLogPath(index),
      })),
    );
    return json(res, 200, { services });
  }

  if (resource === 'ws') return json(res, 404, { error: 'Use the WebSocket endpoint at /f42/ws?service=<name>.' });

  if (resource === 'services' && name && !action) {
    if (method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    return resolveServiceOr(res, name, async (index) => {
      const running = await runningFor(index);
      return json(res, 200, {
        name: config.services[index].name,
        running,
        port: config.services[index].ping?.port ?? null,
        latestLog: latestLogPath(index),
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
    if (url.pathname !== '/f42/ws') {
      socket.destroy();
      return;
    }
    if (!authorizedByToken(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
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