import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  UUID_PATTERN,
  base64ToBytes,
  buildSingBoxConfig,
  buildSubscription,
  buildVlessLink,
  buildXrayConfig,
  cleanRemark,
  normalizeHost,
  normalizePath,
  newToken,
  newUuid,
  parseLink,
  sameSecret,
  sha256Hex,
  splitCleanIps,
} from '../src/links.js';

const UUID = '11111111-1111-4111-8111-111111111111';

test('newUuid makes a v4 UUID that the link builder accepts', () => {
  for (let i = 0; i < 50; i++) {
    const uuid = newUuid();
    assert.match(uuid, UUID_PATTERN);
    assert.equal(uuid[14], '4');
    assert.match(uuid[19], /[89ab]/);
  }
  assert.notEqual(newUuid(), newUuid());
});

test('newToken is URL-safe and long enough not to be guessed', () => {
  for (let i = 0; i < 50; i++) {
    const token = newToken();
    assert.match(token, /^[A-Za-z0-9_-]{16,64}$/);
  }
});

test('normalizeHost drops schemes, ports, paths and dots', () => {
  assert.equal(normalizeHost('https://Panel.Example.com:8443/ws?a=1'), 'panel.example.com');
  assert.equal(normalizeHost('example.com.'), 'example.com');
  assert.equal(normalizeHost('  '), '');
  assert.equal(normalizeHost('[2606:4700::1]'), '2606:4700::1');
});

test('normalizePath always starts with a slash', () => {
  assert.equal(normalizePath(''), '/ws');
  assert.equal(normalizePath('ws'), '/ws');
  assert.equal(normalizePath('/x/y'), '/x/y');
});

test('cleanRemark strips characters that would break a link', () => {
  assert.equal(cleanRemark('  ali #1 & co\n'), 'ali 1 co');
  assert.equal(cleanRemark(''), 'zeus');
});

test('buildVlessLink writes every parameter a client needs', () => {
  const link = buildVlessLink({ uuid: UUID, host: 'panel.example.com', port: 443, path: '/ws', remark: 'ali' });
  assert.match(link, /^vless:\/\/11111111-1111-4111-8111-111111111111@panel\.example\.com:443\?/);
  const q = new URL(link).searchParams;
  assert.equal(q.get('encryption'), 'none');
  assert.equal(q.get('type'), 'ws');
  assert.equal(q.get('security'), 'tls');
  assert.equal(q.get('sni'), 'panel.example.com');
  assert.equal(q.get('host'), 'panel.example.com');
  assert.equal(q.get('path'), '/ws');
  assert.equal(q.get('fp'), 'chrome');
  assert.equal(q.get('alpn'), 'h2,http/1.1');
  assert.equal(q.get('allowInsecure'), '0');
  assert.equal(q.get('packetEncoding'), 'xudp');
  assert.equal(decodeURIComponent(new URL(link).hash.slice(1)), 'ali');
});

test('buildVlessLink can dial a clean IP while keeping the real host name', () => {
  const link = buildVlessLink({ uuid: UUID, host: 'panel.example.com', address: '104.16.1.1', port: 443, remark: 'ali ip' });
  const url = new URL(link);
  assert.equal(url.hostname, '104.16.1.1');
  assert.equal(url.searchParams.get('host'), 'panel.example.com');
  assert.equal(url.searchParams.get('sni'), 'panel.example.com');
});

test('buildVlessLink brackets an IPv6 literal', () => {
  const link = buildVlessLink({ uuid: UUID, host: 'panel.example.com', address: '2606:4700::1', port: 443 });
  assert.match(link, /@\[2606:4700::1\]:443\?/);
  assert.equal(new URL(link).hostname, '[2606:4700::1]');
});

test('buildVlessLink refuses a broken UUID', () => {
  assert.throws(() => buildVlessLink({ uuid: 'nope', host: 'a.example.com' }), /invalid uuid/);
});

test('the link the panel builds is a link the panel can read back', () => {
  const link = buildVlessLink({
    uuid: UUID,
    host: 'panel.example.com',
    port: 443,
    path: '/ws',
    fingerprint: 'firefox',
    alpn: 'h2',
    fragment: '1,40-100',
    remark: 'ali',
  });
  const parsed = parseLink(link);
  assert.equal(parsed.protocol, 'vless');
  assert.equal(parsed.uuid, UUID);
  assert.equal(parsed.host, 'panel.example.com');
  assert.equal(parsed.port, 443);
  assert.equal(parsed.network, 'ws');
  assert.equal(parsed.security, 'tls');
  assert.equal(parsed.path, '/ws');
  assert.equal(parsed.fingerprint, 'firefox');
  assert.equal(parsed.alpn, 'h2');
  assert.equal(parsed.remark, 'ali');
});

