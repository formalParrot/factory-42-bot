import config from './config.js';
import { formatDuration } from './stats.js';

const BASE_URL = process.env.API_BASE_URL?.replace(/\/$/, '');
const TOKEN = process.env.PANEL_TOKEN;

export function panelConfigured() {
  return Boolean(BASE_URL && TOKEN && config.panel?.node && config.panel?.vmid != null);
}

export const refreshMs = Math.max(1, config.panel?.refreshSeconds ?? 1) * 1000;

// Live CPU / memory / uptime for the whole container from the Proxmox panel.
export async function fetchSystemStats() {
  const { node, vmid } = config.panel;
  const url = `${BASE_URL}/nodes/${node}/lxc/${vmid}/status/current`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Panel API ${res.status} for ${url}`);
  const { data } = await res.json();
  return {
    status: data.status,
    uptimeSeconds: data.uptime ?? 0,
    cpuFraction: data.cpu ?? 0, // 0..1 across all assigned cores
    cpus: data.cpus ?? null,
    memBytes: data.mem ?? 0,
    maxMemBytes: data.maxmem ?? 0,
  };
}

function formatBytes(bytes) {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function formatSystemFields(stats) {
  const cpuPercent = (stats.cpuFraction * 100).toFixed(1);
  const cpuLine = stats.cpus ? `${cpuPercent}% of ${stats.cpus} cores` : `${cpuPercent}%`;
  const memPercent = stats.maxMemBytes
    ? ` (${Math.round((stats.memBytes / stats.maxMemBytes) * 100)}%)`
    : '';
  return {
    online: stats.status === 'running',
    status: stats.status === 'running' ? 'Online' : 'Offline',
    uptime: formatDuration(stats.uptimeSeconds),
    cpu: cpuLine,
    ram: `${formatBytes(stats.memBytes)} / ${formatBytes(stats.maxMemBytes)}${memPercent}`,
  };
}
