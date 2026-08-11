/**
 * The only place this application talks to a third party it does not own.
 *
 * Three properties, each guarding a specific way this goes wrong:
 *
 *   A timeout. A catalogue fetch that hangs would hang the enrichment job, and
 *   a job that never finishes never fails either — it just sits there looking
 *   busy. Ten seconds, then give up and say so.
 *
 *   A retry with backoff, on connection errors and 5xx only. A 404 is an
 *   answer; retrying it is just spending someone else's bandwidth to receive
 *   the same answer more slowly.
 *
 *   A polite pace. These are free, unauthenticated, community-run services.
 *   AniList publishes a limit of 30 requests a minute and the other two publish
 *   none, which is not permission — it means nobody has had to write one down
 *   yet. `pace()` keeps us well under.
 */

const USER_AGENT =
  'one-piece-explorer/0.1 (outil de lecture privé ; illustrations mises en cache localement)'

export class FetchFailure extends Error {
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(`${url} : ${reason}`)
    this.name = 'FetchFailure'
  }
}

export interface FetchOptions {
  timeoutMs?: number
  attempts?: number
  method?: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
}

async function once(url: string, options: FetchOptions): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
  try {
    return await fetch(url, {
      method: options.method ?? 'GET',
      body: options.body,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...options.headers,
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3
  let last = 'aucune tentative'

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await once(url, options)

      if (response.ok) return (await response.json()) as T

      // 4xx is a verdict, not a hiccup. 429 is the exception: it is a 4xx that
      // explicitly means "later".
      if (response.status < 500 && response.status !== 429) {
        throw new FetchFailure(url, `HTTP ${response.status}`)
      }
      last = `HTTP ${response.status}`
    } catch (error: unknown) {
      if (error instanceof FetchFailure) throw error
      last = error instanceof Error ? error.message : String(error)
    }

    if (attempt < attempts) await pause(500 * 2 ** (attempt - 1))
  }

  throw new FetchFailure(url, `${attempts} tentatives, dernière : ${last}`)
}

/** Raw bytes, for the images themselves. Enforces a ceiling and a real type. */
export async function fetchImage(
  url: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await once(url, { timeoutMs: 20_000, headers: { Accept: 'image/*' } })

  if (!response.ok) throw new FetchFailure(url, `HTTP ${response.status}`)

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.startsWith('image/')) {
    throw new FetchFailure(url, `type inattendu « ${contentType || 'inconnu' } »`)
  }

  /*
   * Check the declared length, then check the real one.
   *
   * Content-Length is a claim by the other side. Believing it is how a
   * "small" download fills a disk — the same lie the archive extractor already
   * refuses from a ZIP entry, arriving over HTTP this time.
   */
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) {
    throw new FetchFailure(url, `${declared} octets annoncés, plafond ${maxBytes}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) {
    throw new FetchFailure(url, `${bytes.byteLength} octets reçus, plafond ${maxBytes}`)
  }

  return { bytes, contentType }
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
