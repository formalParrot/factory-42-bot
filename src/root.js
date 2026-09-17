// Root-owned file operations. The server files live outside the bot user's
// access, so reads/writes go through `sudo`. All paths are shell-quoted so the
// quoting rules are defined in exactly one place.
import { exec, spawn } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execAsync = promisify(exec);

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export async function catAsRoot(path) {
  return (await execAsync(`sudo cat ${shq(path)}`)).stdout;
}

export async function cpAsRoot(src, dest) {
  await execAsync(`sudo cp ${shq(src)} ${shq(dest)}`);
}

export async function rmAsRoot(path) {
  await execAsync(`sudo rm -rf ${shq(path)}`);
}

// Lists directory entries; returns [] when the path does not exist.
export async function listAsRoot(path) {
  const { stdout } = await execAsync(`sudo ls -1 ${shq(path)}`).catch(() => ({ stdout: '' }));
  return stdout.split('\n').filter(Boolean);
}

export async function existsAsRoot(path) {
  try {
    await execAsync(`sudo test -e ${shq(path)}`);
    return true;
  } catch {
    return false;
  }
}

async function hadImmutableFlag(path) {
  try {
    const { stdout } = await execAsync(`sudo lsattr ${shq(path)}`);
    return (stdout.trim().split(/\s+/)[0] || '').includes('i');
  } catch {
    return false;
  }
}

async function cpOverAsRoot(src, dest) {
  try {
    await cpAsRoot(src, dest);
    return;
  } catch (err) {
    if (!err || !/Operation not permitted/i.test(err.stderr || err.message)) throw err;
  }
  // Root still getting EPERM on an existing file means it is immutable
  // (chattr +i). Clear the flag, copy, then restore it.
  const wasImmutable = await hadImmutableFlag(dest);
  await execAsync(`sudo chattr -i ${shq(dest)}`).catch(() => {});
  try {
    await cpAsRoot(src, dest);
  } finally {
    if (wasImmutable) {
      await execAsync(`sudo chattr +i ${shq(dest)}`).catch(() => {});
    }
  }
}

export async function writePropertiesAsRoot(path, content) {
  const tmp = join(tmpdir(), `server.properties.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, content);
  try {
    await cpOverAsRoot(tmp, path);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function writeFileAsRoot(path, content) {
  const tmp = join(tmpdir(), `${path.split('/').pop()}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, content);
  try {
    await cpOverAsRoot(tmp, path);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// Runs a long command (installer, download) as root via `sudo bash -c`. Output
// is buffered to the last ~20 KB so huge installer logs can't blow up memory.
// Resolves with { code, out, timedOut }; kills the child on timeout.
export function execRootSpawn(command, { timeoutMs = 0, onData } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['bash', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let length = 0;
    let timedOut = false;
    const push = (chunk) => {
      const s = chunk.toString();
      chunks.push(s);
      length += s.length;
      while (length > 20_000 && chunks.length > 0) {
        length -= chunks.shift().length;
      }
      onData?.(s);
    };
    const kill = () => {
      if (timedOut || child.exitCode != null) return;
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
    };
    const timer = timeoutMs > 0 ? setTimeout(kill, timeoutMs) : null;
    timer?.unref?.();
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out: chunks.join(''), timedOut });
    });
  });
}