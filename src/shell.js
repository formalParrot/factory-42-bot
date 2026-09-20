// Root shell backing the /f42/root WebSocket. Each client gets its own
// long-lived `sudo -i` login shell (passwordless sudo, same requirement the
// rest of the bot relies on). Commands sent on the socket are fed to the
// shell's stdin, so state (cwd, env, variables) persists across commands.
// Output follows the same frame protocol as the service consoles: line/echo/
// error/status JSON messages.
import { spawn } from 'node:child_process';

const SHELL = ['sudo', '-i'];
// How long to hold partial (no trailing newline) output before sending it as a
// line, so prompts / progress output still show up live.
const FLUSH_IDLE_MS = 150;
const MAX_PENDING = 64 * 1024;

export function attachRootShell(ws) {
  const send = (payload) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  let child;
  try {
    child = spawn(SHELL[0], SHELL.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    send({ type: 'error', error: `Could not start root shell: ${err.message}` });
    ws.close();
    return;
  }

  let pending = '';
  let flushTimer = null;
  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (pending) {
      send({ type: 'line', text: pending });
      pending = '';
    }
  };
  const onData = (chunk) => {
    pending += chunk.toString('utf8');
    if (pending.length > MAX_PENDING) flush();
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const part of parts) send({ type: 'line', text: part });
    if (pending && !flushTimer) flushTimer = setTimeout(flush, FLUSH_IDLE_MS);
  };

  send({ type: 'status', name: 'root', running: true, shell: SHELL.join(' ') });

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    send({ type: 'error', error: `Root shell error: ${err.message}` });
  });

  let ended = false;
  const endShell = () => {
    if (ended) return;
    ended = true;
    flush();
    send({ type: 'status', name: 'root', running: false });
  };

  child.on('close', () => {
    endShell();
    ws.close();
  });

  ws.on('message', (data) => {
    if (ended || child.exitCode != null) return;
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return send({ type: 'error', error: 'Messages must be JSON, e.g. {"command":"ls -la"}.' });
    }
    if (typeof message.command !== 'string' || !message.command.trim()) {
      return send({ type: 'error', error: 'Send {"command":"..."} to run a shell command.' });
    }
    const command = message.command;
    try {
      child.stdin.write(command + '\n');
      send({ type: 'echo', text: command });
    } catch (err) {
      send({ type: 'error', error: err.message });
    }
  });

  ws.on('close', () => {
    if (flushTimer) clearTimeout(flushTimer);
    if (child && child.exitCode == null && !child.killed) {
      try {
        child.stdin.write('exit\n');
      } catch {
        /* stdin already gone */
      }
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
      if (killTimer.unref) killTimer.unref();
      child.once('close', () => clearTimeout(killTimer));
    }
  });
  ws.on('error', () => {});
}