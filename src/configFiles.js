// Per-service file operations on the server's <cwd>/config directory. Reads
// and writes go through `sudo` via the root.js helpers, like server.properties
// and the mods management. Files may live in subdirectories (e.g.
// config/jei/...), path segments are validated against traversal, listings walk
// the whole tree by default, and reads ship a reformatted copy alongside the
// byte-exact original.
import {
  cpAsRoot,
  findAsRoot,
  listAsRoot,
  mkdirAsRoot,
  readHeadAsRoot,
  rmAsRoot,
  statAsRoot,
  writeFileAsRoot,
} from './root.js';

const MAX_READ_BYTES = 1024 * 1024; // 1 MB
const MAX_LIST_DEPTH = 8; // subdirectories walked when `recursive` is set
const MAX_LIST_ENTRIES = 5000;
// A config tree is mostly noise — assets, locale dumps, jars, world databases —
// so a listing only reports the two formats the config editor can round-trip.
const DEFAULT_EXTENSIONS = ['json'];

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

// Sorts directories before files, then alphabetically, so a recursive listing
// reads top-to-bottom like a file tree.
function sortEntries(entries) {
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function entryName(rel, subdir) {
  return subdir ? `${subdir}/${rel}` : rel;
}

function fileExtension(rel) {
  return rel.split('.').pop().toLowerCase();
}

// Accepts an array or a `?extensions=a,b` string. Returns the extensions to
// match, or null when the filter is off (`all`, `*`, or an empty list), which is
// the only mode that reports directories.
function normalizeExtensions(extensions) {
  const list = typeof extensions === 'string' ? extensions.split(',') : (extensions ?? DEFAULT_EXTENSIONS);
  const wanted = list.map((e) => String(e).trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  return wanted.length && !wanted.includes('all') && !wanted.includes('*') ? wanted : null;
}

async function statOrNull(path) {
  return statAsRoot(path).catch(() => null);
}

// Lists a directory inside <cwd>/config. `subdir` selects which one and
// `recursive` (on by default) walks every directory below it, so a mod's
// `config/<mod>/` files show up without a second request. `extensions` (default
// `.toml` and `.json`) narrows the files, and with a filter in place only the
// directories that hold a matching file come back; `maxDepth` bounds the walk.
// Entry `name` is always relative to <cwd>/config, so it can be handed straight
// back as a request path.
export async function listConfigFiles(
  cwd,
  { subdir = '', recursive = true, maxDepth = 0, extensions = DEFAULT_EXTENSIONS } = {},
) {
  const rel = subdir ? validateConfigPath(subdir) : '';
  if (subdir && !rel) return { error: `Invalid config directory path: ${subdir}` };

  const dir = rel ? `${configDir(cwd)}/${rel}` : configDir(cwd);
  const stat = await statOrNull(dir);
  if (!stat) {
    return { path: dir, subdir: rel, recursive, exists: false, depth: 0, count: 0, truncated: false, files: [] };
  }
  if (!stat.isDir) return { error: `Config path "${rel}" is a file, not a directory.` };

  const wanted = normalizeExtensions(extensions);
  const depth = recursive ? (maxDepth > 0 ? Math.min(Math.floor(maxDepth), MAX_LIST_DEPTH) : MAX_LIST_DEPTH) : 1;

  let entries;
  if (recursive) {
    const found = await findAsRoot(dir, { maxDepth: depth });
    let keep = found;
    if (wanted) {
      // Keep a directory only when a matching file sits somewhere below it, so
      // the result stays a navigable path to real configs and nothing else.
      const files = found.filter((e) => !e.isDir && wanted.includes(fileExtension(e.rel)));
      const dirs = found.filter((e) => e.isDir && files.some((f) => f.rel.startsWith(`${e.rel}/`)));
      keep = [...dirs, ...files];
    }
    entries = keep.map((e) => ({
      name: entryName(e.rel, rel),
      isDir: e.isDir,
      size: e.isDir ? 0 : e.size,
      modified: e.mtime,
      depth: e.rel.split('/').length - 1,
    }));
  } else {
    const names = await listAsRoot(dir);
    const stats = await Promise.all(names.map(async (name) => ({ name, stat: await statOrNull(`${dir}/${name}`) })));
    entries = stats
      // Directories stay in a single-level listing so it can be walked by hand;
      // which files they hold is only known once the tree is walked.
      .filter(({ name, stat: s }) => (s && s.isDir) || (wanted && wanted.includes(fileExtension(name))))
      .map(({ name, stat: s }) => ({
        name: entryName(name, rel),
        isDir: s ? s.isDir : false,
        size: s && !s.isDir ? s.size : 0,
        modified: s ? s.mtime : null,
        depth: 0,
      }));
  }

  const truncated = entries.length > MAX_LIST_ENTRIES;
  return {
    path: dir,
    subdir: rel,
    recursive,
    extensions: wanted ?? [],
    exists: true,
    depth,
    count: Math.min(entries.length, MAX_LIST_ENTRIES),
    truncated,
    files: sortEntries(entries.slice(0, MAX_LIST_ENTRIES)),
  };
}

const FORMAT_BY_EXT = new Map([
  ['toml', 'toml'],
  ['json', 'json'],
  ['mcmeta', 'json'],
  ['properties', 'properties'],
]);

function detectFormat(rel) {
  return FORMAT_BY_EXT.get(rel.split('.').pop().toLowerCase()) || 'text';
}

// Character indices that sit inside a `"""`/`'''` block. Tabs and trailing
// whitespace are meaningful there, so the layout fixes must skip them.
function multilineMask(text) {
  const inside = new Set();
  for (const delim of ['"""', "'''"]) {
    let from = 0;
    for (;;) {
      const open = text.indexOf(delim, from);
      if (open === -1) break;
      const close = text.indexOf(delim, open + delim.length);
      const stop = close === -1 ? text.length : close;
      for (let i = open + delim.length; i < stop; i += 1) inside.add(i);
      from = stop + delim.length;
    }
  }
  return inside;
}

function maskedWithin(inside, start, length) {
  for (let i = 0; i < length; i += 1) if (inside.has(start + i)) return true;
  return false;
}

// Per-character "do not touch" flags for one line: everything inside a quoted
// string or a trailing `#` comment. A tab in a string value is data, so the
// whitespace rewrite has to see the difference.
function lineMask(line) {
  const mask = new Array(line.length).fill(false);
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      const basic = ch === '"';
      let j = i + 1;
      for (; j < line.length; j += 1) {
        if (basic && line[j] === '\\') {
          j += 1;
          continue;
        }
        if (line[j] === ch) break;
      }
      const end = Math.min(j + 1, line.length);
      for (let k = i; k < end; k += 1) mask[k] = true;
      i = end;
      continue;
    }
    if (ch === '#') {
      for (let k = i; k < line.length; k += 1) mask[k] = true;
      break;
    }
    i += 1;
  }
  return mask;
}

