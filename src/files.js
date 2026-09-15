import { readdir, stat, unlink, rename, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024; // 250 MB

function safeName(name) {
  const b = basename(name);
  if (b !== name || b === '.' || b === '..' || b.includes('/') || b.includes('\\')) return null;
  return b;
}

function parseMultipartBoundary(contentType) {
  const match = contentType && contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  return match ? (match[1] || match[2]) : null;
}

function extractParts(buffer, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const close = Buffer.from(`--${boundary}--`);
  const parts = [];
  let pos = 0;

  // Find the first boundary
  let idx = buffer.indexOf(delim, pos);
  if (idx === -1) return parts;
  pos = idx + delim.length;

  while (pos < buffer.length) {
    // Skip CRLF after boundary
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;

    // Check for closing boundary
    if (buffer.slice(pos, pos + close.length).equals(close)) break;

    // Find end of headers (double CRLF)
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;

    const headerBlock = buffer.slice(pos, headerEnd).toString('utf8');
    pos = headerEnd + 4; // skip \r\n\r\n

    // Find the next boundary to determine body end
    const nextDelim = buffer.indexOf(delim, pos);
    if (nextDelim === -1) break;

    // Body is before the CRLF preceding the next boundary
    const body = buffer.slice(pos, nextDelim - 2); // -2 for \r\n before boundary
    pos = nextDelim + delim.length;

    // Parse Content-Disposition to get filename
    const filenameMatch = headerBlock.match(/filename="([^"]+)"/i);
    if (filenameMatch) {
      parts.push({ filename: filenameMatch[1], body });
    }
  }

  return parts;
}

export async function ensureModsDir(modsDir) {
  try {
    await stat(modsDir);
  } catch {
    await mkdir(modsDir, { recursive: true });
  }
}

export async function listFiles(modsDir) {
  try {
    const entries = await readdir(modsDir);
    const files = await Promise.all(
      entries.map(async (name) => {
        const s = await stat(join(modsDir, name)).catch(() => null);
        return s
          ? { name, size: s.size, modified: s.mtime.toISOString(), enabled: !name.endsWith('.dis') }
          : null;
      }),
    );
    return files.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function uploadFiles(req, modsDir) {
  const contentType = req.headers['content-type'] || '';
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) return { error: 'Missing or invalid multipart boundary.' };

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      req.destroy();
      return { error: `File too large. Maximum upload size is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` };
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const parts = extractParts(body, boundary);
  if (parts.length === 0) return { error: 'No files found in upload.' };

  await ensureModsDir(modsDir);
  const uploaded = [];

  for (const part of parts) {
    const safe = safeName(part.filename);
    if (!safe) return { error: `Invalid filename: ${part.filename}` };
    if (safe.includes('/')) return { error: 'Subdirectory uploads are not allowed.' };

    await writeFile(join(modsDir, safe), part.body);
    uploaded.push(safe);
  }

  return { uploaded };
}

export async function deleteFile(modsDir, filename) {
  const safe = safeName(filename);
  if (!safe) return { error: `Invalid filename: ${filename}` };
  const target = join(modsDir, safe);
  try {
    await stat(target);
  } catch {
    return { error: `File "${safe}" not found.` };
  }
  await unlink(target);
  return { deleted: safe };
}

export async function disableFile(modsDir, filename) {
  const safe = safeName(filename);
  if (!safe) return { error: `Invalid filename: ${filename}` };
  if (!safe.endsWith('.jar')) return { error: 'Only .jar files can be disabled.' };
  const target = join(modsDir, safe);
  try {
    await stat(target);
  } catch {
    return { error: `File "${safe}" not found.` };
  }
  const disabled = `${safe}.dis`;
  await rename(target, join(modsDir, disabled));
  return { disabled };
}

export async function enableFile(modsDir, filename) {
  const safe = safeName(filename);
  if (!safe) return { error: `Invalid filename: ${filename}` };
  if (!safe.endsWith('.jar.dis')) return { error: 'Only .jar.dis files can be enabled.' };
  const target = join(modsDir, safe);
  try {
    await stat(target);
  } catch {
    return { error: `File "${safe}" not found.` };
  }
  const enabled = safe.slice(0, -4); // remove .dis
  await rename(target, join(modsDir, enabled));
  return { enabled };
}
