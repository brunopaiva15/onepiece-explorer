import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // `server-only` throws by design when resolved outside a React Server
      // Component. Tests exercise those modules directly in Node, so it is
      // stubbed out here rather than removed from the source — the guard is
      // there to stop a server module leaking into a client bundle, which is
      // exactly what we want to keep enforcing at build time.
      'server-only': path.resolve(import.meta.dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    setupFiles: ['tests/setup.ts'],
    // Integration tests share one local PostgreSQL database; running files in
    // parallel would let one suite's fixtures race another's.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