// Tabs become two spaces and trailing whitespace goes, but only where the mask
// says the characters are layout rather than data.
function tidyLine(line, mask) {
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    out += mask[i] ? line[i] : line[i] === '\t' ? '  ' : line[i];
  }
  let end = out.length;
  while (end > 0 && !mask[end - 1] && /[ \t]/.test(out[end - 1])) end -= 1;
  return out.slice(0, end);
}

const TOML_WRAP = 100; // comment column to wrap at

const isSeparator = (line) => /^#[ \t]*\.[ \t]*$/.test(line);
const isTableHeader = (line) => /^\[\[?[^\[\]]*\]\]?$/.test(line);
const isAssignment = (line) => /^(?:[A-Za-z0-9_.-]+|"[^"]*"|'[^']*')[ \t]*=/.test(line);
const isCloser = (line) => /^[)\]}]/.test(line);

// NightConfig-style comments run long and have no space after the `#`. Wrapped
// to TOML_WRAP with a `# ` prefix, they read as prose instead of a wall.
function commentLines(text) {
  const body = text.replace(/^#[ \t]*/, '');
  // `#!`, bare `#` and decorative rules like `#---` are left as written, and a
  // comment holding a URL is never broken across lines.
  if (!body || body.startsWith('!') || /^[-=*_#]+$/.test(body) || body.includes('://')) return [`#${body}`];

  const wrapped = [];
  let current = '';
  for (const word of body.split(/\s+/).filter(Boolean)) {
    if (!current) current = word;
    else if (current.length + 1 + word.length + 2 <= TOML_WRAP) current += ` ${word}`;
    else {
      wrapped.push(`# ${current}`);
      current = word;
    }
  }
  if (current) wrapped.push(`# ${current}`);
  return wrapped;
}

// Rewrites NightConfig's tab-indented, `#.`-separated output into something a
// human would have written. TOML gives indentation no meaning — the nesting is
// carried by the `[table]` headers — so headers and keys go back to column 0,
// separator lines drop out, comments get normalised spacing and wrapping, and
// runs of blank lines collapse to one with a blank line before each header.
// Multiline string bodies are passed through byte-for-byte.
function cleanToml(text) {
  const source = text.replace(/\r\n?/g, '\n');
  const inside = multilineMask(source);
  let offset = 0;
  const blocks = [];

  for (const raw of source.split('\n')) {
    const start = offset;
    offset += raw.length + 1;
    const masked = maskedWithin(inside, start, raw.length);

    // Inside a multiline string the bytes are the value: emit them untouched.
    if (masked) {
      blocks.push({ text: raw });
      continue;
    }

    const line = tidyLine(raw, lineMask(raw));
    const trimmed = line.trim();
    if (!trimmed) {
      blocks.push({ blank: true });
      continue;
    }
    if (isSeparator(trimmed)) continue;

    if (trimmed.startsWith('#')) {
      for (const comment of commentLines(trimmed)) blocks.push({ text: comment });
      continue;
    }

    // Structural lines lose their indentation; continuation lines keep their
    // own, except the brackets that close a construct, which line up with the
    // line that opened it.
    const header = isTableHeader(trimmed);
    const text = header || isAssignment(trimmed) || isCloser(trimmed) ? trimmed : line;
    blocks.push({ text, header });
  }

  const out = [];
  for (const block of blocks) {
    if (block.blank) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    // A header gets its own block, unless the lines above it are comments
    // describing it — those stay attached.
    const previous = out[out.length - 1];
    if (block.header && previous !== undefined && previous !== '' && !previous.startsWith('#')) out.push('');
    out.push(block.text);
  }

  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function cleanJson(text) {
  try {
    return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  } catch {
    return null;
  }
}

// Splits on newlines and drops the single empty tail a trailing newline
// produces, so line counts match what a `wc -l` + editor would show.
function splitLines(text) {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Display-oriented copy of a config file. Purely cosmetic: `content` always
// stays the exact file text so a POST round-trips byte-for-byte.
export function cleanConfigText(format, text) {
  if (format === 'toml') return cleanToml(text);
  if (format === 'json') return cleanJson(text) ?? text;
  return text;
}

export async function readConfigFile(cwd, name, { view = 'clean' } = {}) {
  const rel = validateConfigPath(name);
  if (!rel) return { error: `Invalid config file path: ${name}` };
  const path = `${configDir(cwd)}/${rel}`;
  const stat = await statOrNull(path);
  if (!stat) return { error: `Config file "${rel}" not found.` };
  if (stat.isDir) return { error: `"${rel}" is a directory.` };

  // Read through head(1) rather than cat(1): exec's maxBuffer would otherwise
  // reject anything past ~1 MB before the truncation cap could apply.
  const truncated = stat.size > MAX_READ_BYTES;
  const buffer = await readHeadAsRoot(path, MAX_READ_BYTES);
  const content = truncated ? buffer.toString('utf8').replace(/�+$/, '') : buffer.toString('utf8');

  const format = detectFormat(rel);
  const result = {
    kind: 'file',
    name: rel,
    path,
    format,
    size: stat.size,
    modified: stat.mtime,
    truncated,
    content,
  };

  if (view !== 'raw') {
    const formatted = cleanConfigText(format, content);
    result.lines = splitLines(formatted);
    result.lineCount = result.lines.length;
    result.formatted = formatted;
    result.view = 'clean';
  } else {
    result.lines = splitLines(content);
    result.lineCount = result.lines.length;
    result.view = 'raw';
  }

  return result;
}

export async function writeConfigFile(cwd, name, content) {
  const rel = validateConfigPath(name);
  if (!rel) return { error: `Invalid config file path: ${name}` };
  const dir = configDir(cwd);
  const path = `${dir}/${rel}`;
  const existing = await statOrNull(path);
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
  const stat = await statOrNull(path);
  if (!stat) return { error: `Config file "${rel}" not found.` };
  if (stat.isDir) return { error: 'Cannot delete directories.' };
  await rmAsRoot(path);
  return { deleted: rel };
}
