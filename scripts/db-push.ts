/**
 * Applies the SQL migrations in ./drizzle in order, then seeds the ontology.
 *
 * Migrations are hand-written rather than generated: roles, row-level security
 * policies, triggers and the Supabase/local compatibility shims cannot be
 * expressed through drizzle-kit. Drizzle is still the query layer — the schema
 * files in src/db/schema mirror this SQL, and a test asserts they agree with
 * the real database.
 *
 *   pnpm db:push        → DIRECT_URL (Supabase, direct connection)
 *   pnpm db:push:test   → TEST_DATABASE_URL (local PostgreSQL, created if absent)
 */
import '../src/lib/load-env.ts'
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import postgres from 'postgres'
import { NODE_TYPES, PREDICATES } from '../src/domains/knowledge/ontology.ts'

const IS_TEST = process.env.TEST_DB === '1'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * The text of a migration, independent of who checked it out.
 *
 * Strips the byte-order mark a Windows editor may add and folds CRLF to LF.
 * Neither changes a single SQL statement, and both change every byte after
 * them.
 */
function normalise(value: string): string {
  return value.replace(/^﻿/, '').replaceAll('\r\n', '\n')
}

const TARGET_URL = IS_TEST
  ? (process.env.TEST_DATABASE_URL ??
    'postgresql://postgres@localhost:5432/onepiece_explorer_test')
  : (process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '')

if (!TARGET_URL) {
  console.error(
    'Aucune connexion configurée.\n' +
      '  • Développement / production : renseignez DIRECT_URL dans .env.local\n' +
      '    (connexion directe Supabase, port 5432 — le pooler en mode transaction\n' +
      '     ne convient pas au DDL).\n' +
      '  • Tests : TEST_DATABASE_URL, ou lancez `pnpm db:push:test`.',
  )
  process.exit(1)
}

const MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle')

/** Create the local test database if it does not exist yet. */
async function ensureTestDatabase(url: string): Promise<void> {
  const parsed = new URL(url)
  const dbName = parsed.pathname.replace(/^\//, '')
  if (!dbName) throw new Error(`URL de test sans nom de base : ${url}`)

  const adminUrl = new URL(url)
  adminUrl.pathname = '/postgres'

  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
  try {
    const rows = await admin`
      SELECT 1 FROM pg_database WHERE datname = ${dbName}
    `
    if (rows.length === 0) {
      // Identifiers cannot be parameterised; dbName comes from our own env.
      await admin.unsafe(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`)
      console.log(`  base de test créée : ${dbName}`)
    }
  } finally {
    await admin.end({ timeout: 5 })
  }
}

async function main(): Promise<void> {
  if (IS_TEST) await ensureTestDatabase(TARGET_URL)

  const sql = postgres(TARGET_URL, {
    max: 1,
    // Migrations use multi-statement files and DO blocks; keep notices visible
    // because several of them report expected conditions (pgvector absent).
    onnotice: (n) => {
      if (n.message) console.log(`  · ${n.message}`)
    },
  })

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    const applied = new Map<string, string>(
      (await sql<{ name: string; checksum: string }[]>`
        SELECT name, checksum FROM _migrations
      `).map((r) => [r.name, r.checksum]),
    )

    for (const file of files) {
      const raw = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
      const body = normalise(raw)
      const checksum = sha256(body)
      const previous = applied.get(file)

      if (previous === checksum) {
        console.log(`= ${file}`)
        continue
      }

      /*
       * The same file, hashed on another operating system.
       *
       * The checksum used to be taken over the bytes as read. Git hands a
       * Windows checkout CRLF line endings by default, so a migration applied
       * from CI — Linux, LF — hashed differently the moment the same commit was
       * pushed from a laptop. The guard then reported a migration "applied with
       * different content", which is exactly what it is meant to catch, about a
       * file nobody had touched. Two hours to see it, and no reason to see it.
       *
       * The hash is now taken over normalised text, and a record written under
       * either of the old raw forms is recognised and rewritten. That is not a
       * loosening: a genuine edit still changes the normalised text.
       */
      if (previous !== undefined) {
        const legacy = [sha256(raw), sha256(body.replaceAll('\n', '\r\n'))]
        if (!legacy.includes(previous)) {
          throw new Error(
            `La migration ${file} a déjà été appliquée avec un contenu différent.\n` +
              `Créez une nouvelle migration plutôt que de modifier celle-ci.`,
          )
        }

        await sql`UPDATE _migrations SET checksum = ${checksum} WHERE name = ${file}`
        console.log(`= ${file} · empreinte normalisée (fins de ligne)`)
        continue
      }

      process.stdout.write(`+ ${file} … `)
      // Simple protocol: these files contain multiple statements, and Postgres
      // wraps a simple-query batch in one implicit transaction, so a failure
      // rolls the whole file back.
      await sql.unsafe(raw).simple()
      await sql`
        INSERT INTO _migrations (name, checksum) VALUES (${file}, ${checksum})
      `
      console.log('ok')
    }

    await seedOntology(sql)
    console.log('\nSchéma à jour.')
  } finally {
    await sql.end({ timeout: 10 })
  }
}

/**
 * Seeds the built-in ontology. Idempotent: built-in rows are refreshed from
 * the TypeScript source of truth, user-created predicates are left alone.
 */
async function seedOntology(sql: postgres.Sql): Promise<void> {
  for (const t of NODE_TYPES) {
    await sql`
      INSERT INTO node_types (key, label_fr, description, builtin)
      VALUES (${t.key}, ${t.labelFr}, ${t.description}, true)
      ON CONFLICT (key) DO UPDATE SET
        label_fr    = EXCLUDED.label_fr,
        description = EXCLUDED.description
      WHERE node_types.builtin
    `
  }

  for (const p of PREDICATES) {
    const inverseKey = 'inverseKey' in p ? p.inverseKey : null
    const isIdentity = 'isIdentity' in p ? Boolean(p.isIdentity) : false
    const requiresReview =
      'requiresExplicitReview' in p ? Boolean(p.requiresExplicitReview) : false

    await sql`
      INSERT INTO predicates (
        key, label_fr, is_directed, is_symmetric, inverse_key,
        subject_types, object_types, is_identity,
        requires_explicit_review, builtin, description
      ) VALUES (
        ${p.key}, ${p.labelFr}, ${p.directed}, ${p.symmetric}, ${inverseKey ?? null},
        ${sql.array([...p.subjectTypes])}, ${sql.array([...p.objectTypes])},
        ${isIdentity}, ${requiresReview}, true, ${p.description}
      )
      ON CONFLICT (key) DO UPDATE SET
        label_fr                 = EXCLUDED.label_fr,
        is_directed              = EXCLUDED.is_directed,
        is_symmetric             = EXCLUDED.is_symmetric,
        inverse_key              = EXCLUDED.inverse_key,
        subject_types            = EXCLUDED.subject_types,
        object_types             = EXCLUDED.object_types,
        is_identity              = EXCLUDED.is_identity,
        requires_explicit_review = EXCLUDED.requires_explicit_review,
        description              = EXCLUDED.description
      WHERE predicates.builtin
    `
  }

  console.log(
    `  ontologie : ${NODE_TYPES.length} types de nœud, ${PREDICATES.length} prédicats`,
  )
}

main().catch((error: unknown) => {
  console.error('\nÉchec de la migration :')
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
