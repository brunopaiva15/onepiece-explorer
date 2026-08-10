import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

// Migrations always run over the DIRECT connection (port 5432 on Supabase).
// The transaction pooler cannot carry DDL sessions reliably.
const url =
  process.env.TEST_DB === '1'
    ? (process.env.TEST_DATABASE_URL ??
      'postgresql://postgres@localhost:5432/onepiece_explorer_test')
    : (process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '')

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  verbose: true,
  strict: true,
})
