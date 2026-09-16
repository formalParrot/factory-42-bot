// Parse/serialize Minecraft `server.properties` (Java properties format) while
// preserving comments, blank lines and ordering. Untouched lines round-trip
// byte-for-byte; only edited entries are re-serialized.

export function parseProperties(text) {
  const entries = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) {
      entries.push({ type: 'blank', raw });
      continue;
    }
    const first = raw.trimStart()[0];
    if (first === '#' || first === '!') {
      entries.push({ type: 'comment', raw });
      continue;
    }
    const parsed = parseKeyValueLine(raw);
    entries.push(parsed ? { type: 'key', ...parsed, raw } : { type: 'comment', raw });
  }
  return entries;
}

function parseKeyValueLine(raw) {
  let i = 0;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  let key = '';
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      const n = raw[i + 1];
      if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
        key += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
        i += 6;
      } else {
        key += n;
        i += 2;
      }
      continue;
    }
    if (c === '=' || c === ':' || /\s/.test(c)) {
      i += 1;
      break;
    }
    key += c;
    i += 1;
  }
  if (!key) return null;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  if (raw[i] === '=' || raw[i] === ':') {
    i += 1;
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
  }
  return { key, value: unescapeValue(raw.slice(i)) };
}

function unescapeValue(value) {
  return value.replace(/\\u([0-9a-fA-F]{4})|(\\.)/gs, (m, hex, esc) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    const c = esc[1];
    switch (c) {
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 'f':
        return '\f';
      default:
        return c;
    }
  });
}

function escapeValue(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\f/g, '\\f');
}

export function entriesToObject(entries) {
  const obj = {};
  for (const entry of entries) {
    if (entry.type === 'key') obj[entry.key] = entry.value;
  }
  return obj;
}

export function setEntry(entries, key, value) {
  const entry = entries.find((e) => e.type === 'key' && e.key === key);
  if (entry) {
    entry.value = value;
    entry.dirty = true;
  } else {
    entries.push({ type: 'key', key, value, dirty: true, raw: null });
  }
}

export function serializeProperties(entries) {
  return entries
    .map((entry) => (entry.type === 'key' && entry.dirty ? `${entry.key}=${escapeValue(entry.value)}` : entry.raw))
    .join('\n');
}