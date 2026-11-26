import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseVlessHeader, uuidToBytes } from '../src/vless.js';

const UUID = '11111111-1111-4111-8111-111111111111';

/** Build a VLESS request header the way a client does. */
function header({ uuid = UUID, command = 1, port = 443, address = 'example.com', payload = new Uint8Array([1, 2, 3]), addon = new Uint8Array(0) } = {}) {
  const addr =
    typeof address === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(address)
      ? { type: 1, bytes: Uint8Array.from(address.split('.').map(Number)) }
      : address.includes(':')
        ? {
            type: 3,
            bytes: Uint8Array.from(
              address
                .split(':')
                .flatMap((part) => {
                  const value = parseInt(part || '0', 16);
                  return [value >> 8, value & 0xff];
                }),
            ),
          }
        : { type: 2, bytes: Uint8Array.from([address.length, ...new TextEncoder().encode(address)]) };

  const out = [];
  out.push(0);
  out.push(...uuidToBytes(uuid));
  out.push(addon.length);
  out.push(...addon);
  out.push(command, port >> 8, port & 0xff, addr.type);
  out.push(...addr.bytes);
  out.push(...payload);
  return Uint8Array.from(out);
}

test('parses a TCP request to a domain', () => {
  const parsed = parseVlessHeader(header({ address: 'api.example.com', port: 8443, payload: Uint8Array.from([9, 9]) }));
  assert.equal(parsed.version, 0);
  assert.equal(parsed.uuid, UUID);
  assert.equal(parsed.command, 1);
  assert.equal(parsed.port, 8443);
  assert.equal(parsed.address, 'api.example.com');
  assert.deepEqual([...parsed.payload], [9, 9]);
});

test('parses an IPv4 destination', () => {
  const parsed = parseVlessHeader(header({ address: '1.2.3.4', command: 2 }));
  assert.equal(parsed.address, '1.2.3.4');
  assert.equal(parsed.command, 2);
});

test('parses an IPv6 destination', () => {
  const parsed = parseVlessHeader(header({ address: '2606:4700:0:0:0:0:0:1' }));
  assert.equal(parsed.address, '2606:4700:0:0:0:0:0:1');
});

test('skips the add-on it does not understand', () => {
  const parsed = parseVlessHeader(header({ addon: Uint8Array.from([0xaa, 0xbb, 0xcc]), address: 'a.example.com' }));
  assert.equal(parsed.address, 'a.example.com');
});

test('a request with no payload still parses', () => {
  const parsed = parseVlessHeader(header({ payload: new Uint8Array(0) }));
  assert.equal(parsed.payload.length, 0);
});

test('rejects anything that is not a VLESS header', () => {
  assert.equal(parseVlessHeader(new Uint8Array(0)), null);
  assert.equal(parseVlessHeader(new Uint8Array(30)), null, 'version must be 0 — all zeros is version 0 with a zero UUID');

  const wrongVersion = header();
  wrongVersion[0] = 1;
  assert.equal(parseVlessHeader(wrongVersion), null);

  const truncated = header().subarray(0, 20);
  assert.equal(parseVlessHeader(truncated), null);

  const badType = header();
  // the address type sits after version(1) + uuid(16) + addon length(1) + command(1) + port(2)
  badType[21] = 9;
  assert.equal(parseVlessHeader(badType), null);
});

test('a plain HTTP request is not a VLESS header', () => {
  const bytes = new TextEncoder().encode('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
  assert.equal(parseVlessHeader(bytes), null);
});

test('uuidToBytes round-trips', () => {
  assert.equal(uuidToBytes(UUID).length, 16);
  assert.throws(() => uuidToBytes('nope'), /invalid uuid/);
});
