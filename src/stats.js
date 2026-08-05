import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function processTable() {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,comm=']);
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) return null;
      return {
        pid: Number(m[1]),
        ppid: Number(m[2]),
        cpu: Number(m[3]),
        rssKb: Number(m[4]),
        etime: m[5],
        comm: m[6],
      };
    })
    .filter(Boolean);
}

// Walks the process tree under the tmux pane's shell and returns the java
// process, so CPU/RAM/uptime describe the actual server, not the shell.
export async function javaProcessStats(rootPid) {
  const table = await processTable();
  const byParent = new Map();
  for (const proc of table) {
    if (!byParent.has(proc.ppid)) byParent.set(proc.ppid, []);
    byParent.get(proc.ppid).push(proc);
  }
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const proc = table.find((p) => p.pid === pid);
    if (proc && /(^|\/)java$/.test(proc.comm)) return proc;
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return null;
}

// ps etime format: [[dd-]hh:]mm:ss
export function parseEtime(etime) {
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  return ((days * 24 + hours) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

export function formatDuration(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

export function formatRss(kb) {
  const mb = kb / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}
