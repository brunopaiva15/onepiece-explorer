import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { DEFAULT_LOCALE, LANG_COOKIE, isLocale, type Locale } from './index.ts'
import { getDictFor, type Dict } from './dictionaries.ts'

/**
 * The language of the current request.
 *
 * A signed-in reader's preference is their profile (through the session, which
 * every page resolves anyway — no extra query); an anonymous visitor's is the
 * cookie their toggle set; absent both, French, the language every profile
 * starts with.
 *
 * Degrades rather than throws, deliberately: this is called from the root
 * layout, which must render above `/etat` even when authentication is
 * unconfigured or the database is down.
 */
export const getLocale = cache(async (): Promise<Locale> => {
  try {
    const { getCurrentUser } = await import('@/domains/auth/server.ts')
    const user = await getCurrentUser()
    if (user) {
      const { getReaderSession } = await import('@/domains/auth/session.ts')
      return (await getReaderSession()).locale
    }
  } catch {
    // Unconfigured auth or unreachable database: fall through to the cookie.
  }

  try {
    const jar = await cookies()
    const value = jar.get(LANG_COOKIE)?.value
    if (isLocale(value)) return value
  } catch {
    // Outside a request context.
  }

  return DEFAULT_LOCALE
})

/** The dictionary for the current request. */
export async function getDict(): Promise<Dict> {
  return getDictFor(await getLocale())
}
