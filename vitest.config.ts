import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
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
