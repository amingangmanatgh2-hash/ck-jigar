'use strict';

/**
 * Links in, sing-box configuration out.
 *
 * The Windows client runs one `sing-box.exe` with a `mixed` inbound on 127.0.0.1:2080 and points the Windows
 * system proxy at it. Names are resolved through DNS-over-HTTPS over the tunnel, because the panel relays TCP
 * only — a plain UDP resolver would answer nothing.
 *
 * This file is also what `sing-box check` runs against in CI, so a config that would not start never ships.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a `vless://`, `trojan://` or `ss://` link. Returns null for anything else. */
function parseLink(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(':', '').toLowerCase();
  try {
    if (scheme === 'vless') return parseVless(url);
    if (scheme === 'trojan') return parseTrojan(url);
    if (scheme === 'ss') return parseShadowsocks(raw);
  } catch {
    return null;
  }
  return null;
}

function parseVless(url) {
  const uuid = decodeURIComponent(url.username || '');
  if (!UUID.test(uuid)) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return null;
  const q = url.searchParams;
  const security = (q.get('security') || 'none').toLowerCase();
  return {
    protocol: 'vless',
    name: decodeURIComponent(url.hash.replace(/^#/, '')) || `${host}:${url.port || 443}`,
    link: url.toString(),
    uuid,
    host,
    port: Number(url.port) || (security === 'tls' ? 443 : 80),
    security: security === 'none' ? 'none' : 'tls',
    network: (q.get('type') || 'tcp').toLowerCase(),
    path: q.get('path') ? decodeURIComponent(q.get('path')) : '/',
    hostHeader: q.get('host') || host,
    sni: q.get('sni') || q.get('host') || host,
    fingerprint: q.get('fp') || '',
    alpn: q.get('alpn') || '',
    flow: q.get('flow') || '',
  };
}

function parseTrojan(url) {
  const password = decodeURIComponent(url.username || url.password || '');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!password || !host) return null;
  const q = url.searchParams;
  return {
    protocol: 'trojan',
    name: decodeURIComponent(url.hash.replace(/^#/, '')) || `${host}:${url.port || 443}`,
    link: url.toString(),
    uuid: password,
    host,
    port: Number(url.port) || 443,
    security: 'tls',
    network: (q.get('type') || 'tcp').toLowerCase(),
    path: q.get('path') ? decodeURIComponent(q.get('path')) : '/',
    hostHeader: q.get('host') || host,
    sni: q.get('sni') || host,
    fingerprint: q.get('fp') || '',
    alpn: q.get('alpn') || '',
    flow: '',
  };
}

/** SIP002: ss://base64(method:password)@host:port#name */
function parseShadowsocks(raw) {
  const body = raw.replace(/^ss:\/\//i, '').split('#')[0];
  const name = decodeURIComponent(raw.split('#')[1] || '');
  const at = body.lastIndexOf('@');
  if (at < 0) return null;
  const credentials = body.slice(0, at);
  const hostPart = body.slice(at + 1);
  let decoded = credentials;
  if (!credentials.includes(':')) {
    decoded = Buffer.from(credentials.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  const method = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  const [host, port] = hostPart.split(':');
  if (!host || !port) return null;
  return {
    protocol: 'ss',
    name: name || `${host}:${port}`,
    link: raw,
    uuid: password,
    method,
    host,
    port: Number(port),
    security: 'none',
    network: 'tcp',
    path: '/',
    hostHeader: host,
    sni: host,
    fingerprint: '',
    alpn: '',
    flow: '',
  };
}

/** Every link in a subscription body (plain text or base64). */
function parseSubscription(body) {
  const text = String(body || '').trim();
  const looksEncoded = text.length > 16 && !/[\s:]/.test(text) && !/vless:|trojan:|ss:/.test(text);
  const plain = looksEncoded ? Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : text;
  return plain
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(vless|trojan|ss):\/\//i.test(line))
    .map(parseLink)
    .filter(Boolean);
}

/** The sing-box configuration for one link. */
function buildSingBox(profile, { listenPort = 2080, log = 'warn' } = {}) {
  const outbound = { tag: 'proxy', server: profile.host, server_port: profile.port };

  if (profile.protocol === 'ss') {
    Object.assign(outbound, { type: 'shadowsocks', method: profile.method, password: profile.uuid });
  } else if (profile.protocol === 'trojan') {
    Object.assign(outbound, {
      type: 'trojan',
      password: profile.uuid,
      tls: tlsBlock(profile),
    });
  } else {
    Object.assign(outbound, {
      type: 'vless',
      uuid: profile.uuid,
      ...(profile.flow ? { flow: profile.flow } : {}),
      ...(profile.security === 'none' ? {} : { tls: tlsBlock(profile) }),
    });
  }

  if (profile.protocol !== 'ss') {
    if (profile.network === 'ws') {
      outbound.transport = {
        type: 'ws',
        path: profile.path || '/',
        headers: { Host: profile.hostHeader || profile.host },
      };
    } else if (profile.network === 'grpc') {
      outbound.transport = { type: 'grpc', service_name: (profile.path || '/').replace(/^\//, '') };
    }
  }

  return {
    log: { level: log, timestamp: true },
    dns: {
      servers: [
        {
          tag: 'dns-proxy',
          address: 'https://1.1.1.1/dns-query',
          address_resolver: 'dns-direct',
          detour: 'proxy',
        },
        { tag: 'dns-direct', address: 'https://223.5.5.5/dns-query', detour: 'direct' },
      ],
      rules: [{ query_type: ['A', 'AAAA'], server: 'dns-proxy' }],
      final: 'dns-proxy',
      strategy: 'ipv4_only',
      independent_cache: true,
    },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: listenPort,
        sniff: true,
        sniff_override_destination: false,
      },
    ],
    outbounds: [outbound, { type: 'direct', tag: 'direct' }],
    route: {
      rules: [{ ip_is_private: true, outbound: 'direct' }],
      final: 'proxy',
      auto_detect_interface: true,
      default_domain_resolver: 'dns-proxy',
    },
    experimental: {
      cache_file: { enabled: true },
    },
  };
}

function tlsBlock(profile) {
  return {
    enabled: true,
    server_name: profile.sni || profile.host,
    insecure: false,
    ...(profile.fingerprint ? { utls: { enabled: true, fingerprint: profile.fingerprint } } : {}),
    ...(profile.alpn
      ? { alpn: String(profile.alpn).split(',').map((s) => s.trim()).filter(Boolean) }
      : { alpn: ['h2', 'http/1.1'] }),
  };
}

module.exports = { parseLink, parseSubscription, buildSingBox, parseVless, parseTrojan, parseShadowsocks };
