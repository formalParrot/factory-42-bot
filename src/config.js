import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

if (!Array.isArray(config.services) || config.services.length === 0) {
  throw new Error('config.json must define at least one entry in "services".');
}
if (config.services.length > 5) {
  throw new Error('At most 5 services are supported (one Discord component row each).');
}

const SUPPORTED_CORES = ['neoforge'];
for (const service of config.services) {
  if (service.core && !SUPPORTED_CORES.includes(service.core.type)) {
    throw new Error(
      `Unknown core type "${service.core.type}" for service "${service.name}". Supported: ${SUPPORTED_CORES.join(', ')}.`,
    );
  }
}

export default config;
