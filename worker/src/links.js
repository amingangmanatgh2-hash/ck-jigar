/**
 * Everything that turns settings into shareable links, and shared parsing helpers.
 * Pure functions only: no I/O, no environment. `worker/test/links.test.mjs` pins each one.
 */

const enc = new TextEncoder();

/* ------------------------------------------------------------------ base64 / hex */

export function bytesToBase64(bytes) {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}

export function base64ToBytes(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** URL-safe base64 without padding (Cloudflare's VLESS-style keys, tokens). */
export function base64UrlEncode(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return base64ToBytes(padded);
}

export function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** A random UUID v4, as the VLESS protocol wants it. */
export function newUuid() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A subscription token: 24 URL-safe characters, unguessable. */
export function newToken() {
  return base64UrlEncode(randomBytes(18));
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** 32 bytes of a password → what is stored, so the raw password never is. */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return hex(new Uint8Array(digest));
}

/** A signature that only the server can make (it holds the admin password). */
export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text))));
}

/** Compares two strings without leaking, through timing, where they differ. */
export function sameSecret(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ host / path hygiene */

/** A host name or IP, lower-cased, without a scheme, a path or a trailing dot. */
export function normalizeHost(input) {
  let host = String(input ?? '').trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//i, '');
  host = host.split('/')[0].split('?')[0].split('#')[0];
  host = host.replace(/^\[/, '').replace(/\]$/, '');
  // a host:port keeps its port stripped; an IPv6 literal (two or more colons) never does
  if ((host.match(/:/g) ?? []).length <= 1) host = host.replace(/:\d+$/, '');
  host = host.replace(/\.+$/, '');
  if (!host) return '';
  if (host.length > 253) return '';
  return host;
}

/** The WebSocket path, always starting with one slash; an empty value becomes `/ws`. */
export function normalizePath(input) {
  let path = String(input ?? '').trim();
  if (!path) path = '/ws';
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 128) path = path.slice(0, 128);
  return path;
}

/* ------------------------------------------------------------------ links */

/**
 * The shareable `vless://` link for one user.
 *
 * A "strong" link, in the sense the clients agree on today: TLS with a real SNI, uTLS fingerprint chrome
 * (so the handshake looks like a browser's), WebSocket transport, and optional ECH/fragment parameters that
 * Xray understands. Everything is explicit in the query so that no client has to guess.
 *
 * @param {{uuid: string, host: string, port?: number, path?: string, security?: 'tls'|'none', sni?: string,
 *          hostHeader?: string, remark?: string, fingerprint?: string, alpn?: string, fragment?: string,
 *          address?: string}} o
 */
export function buildVlessLink(o) {
  const uuid = String(o.uuid);
  if (!UUID_PATTERN.test(uuid)) throw new Error('invalid uuid');
  const address = normalizeHost(o.address || o.host);
  const host = normalizeHost(o.host);
  if (!address) throw new Error('invalid address');
  const port = Number(o.port) || (o.security === 'none' ? 80 : 443);
  const path = normalizePath(o.path);
  const security = o.security === 'none' ? 'none' : 'tls';
  const header = normalizeHost(o.hostHeader || host) || address;

  const params = new URLSearchParams();
  params.set('encryption', 'none');
  params.set('type', 'ws');
  params.set('security', security);
  params.set('host', header);
  params.set('path', path);
  // xudp is what every current client expects; the panel's own configs resolve names over DNS-over-HTTPS
  // because a Worker can only open TCP sockets.
  params.set('packetEncoding', 'xudp');
  if (security === 'tls') {
    params.set('sni', normalizeHost(o.sni || host) || address);
    params.set('fp', o.fingerprint || 'chrome');
    params.set('alpn', o.alpn || 'h2,http/1.1');
    params.set('allowInsecure', '0');
  }
  if (o.fragment) params.set('fragment', o.fragment);
  if (o.ech) params.set('ech', o.ech);

  // IPv6 literals have to be bracketed in an authority
  const dial = address.includes(':') ? `[${address}]` : address;
  const remark = cleanRemark(o.remark);
  return `vless://${uuid}@${dial}:${port}?${params.toString()}#${encodeURIComponent(remark)}`;
}

