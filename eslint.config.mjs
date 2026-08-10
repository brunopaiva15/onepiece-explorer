import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({ baseDirectory: __dirname })

const config = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['.next/**', 'node_modules/**', 'var/**', 'fixtures/generated/**'],
  },
  {
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
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/db/client.ts', 'src/db/boundary.ts', 'src/worker/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/db/client',
              importNames: ['appPool', 'ingestPool'],
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
