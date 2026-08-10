import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

// eslint-config-next 16 ships native flat configs; the FlatCompat bridge is
// no longer needed (and breaks under ESLint 10).
const config = [
  ...(Array.isArray(nextCoreWebVitals) ? nextCoreWebVitals : [nextCoreWebVitals]),
  ...(Array.isArray(nextTypescript) ? nextTypescript : [nextTypescript]),
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'var/**',
      'fixtures/generated/**',
      'drizzle/**',
    ],
  },
  {
    // Pin the React version explicitly. eslint-plugin-react's auto-detection
    // calls context.getFilename(), removed in ESLint 10, and crashes the run.
    settings: { react: { version: '19.2' } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The chapter boundary is enforced by a per-transaction session variable,
    // so every knowledge read must go through withBoundary(). Importing the
    // raw pool anywhere else would silently bypass row-level security.
    // tests/antispoiler/boundary-guards.test.ts asserts the same thing, so
    // disabling this rule inline is not enough to get past CI.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/db/client.ts', 'src/db/boundary.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/db/client',
              importNames: ['appSql', 'ingestSql', 'appDb', 'ingestDb'],
              message:
                'Accès direct au pool interdit : passez par withBoundary() (src/db/boundary.ts) pour que la frontière de chapitre soit appliquée.',
            },
          ],
        },
      ],
    },
  },
]

export default config