/** A remark cannot contain characters that break a link, and cannot be empty (some clients need it). */
export function cleanRemark(text) {
  const t = String(text ?? '')
    .replace(/[#?&\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, 60) || 'zeus';
}

/** A subscription document: base64 of the links, one per line (the format every client reads). */
export function buildSubscription(links, { base64 = true } = {}) {
  const body = links.join('\n');
  return base64 ? bytesToBase64(enc.encode(body)) : body;
}

/** The address a client should actually dial: a clean IP when the user gave one, the host otherwise. */
/** An IPv4 address, an IPv6 address or a host name. A single word ("a", "host") is not an address. */
export function isAddress(value) {
  const text = String(value ?? '');
  if (/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(text)) return true;
  if (/^[0-9a-f]*:[0-9a-f:]+$/i.test(text) && text.split(':').length >= 3) return true;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(text);
}

/** The address a client should actually dial: a clean IP when the user gave one, the host otherwise. */
export function splitCleanIps(text) {
  const seen = new Set();
  return String(text ?? '')
    .split(/[\s,;]+/)
    .map((x) => x.trim().replace(/^\[/, '').replace(/\]$/, ''))
    .filter((x) => x && isAddress(x))
    .filter((x) => (seen.has(x) ? false : seen.add(x)))
    .slice(0, 100);
}

/* ------------------------------------------------------------------ parsing (import) */

/**
 * Parse a shareable link into what a client needs. Supports vless://, trojan:// and ss:// (SIP002),
 * which is what the panel itself produces plus what people paste from other providers.
 * Returns null for anything else; never throws.
 */
export function parseLink(text) {
  try {
    const raw = String(text ?? '').trim();
    if (/^vless:\/\//i.test(raw)) return parseVless(raw);
    if (/^trojan:\/\//i.test(raw)) return parseTrojan(raw);
    if (/^ss:\/\//i.test(raw)) return parseShadowsocks(raw);
    return null;
  } catch {
    return null;
  }
}

function parseVless(raw) {
  const url = new URL(raw);
  const q = url.searchParams;
  const uuid = decodeURIComponent(url.username || '');
  if (!UUID_PATTERN.test(uuid)) return null;
  const host = normalizeHost(url.hostname);
  if (!host) return null;
  const security = (q.get('security') || (q.get('tls') === 'tls' ? 'tls' : 'none')).toLowerCase();
  let path = q.get('path') || '/';
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep it as it is */
  }
  return {
    protocol: 'vless',
    uuid,
    host,
    port: Number(url.port) || (security === 'none' ? 80 : 443),
    security: security === 'none' ? 'none' : 'tls',
    network: (q.get('type') || 'tcp').toLowerCase(),
    path: normalizePath(path),
    hostHeader: normalizeHost(q.get('host') || q.get('sni') || host),
    sni: normalizeHost(q.get('sni') || q.get('host') || host),
    fingerprint: q.get('fp') || '',
    alpn: q.get('alpn') || '',
    remark: decodeURIComponent(url.hash.replace(/^#/, '')) || `${host}:${url.port || 443}`,
    flow: q.get('flow') || '',
  };
}

function parseTrojan(raw) {
  const url = new URL(raw);
  const password = decodeURIComponent(url.username || url.password || '');
  const host = normalizeHost(url.hostname);
  if (!password || !host) return null;
  return {
    protocol: 'trojan',
    uuid: password,
    host,
    port: Number(url.port) || 443,
    security: 'tls',
    network: (url.searchParams.get('type') || 'tcp').toLowerCase(),
    path: normalizePath(url.searchParams.get('path') || '/'),
    hostHeader: normalizeHost(url.searchParams.get('host') || host),
    sni: normalizeHost(url.searchParams.get('sni') || host),
    fingerprint: url.searchParams.get('fp') || '',
    alpn: url.searchParams.get('alpn') || '',
    remark: decodeURIComponent(url.hash.replace(/^#/, '')) || `${host}:${url.port || 443}`,
    flow: '',
  };
}

function parseShadowsocks(raw) {
  // SIP002: ss://base64(method:password)@host:port#remark, or ss://base64(method:password@host:port)#remark
  const body = raw.replace(/^ss:\/\//i, '').split('#')[0];
  const remark = decodeURIComponent(raw.split('#')[1] || '');
  const at = body.lastIndexOf('@');
  let method;
  let password;
  let host;
  let port;
  if (at >= 0) {
    const creds = body.slice(0, at);
    const hostPart = body.slice(at + 1);
    const decoded = /[^A-Za-z0-9+/=_-]/.test(creds) ? creds : new TextDecoder().decode(base64UrlDecode(creds.replace(/\+/g, '-')));
    const sep = decoded.indexOf(':');
    if (sep < 0) return null;
    method = decoded.slice(0, sep);
    password = decoded.slice(sep + 1);
    const [h, p] = hostPart.split(':');
    host = normalizeHost(h);
    port = Number(p);
  } else {
    const decoded = new TextDecoder().decode(base64UrlDecode(body));
    const sep = decoded.indexOf(':');
    const at2 = decoded.lastIndexOf('@');
    if (sep < 0 || at2 < 0) return null;
    method = decoded.slice(0, sep);
    password = decoded.slice(sep + 1, at2);
    const [h, p] = decoded.slice(at2 + 1).split(':');
    host = normalizeHost(h);
    port = Number(p);
  }
  if (!method || !host || !port) return null;
  return {
    protocol: 'ss',
    uuid: password,
    method,
    host,
    port,
    security: 'none',
    network: 'tcp',
    path: '/',
    hostHeader: host,
    sni: '',
    fingerprint: '',
    alpn: '',
    remark: remark || `${host}:${port}`,
    flow: '',
  };
}

/* ------------------------------------------------------------------ Xray / sing-box configs */

/**
 * The Xray-core JSON for one config, the shape v2rayNG and Xray itself accept. The Android client runs it
 * inside the VPN; the Windows client does not need it (it uses sing-box) but the panel shows it too.
 */
export function buildXrayConfig(cfg, { dns = ['https://1.1.1.1/dns-query', 'https://dns.google/dns-query'] } = {}) {
  const stream = {
    network: cfg.network || 'ws',
    security: cfg.security === 'none' ? 'none' : 'tls',
  };
  if (stream.security === 'tls') {
    stream.tlsSettings = {
      serverName: cfg.sni || cfg.host,
      allowInsecure: false,
      fingerprint: cfg.fingerprint || 'chrome',
    };
    if (cfg.alpn) stream.tlsSettings.alpn = String(cfg.alpn).split(',');
  }
  if (stream.network === 'ws') {
    stream.wsSettings = { path: cfg.path || '/', headers: { Host: cfg.hostHeader || cfg.host } };
  }
  if (stream.network === 'grpc') {
    stream.grpcSettings = { serviceName: (cfg.path || '/').replace(/^\//, '') };
    delete stream.wsSettings;
  }

  const outbound =
    cfg.protocol === 'vless'
      ? {
          tag: 'proxy',
          protocol: 'vless',
          settings: { vnext: [{ address: cfg.host, port: cfg.port, users: [{ id: cfg.uuid, encryption: 'none', flow: cfg.flow || '' }] }] },
          streamSettings: stream,
        }
      : cfg.protocol === 'trojan'
        ? {
            tag: 'proxy',
            protocol: 'trojan',
            settings: { servers: [{ address: cfg.host, port: cfg.port, password: cfg.uuid }] },
            streamSettings: stream,
          }
        : {
            tag: 'proxy',
            protocol: 'shadowsocks',
            settings: { servers: [{ address: cfg.host, port: cfg.port, method: cfg.method, password: cfg.uuid }] },
            streamSettings: { network: 'tcp', security: 'none' },
          };

  return {
    log: { loglevel: 'warning' },
    // Names are resolved over DNS-over-HTTPS: a Worker can only relay TCP, so plain UDP/53 would not work.
    dns: { servers: dns, queryStrategy: 'UseIPv4' },
    inbounds: [
      { tag: 'socks-in', listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { auth: 'noauth', udp: true } },
      { tag: 'http-in', listen: '127.0.0.1', port: 10809, protocol: 'http' },
    ],
    outbounds: [outbound, { tag: 'direct', protocol: 'freedom' }, { tag: 'block', protocol: 'blackhole' }, { tag: 'dns-out', protocol: 'dns' }],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        { type: 'field', port: 53, outboundTag: 'dns-out' },
        { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
        { type: 'field', domain: ['geosite:private'], outboundTag: 'direct' },
      ],
    },
  };
}

/** The sing-box JSON for one config (the Windows client runs sing-box as a local mixed proxy). */
export function buildSingBoxConfig(cfg, { listenPort = 2080 } = {}) {
  const outbound =
    cfg.protocol === 'vless'
      ? {
          type: 'vless',
          tag: 'proxy',
          server: cfg.host,
          server_port: cfg.port,
          uuid: cfg.uuid,
          flow: cfg.flow || undefined,
          tls:
            cfg.security === 'none'
              ? undefined
              : {
                  enabled: true,
                  server_name: cfg.sni || cfg.host,
                  utls: { enabled: true, fingerprint: cfg.fingerprint || 'chrome' },
                  alpn: cfg.alpn ? String(cfg.alpn).split(',') : undefined,
                },
          transport:
            (cfg.network || 'ws') === 'ws'
              ? { type: 'ws', path: cfg.path || '/', headers: { Host: cfg.hostHeader || cfg.host } }
              : undefined,
        }
      : cfg.protocol === 'trojan'
        ? {
            type: 'trojan',
            tag: 'proxy',
            server: cfg.host,
            server_port: cfg.port,
            password: cfg.uuid,
            tls: { enabled: true, server_name: cfg.sni || cfg.host, utls: { enabled: true, fingerprint: cfg.fingerprint || 'chrome' } },
            transport: (cfg.network || 'ws') === 'ws' ? { type: 'ws', path: cfg.path || '/', headers: { Host: cfg.hostHeader || cfg.host } } : undefined,
          }
        : {
            type: 'shadowsocks',
            tag: 'proxy',
            server: cfg.host,
            server_port: cfg.port,
            method: cfg.method,
            password: cfg.uuid,
          };

  return {
    log: { level: 'warn' },
    dns: {
      servers: [{ tag: 'dns-remote', address: 'https://1.1.1.1/dns-query', detour: 'proxy' }],
      final: 'dns-remote',
      strategy: 'ipv4_only',
    },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: listenPort }],
    outbounds: [outbound, { type: 'direct', tag: 'direct' }],
    route: { rules: [{ ip_is_private: true, outbound: 'direct' }], final: 'proxy', auto_detect_interface: true },
  };
}
