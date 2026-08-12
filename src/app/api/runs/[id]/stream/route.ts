import type { NextRequest } from 'next/server'
import { getCurrentUser } from '@/domains/auth/server.ts'
import { getRun } from '@/domains/pipeline/runs.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Serverless hosts kill a function at a fixed ceiling, and this one holds a
 * connection open on purpose.
 *
 * Vercel's Hobby default is 60 seconds — long enough to watch a step finish,
 * far short of a chapter. 300 is the Hobby maximum. Asking for it here is
 * harmless everywhere else: on a normal Node server the value is ignored, and
 * the stream's own ten-minute ceiling still applies.
 *
 * What happens when the host cuts it is already handled: the client reconnects
 * and re-reads the run's current state, because the stream reports state rather
 * than replaying events. A dropped connection loses nothing.
 */
export const maxDuration = 300

/**
 * Server-sent events for a run's progress.
 *
 * SSE rather than a WebSocket: the traffic is one-directional, it is a few
 * hundred bytes every couple of seconds, and it survives a proxy that would
 * refuse an upgrade. Rather than client-side polling because a progress view
 * that only updates when the user's timer fires makes a fast step look like it
 * never ran.
 *
 * The server polls the database and pushes changes. That is honest about what
 * is happening — the pipeline writes rows, this reads them — and it means a
 * dropped connection loses nothing: reconnecting re-reads the current state
 * instead of replaying a missed event.
 */

const POLL_MS = 1_000
/** Stop streaming a finished run rather than holding the connection open. */
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
/** Ceiling so an abandoned tab cannot hold a connection indefinitely. */
const MAX_DURATION_MS = 10 * 60 * 1_000

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  const user = await getCurrentUser()
  if (!user) {
    return new Response('Authentification requise', { status: 401 })
  }

  // Ownership is checked here and again on every read inside getRun(), which
  // filters on the verified uid. A run id is a UUID, but guessability is not
  // the protection — the ownership filter is.
  const initial = await getRun(user.id, id)
  if (!initial) {
    return new Response('Introuvable', { status: 404 })
  }

  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      const started = Date.now()

      function send(event: string, data: unknown): void {
        if (closed) return
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        )
      }

      send('state', initial)
      if (TERMINAL.has(initial.run.status)) {
        controller.close()
        closed = true
        return
      }

      let previous = JSON.stringify(initial)

      while (!closed) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        if (closed) break

        if (Date.now() - started > MAX_DURATION_MS) {
          // Tell the client why, so it can reconnect deliberately rather than
          // showing a stalled bar.
          send('timeout', { reason: 'Flux interrompu après dix minutes.' })
          break
        }

        let current
        try {
          current = await getRun(user.id, id)
        } catch (error) {
          send('error', {
            message: error instanceof Error ? error.message : 'Lecture impossible.',
          })
          break
        }

        if (!current) break

        const serialised = JSON.stringify(current)
        if (serialised !== previous) {
          previous = serialised
          send('state', current)
        }

        if (TERMINAL.has(current.run.status)) break
      }

      if (!closed) {
        closed = true
        controller.close()
      }
    },

    cancel() {
      // The reader went away — a closed tab, a navigation. Stop polling.
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      // Nginx buffers responses by default, which would hold every event until
      // the stream closed and defeat the entire point.
      'X-Accel-Buffering': 'no',
    },
  })
}
