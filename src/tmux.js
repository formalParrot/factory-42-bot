import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// "=" prefix forces an exact session-name match; tmux otherwise matches prefixes.
// This is valid for session targets (has-session, kill-session, list-panes -s).
const exact = (name) => `=${name}`;

// send-keys takes a *pane* target, where a leading "=" is not accepted ("can't
// find pane: =name"). Use the bare session name to address its active pane.
const paneTarget = (name) => name;

export async function sessionExists(name) {
  try {
    await run('tmux', ['has-session', '-t', exact(name)]);
    return true;
  } catch {
    return false;
  }
}

export async function createSession(name, cwd, command) {
  await run('tmux', ['new-session', '-d', '-s', name, '-c', cwd, command]);
}

export async function sendConsole(name, command) {
  // -l sends the command literally so tmux does not interpret key names in it.
  await run('tmux', ['send-keys', '-t', paneTarget(name), '-l', command]);
  await run('tmux', ['send-keys', '-t', paneTarget(name), 'Enter']);
}

export async function killSession(name) {
  try {
    await run('tmux', ['kill-session', '-t', exact(name)]);
  } catch {
    // Session already gone.
  }
}

export async function panePid(name) {
  try {
    const { stdout } = await run('tmux', ['list-panes', '-s', '-t', exact(name), '-F', '#{pane_pid}']);
    const pid = Number.parseInt(stdout.trim().split('\n')[0], 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
