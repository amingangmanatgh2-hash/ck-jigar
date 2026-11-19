import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The web app is tested in jsdom (components) and, where a file says `@vitest-environment node`, in plain Node (WebCrypto).
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify('test') },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.{ts,tsx}'], css: false, restoreMocks: true },
});
