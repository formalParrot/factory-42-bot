// Server "core" management (the server software that runs the service, e.g.
// NeoForge). A service opts in via `core: { "type": "neoforge" }` in
// config.json. NeoForge is updated the official way: download the version's
// installer jar and run `java -jar ... --installServer`, which regenerates
// run.sh, user_jvm_args.txt and libraries/net/neoforged/neoforge/<version>/.
import config from './config.js';
import { sessionExists } from './tmux.js';
import { startService, stopService } from './actions.js';
import { existsAsRoot, execRootSpawn, listAsRoot, rmAsRoot, shq } from './root.js';

const METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const NEOFORGE_DIR = 'libraries/net/neoforged/neoforge';
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const META_TTL_MS = 15 * 60_000;
const OUTPUT_TAIL = 1200;

// index -> record of the last (or in-flight) update.
const updates = new Map();
// index -> currently running core update. One per service at a time.
const busy = new Set();

let metaCache = { versions: null, fetchedAt: 0 };

export function coreConfigured(index) {
  return Boolean(config.services[index]?.core?.type);
}

export function coreBusy(index) {
  return busy.has(index);
}

function tail(text) {
  const t = String(text || '');
  return t.length > OUTPUT_TAIL ? t.slice(-OUTPUT_TAIL) : t;
}

// NeoForge build versions are `<mc-major-patch>.<mc-minor-no-dot>.<build>`,
// e.g. 21.1.153 -> Minecraft 1.21.1, 21.4.111-beta -> 1.21.4.
export function deriveMcVersion(neoVersion) {
  const parts = String(neoVersion).split('.');
  if (parts.length < 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  return `1.${parts[0]}.${parts[1]}`;
}

// Metadata versions are filtered by the MC version with the leading "1."
// stripped: Minecraft 1.21.1 -> "21.1." prefix, 1.21 -> "21.1".
function mcVersionKey(mc) {
  const parts = String(mc).split('.').filter(Boolean);
  if (parts[0] === '1') parts.shift();
  return parts.length >= 2 ? `${parts.join('.')}.` : parts.join('.');
}

// Numeric-aware comparison: 21.1.153 > 21.1.54.
function compareVersion(a, b) {
  const pa = String(a).split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pb = String(b).split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return av > bv ? 1 : -1;
    return String(av) > String(bv) ? 1 : -1;
  }
  return 0;
}

async function fetchMetadata() {
  const res = await fetch(METADATA_URL, { headers: { accept: 'application/xml' } });
  if (!res.ok) throw new Error(`NeoForge metadata returned ${res.status}.`);
  return res.text();
}

export async function listAllVersions() {
  const now = Date.now();
  if (metaCache.versions && now - metaCache.fetchedAt < META_TTL_MS) return metaCache.versions;
  const text = await fetchMetadata();
  const versions = [];
  const re = /<version>([^<]+)<\/version>/g;
  let m;
  while ((m = re.exec(text))) versions.push(m[1]);
  metaCache = { versions, fetchedAt: now };
  return versions;
}

// Latest build per Minecraft version, newest MC first. Used when the MC version
// cannot be derived (no core installed yet, no config override).
function latestPerMc(all) {
  const best = new Map();
  for (const v of all) {
    const mc = deriveMcVersion(v);
    if (!mc) continue;
    const current = best.get(mc);
    if (!current || compareVersion(v, current) > 0) best.set(mc, v);
  }
  return [...best.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([mc, version]) => ({ mc, version }));
}

export async function getCoreStatus(index) {
  const service = config.services[index];
  const type = service.core?.type ?? null;
  let installed = null;
  let mcVersion = service.core?.mcVersion || null;

  if (type === 'neoforge') {
    try {
      const entries = await listAsRoot(`${service.cwd}/${NEOFORGE_DIR}`);
      const versionDirs = entries.filter((e) => /^\d+(\.\d+)+/.test(e));
      versionDirs.sort((a, b) => compareVersion(b, a));
      installed = versionDirs[0] ?? null;
    } catch {
      installed = null;
    }
    if (!mcVersion && installed) mcVersion = deriveMcVersion(installed);

    const all = await listAllVersions();
    if (mcVersion) {
      const key = mcVersionKey(mcVersion);
      const versions = all.filter((v) => v.startsWith(key)).sort((a, b) => compareVersion(b, a));
      return {
        name: service.name,
        type,
        installed,
        mcVersion,
        latest: versions[0] ?? null,
        versions,
        busy: busy.has(index),
        lastUpdate: updates.get(index) ?? null,
      };
    }
    const options = latestPerMc(all);
    return {
      name: service.name,
      type,
      installed,
      mcVersion,
      latest: options[0]?.version ?? null,
      versions: [],
      options,
      busy: busy.has(index),
      lastUpdate: updates.get(index) ?? null,
    };
  }

  return {
    name: service.name,
    type,
    installed,
    mcVersion,
    latest: null,
    versions: [],
    options: [],
    busy: busy.has(index),
    lastUpdate: updates.get(index) ?? null,
  };
}

// Stop-if-running, install, restart-if-it-was-running. Long-running; callers
// should kick it off and poll GET /core for the record/busy flag.
export async function updateCore(index, version) {
  if (busy.has(index)) throw new Error('A core update is already in progress.');
  const service = config.services[index];
  const { cwd } = service;
  const record = {
    version,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    restarted: null,
    error: null,
    output: null,
  };
  busy.add(index);
  updates.set(index, record);
  try {
    const wasRunning = await sessionExists(service.tmuxSession);
    if (wasRunning) await stopService(index);

    const installerFile = `neoforge-${version}-installer.jar`;
    const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/${installerFile}`;
    const dl = await execRootSpawn(
      `cd ${shq(cwd)} && curl -fsSL --retry 3 -o ${shq(installerFile)} ${shq(installerUrl)}`,
      { timeoutMs: DOWNLOAD_TIMEOUT_MS },
    );
    if (dl.timedOut || dl.code !== 0) throw new Error(`Failed to download installer: ${tail(dl.out)}`);

    // Remove the previous install so downgrades/upgrades from other MC lines work.
    if (await existsAsRoot(`${cwd}/${NEOFORGE_DIR}`)) {
      await rmAsRoot(`${cwd}/${NEOFORGE_DIR}`);
    }

    const inst = await execRootSpawn(`cd ${shq(cwd)} && java -jar ${shq(installerFile)} --installServer`, {
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (inst.timedOut) throw new Error('Installer timed out (10 minutes).');
    if (inst.code !== 0) throw new Error(`Installer exited with code ${inst.code}: ${tail(inst.out)}`);

    const argsOk = await existsAsRoot(`${cwd}/${NEOFORGE_DIR}/${version}/unix_args.txt`);
    if (!argsOk) throw new Error('Installer completed but unix_args.txt was not created.');

    await rmAsRoot(`${cwd}/${installerFile}`).catch(() => {});
    record.output = tail(inst.out);

    if (wasRunning) {
      await startService(index);
      record.restarted = 'restarted';
    }
    record.ok = true;
    return record;
  } catch (err) {
    record.error = err.message;
    throw err;
  } finally {
    record.finishedAt = new Date().toISOString();
    busy.delete(index);
  }
}