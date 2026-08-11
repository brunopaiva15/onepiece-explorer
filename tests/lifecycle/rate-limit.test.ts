import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  consume,
  pruneRateLimitEntries,
  usage,
} from '@/domains/observability/rate-limit.ts'
import { closeDb, raw, resetDatabase, seedWorld } from '../helpers/db.ts'

/**
 * The spending guard.
 *
 * Worth testing for an unusual reason: this is the only feature in the product
 * whose failure is invisible until the invoice arrives. A rate limiter that
 * silently allows everything looks exactly like one that works — every request
 * succeeds, which is what a working limiter does too, right up to the ceiling
 * nobody reaches by hand.
 *
 * So the assertions are about the ceiling actually existing, about it being
 * per-reader and per-action rather than global, and about the counters not
 * outliving their window.
 */

let userId: string

beforeEach(async () => {
  await resetDatabase()
  const world = await seedWorld([1])
  userId = world.userId
})

afterAll(async () => {
  await closeDb()
})

/** Move a user's counters back in time, to simulate a window that has passed. */
async function backdate(id: string, minutes: number): Promise<void> {
  await raw`
    UPDATE audit_log
    SET created_at = created_at - (${minutes} * interval '1 minute')
    WHERE user_id = ${id} AND action LIKE 'rate:%'
  `
}

describe('limitation de débit', () => {
  it('laisse passer jusqu’au plafond puis refuse', async () => {
    // Export has the lowest ceiling (10/h), so this is the cheapest action
    // to drive all the way to it.
    for (let i = 1; i <= 10; i += 1) {
      const verdict = await consume(userId, 'export')
      expect(verdict.allowed).toBe(true)
      expect(verdict.used).toBe(i)
      expect(verdict.retryInMinutes).toBeNull()
    }

    const refused = await consume(userId, 'export')
    expect(refused.allowed).toBe(false)
    expect(refused.used).toBe(10)
    expect(refused.max).toBe(10)
    // The reader is told when to come back, not just that they cannot.
    expect(refused.retryInMinutes).toBeGreaterThanOrEqual(1)
    expect(refused.retryInMinutes).toBeLessThanOrEqual(60)
    expect(refused.explain).not.toBe('')
  })

  it('ne compte pas une tentative refusée', async () => {
    for (let i = 0; i < 10; i += 1) await consume(userId, 'export')

    // A refused call must not extend the window it just hit. Counting it would
    // mean a loop that keeps retrying pushes its own unlock further and
    // further away — the limiter would punish the loop by never releasing.
    await consume(userId, 'export')
    await consume(userId, 'export')

    const [row] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM audit_log
      WHERE user_id = ${userId} AND action = 'rate:export'
    `
    expect(row?.count).toBe(10)
  })

  it('compte chaque action séparément', async () => {
    for (let i = 0; i < 10; i += 1) await consume(userId, 'export')

    // Exhausting exports must not lock the reader out of asking questions.
    const question = await consume(userId, 'ask')
    expect(question.allowed).toBe(true)
    expect(question.used).toBe(1)

    const counts = await usage(userId)
    expect(counts.find((entry) => entry.action === 'export')?.used).toBe(10)
    expect(counts.find((entry) => entry.action === 'ask')?.used).toBe(1)
    expect(counts.find((entry) => entry.action === 'start_run')?.used).toBe(0)
  })

  it('compte chaque lecteur séparément', async () => {
    const other = await seedWorld([1])

    for (let i = 0; i < 10; i += 1) await consume(userId, 'export')

    const theirs = await consume(other.userId, 'export')
    expect(theirs.allowed).toBe(true)
    expect(theirs.used).toBe(1)
  })

  it('libère le lecteur quand la fenêtre est passée', async () => {
    for (let i = 0; i < 10; i += 1) await consume(userId, 'export')
    expect((await consume(userId, 'export')).allowed).toBe(false)

    // The window is a sliding hour, not a quota reset at a fixed time.
    await backdate(userId, 61)

    const released = await consume(userId, 'export')
    expect(released.allowed).toBe(true)
    expect(released.used).toBe(1)
  })

  it('purge les compteurs anciens sans toucher au journal réel', async () => {
    await consume(userId, 'ask')
    await consume(userId, 'export')
    await raw`
      INSERT INTO audit_log (user_id, action, subject_kind, created_at)
      VALUES (${userId}, 'publish_delta', 'chapter', now() - interval '30 days')
    `

    await backdate(userId, 60 * 48)

    const removed = await pruneRateLimitEntries(24)
    expect(removed).toBe(2)

    const rows = await raw<Array<{ action: string }>>`
      SELECT action FROM audit_log WHERE user_id = ${userId}
    `
    // A real audit entry far older than the cutoff survives: the prefix, not
    // the age, is what decides.
    expect(rows.map((row) => row.action)).toEqual(['publish_delta'])
  })

  it('garde les compteurs encore utiles', async () => {
    await consume(userId, 'ask')

    const removed = await pruneRateLimitEntries(24)
    expect(removed).toBe(0)
    expect((await usage(userId)).find((entry) => entry.action === 'ask')?.used).toBe(1)
  })
})
