import config from './config.js';
import { sessionExists } from './tmux.js';
import { pingServer } from './mcping.js';

// Per-service status for the dashboard. CPU/RAM/uptime are reported once for the
// whole container by the panel API (see panel.js), not per service.
export async function snapshotService(service) {
  const running = await sessionExists(service.tmuxSession);
  if (!running) return { running: false, ping: null };
  const ping = service.ping ? await pingServer(service.ping.host, service.ping.port) : null;
  return { running: true, ping };
}

export function snapshotAll() {
  return Promise.all(config.services.map(snapshotService));
}
