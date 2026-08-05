import config from './config.js';
import { sessionExists, panePid } from './tmux.js';
import { javaProcessStats, parseEtime, formatDuration, formatRss } from './stats.js';
import { pingServer } from './mcping.js';

export async function snapshotService(service) {
  const running = await sessionExists(service.tmuxSession);
  if (!running) return { running: false, cpu: null, ram: null, uptime: null, ping: null };
  const snapshot = { running: true, cpu: null, ram: null, uptime: null, ping: null };
  const pid = await panePid(service.tmuxSession);
  if (pid) {
    const proc = await javaProcessStats(pid);
    if (proc) {
      snapshot.cpu = proc.cpu;
      snapshot.ram = formatRss(proc.rssKb);
      const seconds = parseEtime(proc.etime);
      if (seconds != null) snapshot.uptime = formatDuration(seconds);
    }
  }
  if (service.ping) {
    snapshot.ping = await pingServer(service.ping.host, service.ping.port);
  }
  return snapshot;
}

export function snapshotAll() {
  return Promise.all(config.services.map(snapshotService));
}
