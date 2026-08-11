/**
 * Why a PostgreSQL connection string is unusable, in words that name the fix.
 *
 * The driver's own message for a malformed string is `Invalid URL`. It is true,
 * it is useless, and it costs an evening: the string is forty characters of
 * host, port and password, and nothing says which one the parser choked on.
 *
 * Almost always it is the password. Supabase generates one and a URL reserves
 * `#`, `/` and `?` — the first ends the string early, the other two are read as
 * a path and a query. A `@` in the password parses without complaint and then
 * connects to the wrong host, which is worse. So this checks for the causes in
 * the order they actually happen, and answers with the character and its
 * replacement rather than with the parser's verdict.
 *
 * No `server-only` import: this runs in the diagnostic page, which must work
 * when nothing else does, and in `pnpm doctor`, which is a script.
 */

/** Characters a URL reserves, and what to write instead inside a password. */
const RESERVED: ReadonlyArray<readonly [string, string, string]> = [
  ['#', '%23', 'le reste de la chaîne est traité comme une ancre'],
  ['/', '%2F', 'la suite est traitée comme un chemin'],
  ['?', '%3F', 'la suite est traitée comme une requête'],
]

export interface ConnectionStringIssue {
  /** What is wrong, in one line. */
  problem: string
  /** What to do about it, when there is a single obvious answer. */
  fix?: string
}

export function connectionStringIssue(
  value: string | undefined,
): ConnectionStringIssue | null {
  if (!value || value.trim() === '') {
    return { problem: "la variable n'est pas définie" }
  }

  const raw = value.trim()

  if (/^["']|["']$/.test(raw)) {
    return {
      problem: 'la valeur est entourée de guillemets',
      fix: 'Retirez-les : une ligne de .env.local ne se met pas entre guillemets.',
    }
  }

  if (/^psql\s/i.test(raw)) {
    return {
      problem: 'la valeur commence par « psql »',
      fix: "Ne gardez que l'URL, à partir de postgresql://.",
    }
  }

  if (!/^postgres(ql)?:\/\//i.test(raw)) {
    return {
      problem: "ce n'est pas une chaîne de connexion",
      fix: 'Attendu : postgresql://utilisateur:motdepasse@hôte:port/postgres',
    }
  }

  let parsed: URL | null = null
  try {
    parsed = new URL(raw)
  } catch {
    parsed = null
  }

  if (!parsed) {
    // The userinfo is everything between the scheme and the LAST `@`, because a
    // password may legitimately contain one once it is encoded.
    const afterScheme = raw.slice(raw.indexOf('://') + 3)
    const at = afterScheme.lastIndexOf('@')
    const userinfo = at === -1 ? '' : afterScheme.slice(0, at)

    for (const [char, encoded, why] of RESERVED) {
      if (userinfo.includes(char)) {
        return {
          problem: `le mot de passe contient « ${char} », que l'URL réserve — ${why}`,
          fix: `Remplacez-le par ${encoded} dans la chaîne, sans changer le mot de passe dans Supabase.`,
        }
      }
    }

    return {
      problem: 'chaîne de connexion illisible',
      fix:
        'Recopiez-la depuis Supabase (bouton Connect) et encodez les caractères ' +
        'réservés du mot de passe : # → %23, / → %2F, ? → %3F.',
    }
  }

  if (!parsed.hostname) {
    return { problem: 'chaîne de connexion sans hôte' }
  }

  if (parsed.password.includes('%5BYOUR-PASSWORD%5D') || raw.includes('[YOUR-PASSWORD]')) {
    return {
      problem: 'le mot de passe est resté [YOUR-PASSWORD]',
      fix: 'Remplacez-le par le mot de passe de la base.',
    }
  }

  return null
}

/** Host and port only — a connection string carries a password. */
export function endpointOf(value: string | undefined): string {
  if (!value) return 'non défini'
  try {
    const parsed = new URL(value.trim())
    return `${parsed.hostname}:${parsed.port || '5432'}`
  } catch {
    return 'illisible'
  }
}
