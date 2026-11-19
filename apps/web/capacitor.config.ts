import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android app is the same web app (apps/web/dist) in a native shell. It talks to the deployed Worker over HTTPS: the address
 * is compiled in (VITE_API_BASE, VITE_API_BASES) and/or typed by the user on the first screen — there is deliberately no
 * `server.url`, so the app never loads its code from the network and keeps working offline.
 * See docs/android.md.
 */
const config: CapacitorConfig = {
  appId: 'chat.amin.app',
  appName: 'AMIN CHAT',
  webDir: 'dist',
  android: {
    // https only: a page served from https://localhost must not be able to call plain-http addresses
    allowMixedContent: false,
    // shown while the WebView starts (matches the web manifest's background)
    backgroundColor: '#ffffff',
  },
  server: {
    // the WebView's own origin is https://localhost, which the Worker trusts for CORS (see apps/api/src/middleware/common.ts)
    androidScheme: 'https',
  },
};

export default config;
