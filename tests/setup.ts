import '../src/lib/load-env.ts'

/**
 * The suite runs against the local PostgreSQL 16, never against Supabase and
 * never against a live model API. Recorded model responses make the pipeline
 * tests deterministic and free, which is what lets the eight anti-spoiler
 * scenarios stay blocking in CI instead of quietly becoming "flaky".
 */
Object.assign(process.env, {
  NODE_ENV: 'test',
  TEST_DB: '1',
  MODEL_PROVIDER: process.env.MODEL_PROVIDER ?? 'replay',
  // The assistant ships switched off, because it bills per question. Blocking
  // test 8 is about whether its citations can be trusted, which is a question
  // about correctness rather than about spending — so the suite turns it on.
  ASSISTANT_ENABLED: '1',
  STORAGE_DRIVER: process.env.STORAGE_DRIVER ?? 'local',
  TEST_DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/onepiece_explorer_test',
})
