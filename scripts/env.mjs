/** Reading the Cloudflare credentials out of the environment, in the two shapes this repository uses. */
export function absorbEnvFile(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    const value = raw.trim().replace(/^["']|["']$/g, '');
    if (value && !process.env[key]) process.env[key] = value;
  }
}

export function credentials() {
  absorbEnvFile(process.env.DEPLOY_ENV);
  return {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '',
    token: process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '',
  };
}
