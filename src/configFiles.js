// Per-service file operations on the server's <cwd>/config directory. Reads
// and writes go through `sudo` via the root.js helpers, like server.properties
// and the mods management. Files may live in subdirectories (e.g.
// config/jei/...), but path segments are validated against traversal.
import {
  catAsRoot,
  cpAsRoot,
  listAsRoot,
  mkdirAsRoot,
  rmAsRoot,
  statAsRoot,
  writeFileAsRoot,
} from './root.js';

const MAX_READ_BYTES = 1024 * 1024; // 1 MB

export const configDir = (cwd) => `${cwd}/config`;

// Validates a config-relative path (single name or a/b/c). Returns the
// normalized path, or null when it escapes the config directory.
export function validateConfigPath(name) {
  const p = String(name ?? '');
  if (!p || p.startsWith('/') || p.includes('\\')) return null;
  const segments = p.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) return null;
  return segments.join('/');
}

export async function listConfigFiles(cwd) {
  const dir = configDir(cwd);
  try {
    const names = await listAsRoot(dir);
    const files = await Promise.all(
      names.map(async (name) => {
        const s = await statAsRoot(`${dir}/${name}`).catch(() => null);
        return s
          ? { name, isDir: s.isDir, size: s.size, modified: s.mtime }
          : { name, isDir: false, size: 0, modified: null };
      }),
    );
    return { path: dir, files: files.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch {
    return { path: dir, files: [] };
  }
}

export async function readConfigFile(cwd, name) {
  const rel = validateConfigPath(name);
  if (!rel) return { error: `Invalid config file path: ${name}` };
  const path = `${configDir(cwd)}/${rel}`;
  const stat = await statAsRoot(path).catch(() => null);
  if (!stat) return { error: `Config file "${rel}" not found.` };
  if (stat.isDir) return { error: `"${rel}" is a directory.` };
  const text = await catAsRoot(path);
  const size = Buffer.byteLength(text, 'utf8');
  const truncated = size > MAX_READ_BYTES;
  return {
    name: rel,
    path,
    size,
    modified: stat.mtime,
    truncated,
    content: truncated ? text.slice(0, MAX_READ_BYTES) : text,
  };
}

export async function writeConfigFile(cwd, name, content) {
  const rel = validateConfigPath(name);
  if (!rel) return { error: `Invalid config file path: ${name}` };
  const dir = configDir(cwd);
  const path = `${dir}/${rel}`;
  const existing = await statAsRoot(path).catch(() => null);
  if (existing?.isDir) return { error: `"${rel}" is a directory.` };
  const parent = rel.includes('/') ? `${dir}/${rel.slice(0, rel.lastIndexOf('/'))}` : dir;
  await mkdirAsRoot(parent);
  if (existing) await cpAsRoot(path, `${path}.bak`);
  await writeFileAsRoot(path, content);
  return {
    name: rel,
    path,
    created: !existing,
    backedUp: Boolean(existing),
    size: Buffer.byteLength(content, 'utf8'),
  };
}

export async function deleteConfigFile(cwd, name) {
  const rel = validateConfigPath(name);
  if (!rel) return { error: `Invalid config file path: ${name}` };
  const path = `${configDir(cwd)}/${rel}`;
  const stat = await statAsRoot(path).catch(() => null);
  if (!stat) return { error: `Config file "${rel}" not found.` };
  if (stat.isDir) return { error: 'Cannot delete directories.' };
  await rmAsRoot(path);
  return { deleted: rel };
}