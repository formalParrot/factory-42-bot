// Fires a POST request to a custom API when a server starts or stops.
// Configure via env:
//   START_STOP_WEBHOOK_URL   - full URL to POST to
//   START_STOP_WEBHOOK_TOKEN - bearer token
//   START_STOP_WEBHOOK_HEADER - header name carrying the token (default: x-admin-key)
const URL = process.env.START_STOP_WEBHOOK_URL;
const TOKEN = process.env.START_STOP_WEBHOOK_TOKEN;
const HEADER = process.env.START_STOP_WEBHOOK_HEADER || 'x-admin-key';

const SERVICE_LABEL = 'Factory 42';

export function webhookConfigured() {
  return Boolean(URL && TOKEN);
}

// Posts a start/stop notification. Failures are swallowed so server management
// never breaks because the webhook is down.
export async function notifyServiceChange({ name, action }) {
  if (!webhookConfigured()) return;
  const message = `${name} ${action === 'start' ? 'Started' : 'Stopped'}`;
  try {
    await fetch(URL, {
      method: 'POST',
      headers: {
        [HEADER]: TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        service: SERVICE_LABEL,
        message,
      }),
    });
  } catch {
    // Ignore; server management must not fail because the webhook is unreachable.
  }
}
