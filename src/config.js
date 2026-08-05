import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

if (!Array.isArray(config.services) || config.services.length === 0) {
  throw new Error('config.json must define at least one entry in "services".');
}
if (config.services.length > 5) {
  throw new Error('At most 5 services are supported (one Discord component row each).');
}

export default config;
