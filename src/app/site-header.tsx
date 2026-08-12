import Link from 'next/link'

/**
 * The chrome the application never had.
 *
 * Every page was a bare centred column: no header, no navigation, no footer,
 * nothing saying where you were or what else existed. That absence is most of
 * why the interface read as generated — a page with no place is the default
 * output of having decided nothing.
 *
 * **It must survive a broken configuration.** This renders above `/etat`, the
 * diagnostic page whose entire promise is answering when nothing else does, so
 * the session lookup is wrapped: a header that threw would take that page down
 * with it, which is the exact failure the proxy already had to be fixed for.
 */

const READING = [
  ['/graph', 'Graphe'],
  ['/recherche', 'Recherche'],
  ['/chronologie', 'Chronologie'],
  ['/mysteres', 'Mystères'],
] as const

const OWNER = [
  ['/chapitres', 'Chapitres'],
  ['/import', 'Importer'],
  ['/reglages', 'Réglages'],
] as const

/**
 * A compass rose, drawn here rather than borrowed.
 *
 * Eight points, the cardinals long and inked, the ordinals short and hollow —
 * the rose of a portolan chart. No official asset of any work appears in this
 * application, and this is the mark that stands in for one.
 */
function CompassRose({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      <circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" strokeWidth="0.75" opacity="0.3" />
      {/* Ordinals: short, hollow. */}
      <g opacity="0.55">
        <path d="M24 24 L34 14 L24 8 Z M24 24 L34 14 L40 24 Z" fill="none" stroke="currentColor" strokeWidth="0.75" />
        <path d="M24 24 L14 14 L24 8 Z M24 24 L14 14 L8 24 Z" fill="none" stroke="currentColor" strokeWidth="0.75" />
        <path d="M24 24 L34 34 L40 24 Z M24 24 L34 34 L24 40 Z" fill="none" stroke="currentColor" strokeWidth="0.75" />
        <path d="M24 24 L14 34 L8 24 Z M24 24 L14 34 L24 40 Z" fill="none" stroke="currentColor" strokeWidth="0.75" />
      </g>
      {/* Cardinals: long, half-inked, so the rose reads at 20px. */}
      <path d="M24 2 L27 24 L24 46 L21 24 Z" fill="currentColor" opacity="0.15" />
      <path d="M24 2 L27 24 L24 46" fill="currentColor" />
      <path d="M2 24 L24 21 L46 24 L24 27 Z" fill="currentColor" opacity="0.15" />
      <path d="M2 24 L24 21 L46 24" fill="currentColor" />
      <circle cx="24" cy="24" r="2" fill="currentColor" />
    </svg>
  )
}

export async function SiteHeader() {
  let isOwner = false
  try {
    const { getCurrentUser } = await import('@/domains/auth/server.ts')
    isOwner = (await getCurrentUser()) !== null
  } catch {
    // Unconfigured or unreachable auth. The reading links still make sense, and
    // /etat below will say what is wrong.
    isOwner = false
  }

  const links = [...READING, ...(isOwner ? OWNER : [])]

  return (
    <header className="border-b border-line-strong bg-[var(--sea-deep)] text-[var(--sea-ink)]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
        <Link href="/" className="flex items-center gap-3 no-underline">
          <CompassRose className="h-9 w-9 shrink-0 text-[var(--brass)]" />
          <span className="flex flex-col leading-none">
            <span className="font-display text-xl tracking-wide text-[var(--sea-ink)]">
              One Piece Explorer
            </span>
            {/* --sea-soft is a *surface* in the dark palette, so using it for
                text there put ink on ink. The wordmark sits on sea blue in both
                themes, so its subtitle takes the same ink at lower weight. */}
            <span className="mt-0.5 text-[0.65rem] uppercase tracking-[0.2em] text-[var(--sea-ink)] opacity-65">
              Journal d&apos;exploration
            </span>
          </span>
        </Link>

        <nav aria-label="Navigation principale" className="ml-auto flex flex-wrap items-center gap-1">
          {links.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="px-2.5 py-1.5 text-sm text-[var(--sea-ink)] no-underline opacity-85 transition-opacity hover:opacity-100 hover:underline underline-offset-4"
            >
              {label}
            </Link>
          ))}
          {!isOwner && (
            <Link
              href="/connexion"
              className="ml-2 border border-[var(--brass)] px-3 py-1.5 text-sm text-[var(--brass)] no-underline hover:bg-[var(--brass)] hover:text-[var(--sea-deep)]"
            >
              Se connecter
            </Link>
          )}
        </nav>
      </div>

      {/* The brass rule that separates chrome from paper, on every page. */}
      <div className="h-[2px] bg-gradient-to-r from-transparent via-[var(--brass)] to-transparent" />
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="mx-auto mt-16 max-w-6xl px-5 pb-10">
      <hr className="regle" />
      <p className="mt-4 text-xs text-muted">
        Bibliothèque privée. Les pages importées restent derrière
        l&apos;authentification et ne sont jamais servies par une URL publique
        permanente. Aucun logo, police ou illustration officiels ne sont
        utilisés&nbsp;: la direction artistique est originale.{' '}
        <Link href="/etat" className="underline underline-offset-2 hover:text-secondary">
          État du déploiement
        </Link>
      </p>
    </footer>
  )
}
