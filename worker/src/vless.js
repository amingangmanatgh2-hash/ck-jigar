/**
 * VLESS over WebSocket, as Cloudflare Workers can implement it.
 *
 * The client's first WebSocket message is the VLESS request header:
 *
 *   byte 0            version (must be 0)
 *   bytes 1..16       the user's UUID, big-endian
 *   byte 17           length of the optional add-on (M)
 *   bytes 18..17+M    the add-on (unused by us)
 *   byte 18+M         command: 1 = TCP, 2 = UDP
 *   bytes 19+M..20+M  the destination port, big-endian
 *   byte 21+M         address type: 1 = IPv4, 2 = domain, 3 = IPv6
 *   the address       (4, 1+N or 16 bytes)
 *   the payload       (whatever is left — the start of the stream)
 *
 * The server answers with two zero bytes, then both directions are relayed raw.
 *
 * UDP: Workers can open TCP sockets only (`connect()` from `cloudflare:sockets` has no datagram mode), so
 * UDP commands are accepted and then ignored, instead of closing the socket — a client that sends a stray UDP
 * packet must not lose its working TCP stream. Every config the panel hands out sets DNS to DNS-over-HTTPS,
 * so name resolution never needs UDP through the tunnel.
 */

let socketsModule;
async function getConnect() {
  if (!socketsModule) socketsModule = await import('cloudflare:sockets');
  return socketsModule.connect;
}

/** Parse the VLESS request header. Returns null when the bytes are not a header. */
export function parseVlessHeader(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 22) return null;
  if (bytes[0] !== 0) return null;

  const uuid = bytesToUuid(bytes.subarray(1, 17));
  const addonLength = bytes[17];
  let offset = 18 + addonLength;
  if (bytes.length < offset + 4) return null;

  const command = bytes[offset];
  const port = (bytes[offset + 1] << 8) | bytes[offset + 2];
  const addrType = bytes[offset + 3];
  offset += 4;

  let address;
  if (addrType === 1) {
    if (bytes.length < offset + 4) return null;
    address = `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
    offset += 4;
  } else if (addrType === 2) {
    if (bytes.length < offset + 1) return null;
    const length = bytes[offset];
    if (length === 0 || bytes.length < offset + 1 + length) return null;
    address = new TextDecoder().decode(bytes.subarray(offset + 1, offset + 1 + length));
    offset += 1 + length;
  } else if (addrType === 3) {
    if (bytes.length < offset + 16) return null;
    address = ipv6ToString(bytes.subarray(offset, offset + 16));
    offset += 16;
  } else {
    return null;
  }

  return { version: 0, uuid, command, port, address, payload: bytes.subarray(offset) };
}

/** Build the 16 bytes of a UUID (used by the tests and by nothing else). */
export function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('invalid uuid');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToUuid(bytes) {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function ipv6ToString(bytes) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return parts.join(':');
}

/**
 * Relay one VLESS session.
 *
 * @param {WebSocket} ws            the server side of the WebSocketPair, not yet accepted
 * @param {(uuid: string) => Promise<boolean>} isUser - is this UUID allowed to connect now?
 * @param {(uuid: string, bytes: number) => void} onTraffic - called once, when the session ends
 */
export async function handleVless(ws, isUser, onTraffic) {
  ws.accept();

  const first = await nextMessage(ws);
  if (!first) return close(ws);

  const header = parseVlessHeader(first);
  if (!header) return close(ws);

  if (!(await isUser(header.uuid))) return close(ws);

  // The header the client waits for before it starts sending.
  ws.send(new Uint8Array([0, 0]));

  // UDP cannot be relayed from a Worker; keep the socket so the TCP stream survives.
  if (header.command === 2) {
    ws.addEventListener('message', () => {});
    return;
  }
  if (header.command !== 1) return close(ws);

  let bytes = header.payload.length;
  try {
    bytes += await relayTcp(ws, header);
  } catch {
    /* the destination refused, the network broke, the client vanished — all the same to us */
  } finally {
    close(ws);
    if (bytes > 2) {
      try {
        await onTraffic?.(header.uuid, bytes);
      } catch {
        /* accounting must never break a session */
      }
    }
  }
}

function nextMessage(ws) {
  return new Promise((resolve) => {
    const done = (value) => {
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
      ws.removeEventListener('error', onClose);
      resolve(value);
    };
    const onMessage = (event) => done(event.data);
    const onClose = () => done(null);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onClose);
  });
}

/**
 * Pipe the WebSocket to a TCP socket and back until either end stops.
 * @returns {Promise<number>} how many bytes crossed the relay
 */
async function relayTcp(ws, header) {
  const connect = await getConnect();
  const socket = connect({ hostname: header.address, port: header.port });
  const writer = socket.writable.getWriter();
  let bytes = 0;
  let closed = false;

  const send = async (chunk) => {
    if (closed) return;
    try {
      await writer.write(chunk);
      bytes += chunk.length;
    } catch {
      closed = true;
    }
  };

  ws.addEventListener('message', (event) => {
    void send(toBytes(event.data));
  });
  ws.addEventListener('close', () => {
    closed = true;
    void writer.close().catch(() => {});
  });
  ws.addEventListener('error', () => {
    closed = true;
    void writer.close().catch(() => {});
  });

  if (header.payload.length > 0) await send(header.payload);

  const reader = socket.readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      bytes += value.length;
      if (ws.readyState === 1) ws.send(value);
      else break;
    }
  } catch {
    /* connection reset: nothing to report */
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return bytes;
}

function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return new Uint8Array(0);
}

function close(ws) {
  try {
    ws.close(1000, 'bye');
  } catch {
    /* already closed */
  }
}
