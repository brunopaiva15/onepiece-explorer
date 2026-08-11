import { config } from 'dotenv'

/**
 * Load the same environment files Next.js loads, for everything that is not
 * Next.js.
 *
 * This exists because of a trap that cost an installation. The README says to
 * put your configuration in `.env.local` — which is right, and which is what
 * `next dev` and `next build` read. But `import 'dotenv/config'`, which every
 * script and the worker used, reads **`.env` and nothing else**. Follow the
 * README and the web application works perfectly while `pnpm db:push`,
 * `pnpm doctor` and `pnpm worker` all report that DATABASE_URL is not
 * configured — three commands failing for a reason the error message cannot
 * point at, on step three of the installation.
 *
 * Precedence matches Next.js, and matters in both directions:
 *
 *   a real environment variable  >  .env.local  >  .env
 *
 * A variable already present in `process.env` always wins, which is what lets
 * CI set `TEST_DATABASE_URL` on the job and lets `TEST_DB=1 pnpm demo` override
 * a developer's local file. `.env.local` is gitignored and holds the secrets;
 * `.env` is for anything shared and harmless, and simply fills the gaps.
 *
 * Import this for its side effect, before anything that reads `process.env`:
 *
 *   import '../src/lib/load-env.ts'
 */
config({
  path: ['.env.local', '.env'],
  // dotenv 17 prints a promotional line on every load. Nine scripts, one line
  // each, in front of output people actually need to read.
  quiet: true,
})
