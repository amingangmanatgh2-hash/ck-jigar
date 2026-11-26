'use strict';

/**
 * CI check: the configuration the app generates must be one `sing-box` accepts.
 *
 * It prints `::error title=…::…` lines so the reason shows up as an annotation on the run, not buried in a log.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { parseLink, buildSingBox } = require('../core/config');

const LINK =
  'vless://11111111-1111-4111-8111-111111111111@panel.example.com:443?encryption=none&type=ws&security=tls' +
  '&host=panel.example.com&path=%2Fws&sni=panel.example.com&fp=chrome&alpn=h2,http/1.1#sample';

const profile = parseLink(LINK);
if (!profile) {
  console.log('::error title=Link::the sample vless link did not parse');
  process.exit(1);
}

const config = buildSingBox(profile);
fs.writeFileSync(path.join(__dirname, '..', '..', 'sample-singbox.json'), JSON.stringify(config, null, 2));

const core = path.join(__dirname, '..', 'bin', 'sing-box.exe');
if (!fs.existsSync(core)) {
  console.log(`::error title=Core::${core} is missing`);
  process.exit(1);
}

const result = spawnSync(core, ['check', '-c', path.join(__dirname, '..', '..', 'sample-singbox.json')], { encoding: 'utf8' });
const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
console.log(output);
if (result.status !== 0) {
  console.log(`::error title=sing-box rejected the config::${output.split(/\r?\n/).slice(0, 6).join(' | ').slice(0, 800)}`);
  process.exit(1);
}
console.log('::notice title=Config::sing-box accepts the configuration this app generates');
