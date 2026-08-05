import net from 'node:net';

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buffer.length) return null;
    const byte = buffer[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, offset: pos };
    shift += 7;
    if (shift > 35) return null;
  }
}

// Minecraft Server List Ping (works for Paper/Vanilla and Velocity alike).
// Resolves with { online, max, version } or null on any failure.
export function pingServer(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on('error', () => finish(null));
    socket.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const handshake = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(-1),
        writeVarInt(hostBuf.length),
        hostBuf,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        writeVarInt(1),
      ]);
      const statusRequest = Buffer.concat([writeVarInt(1), Buffer.from([0x00])]);
      socket.write(Buffer.concat([writeVarInt(handshake.length), handshake, statusRequest]));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const length = readVarInt(buffer, 0);
      if (!length) return;
      if (buffer.length < length.offset + length.value) return;
      const packetId = readVarInt(buffer, length.offset);
      if (!packetId || packetId.value !== 0x00) return finish(null);
      const strLength = readVarInt(buffer, packetId.offset);
      if (!strLength) return finish(null);
      try {
        const status = JSON.parse(
          buffer.toString('utf8', strLength.offset, strLength.offset + strLength.value),
        );
        finish({
          online: status.players?.online ?? null,
          max: status.players?.max ?? null,
          version: status.version?.name ?? null,
        });
      } catch {
        finish(null);
      }
    });
  });
}
