import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// The browser only ever talks to its own origin: "/api" is proxied to the Worker (wrangler dev on :8787), so the same
// relative URLs work in development, in the live preview and in production. The proxy rewrites the Origin header because
// the Worker only accepts WebSocket upgrades from its own origin / allowed origins.
const target = process.env.API_TARGET ?? 'http://127.0.0.1:8787';
const proxy = {
  '/api': {
    target,
    ws: true,
    changeOrigin: true,
    configure: (p: { on: (ev: string, fn: (req: { setHeader: (k: string, v: string) => void }) => void) => void }) => {
      p.on('proxyReq', (req) => req.setHeader('origin', target));
      p.on('proxyReqWs', (req) => req.setHeader('origin', target));
    },
  },
};

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true, proxy },
  preview: { host: '0.0.0.0', port: 4173, strictPort: true, allowedHosts: true, proxy },
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 900 },
});
