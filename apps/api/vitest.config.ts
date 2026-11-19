import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
      return {
        wrangler: { configPath: './wrangler.test.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // The cold file tier is configured for tests (against the fake Google server below); the credentials match it.
            GOOGLE_CLIENT_ID: 'test-client',
            GOOGLE_CLIENT_SECRET: 'test-secret',
            GOOGLE_REFRESH_TOKEN: 'test-refresh',
            RELAY_SECRET: 'test-relay-secret',
          },
          serviceBindings: {
            AI: { name: 'fake-ai', entrypoint: 'FakeAI' },
            GOOGLE_API: { name: 'fake-google', entrypoint: 'FakeGoogle' },
          },
          workers: [
            { name: 'fake-ai', modules: true, scriptPath: 'test/fake-ai/worker.mjs', compatibilityDate: '2026-09-20' },
            { name: 'fake-google', modules: true, scriptPath: 'test/fake-google/worker.mjs', compatibilityDate: '2026-09-20' },
          ],
        },
      };
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
  },
});