test('parseLink reads trojan and shadowsocks links too', () => {
  const trojan = parseLink('trojan://pass%20word@t.example.com:8443?security=tls&type=ws&path=%2Ftj#tj');
  assert.equal(trojan.protocol, 'trojan');
  assert.equal(trojan.uuid, 'pass word');
  assert.equal(trojan.port, 8443);
  assert.equal(trojan.path, '/tj');

  const ss = parseLink('ss://YWVzLTI1Ni1nY206c2VjcmV0@1.2.3.4:8388#node');
  assert.equal(ss.protocol, 'ss');
  assert.equal(ss.method, 'aes-256-gcm');
  assert.equal(ss.uuid, 'secret');
  assert.equal(ss.host, '1.2.3.4');
  assert.equal(ss.port, 8388);
});

test('parseLink returns null instead of throwing', () => {
  assert.equal(parseLink('https://example.com'), null);
  assert.equal(parseLink('vless://not-a-uuid@host:443'), null);
  assert.equal(parseLink('vless://'), null);
  assert.equal(parseLink(''), null);
});

test('splitCleanIps keeps addresses, drops junk and duplicates the list is capped', () => {
  const ips = splitCleanIps('104.16.1.1, 104.17.2.2\nnot a host; 2606:4700::1\n[104.18.3.3]');
  assert.deepEqual(ips.slice(0, 3), ['104.16.1.1', '104.17.2.2', '2606:4700::1']);
  assert.ok(ips.includes('104.18.3.3'));
});

test('buildSubscription is base64 of the links, one per line', () => {
  const links = ['vless://a', 'vless://b'];
  const encoded = buildSubscription(links);
  assert.equal(new TextDecoder().decode(base64ToBytes(encoded)), 'vless://a\nvless://b');
  assert.equal(buildSubscription(links, { base64: false }), 'vless://a\nvless://b');
});

test('sha256Hex and sameSecret behave', async () => {
  const hash = await sha256Hex('amin_ck');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await sha256Hex('amin_ck'), hash);
  assert.notEqual(await sha256Hex('amin_ck '), hash);
  assert.equal(sameSecret('abc', 'abc'), true);
  assert.equal(sameSecret('abc', 'abd'), false);
  assert.equal(sameSecret('abc', 'ab'), false);
});

const CONFIG = {
  protocol: 'vless',
  uuid: UUID,
  host: 'panel.example.com',
  port: 443,
  security: 'tls',
  network: 'ws',
  path: '/ws',
  hostHeader: 'panel.example.com',
  sni: 'panel.example.com',
  fingerprint: 'chrome',
  alpn: 'h2,http/1.1',
  flow: '',
};

test('buildXrayConfig is a runnable Xray config that never needs UDP DNS', () => {
  const config = buildXrayConfig(CONFIG);
  const out = config.outbounds.find((o) => o.tag === 'proxy');
  assert.equal(out.protocol, 'vless');
  assert.equal(out.settings.vnext[0].users[0].id, UUID);
  assert.equal(out.streamSettings.network, 'ws');
  assert.equal(out.streamSettings.wsSettings.path, '/ws');
  assert.equal(out.streamSettings.wsSettings.headers.Host, 'panel.example.com');
  assert.equal(out.streamSettings.tlsSettings.fingerprint, 'chrome');
  assert.deepEqual(out.streamSettings.tlsSettings.alpn, ['h2', 'http/1.1']);
  assert.ok(config.dns.servers.every((s) => s.startsWith('https://')));
  assert.ok(config.inbounds.some((i) => i.protocol === 'socks'));
  assert.ok(config.routing.rules.some((r) => r.port === 53 && r.outboundTag === 'dns-out'));
});

test('buildSingBoxConfig is a mixed proxy on 127.0.0.1 with DoH', () => {
  const config = buildSingBoxConfig(CONFIG);
  assert.equal(config.inbounds[0].type, 'mixed');
  assert.equal(config.inbounds[0].listen, '127.0.0.1');
  assert.equal(config.inbounds[0].listen_port, 2080);
  const out = config.outbounds.find((o) => o.tag === 'proxy');
  assert.equal(out.type, 'vless');
  assert.equal(out.uuid, UUID);
  assert.equal(out.transport.type, 'ws');
  assert.equal(out.tls.utls.fingerprint, 'chrome');
  assert.equal(config.dns.servers[0].detour, 'proxy');
  assert.ok(config.dns.servers[0].address.startsWith('https://'));
});
