import config from './config.js';
import { sessionExists, createSession, sendConsole, killSession } from './tmux.js';
import { serviceState } from './state.js';

const STOP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startService(index) {
  const service = config.services[index];
  if (await sessionExists(service.tmuxSession)) return 'already-running';
  serviceState.set(index, 'starting');
  try {
    await createSession(service.tmuxSession, service.cwd, service.startCommand);
    return 'started';
  } finally {
    serviceState.delete(index);
  }
}

// Graceful stop: type the stop command into the server console, wait for the
// tmux session to exit on its own, force-kill only after the timeout.
export async function stopService(index) {
  const service = config.services[index];
  if (!(await sessionExists(service.tmuxSession))) return 'already-stopped';
  serviceState.set(index, 'stopping');
  try {
    await sendConsole(service.tmuxSession, service.stopConsoleCommand);
    for (let waited = 0; waited < STOP_TIMEOUT_MS; waited += POLL_INTERVAL_MS) {
      await sleep(POLL_INTERVAL_MS);
      if (!(await sessionExists(service.tmuxSession))) return 'stopped';
    }
    await killSession(service.tmuxSession);
    return 'killed';
  } finally {
    serviceState.delete(index);
  }
}

export async function restartService(index) {
  const stopResult = await stopService(index);
  await startService(index);
  return stopResult === 'killed' ? 'killed-restarted' : 'restarted';
}
