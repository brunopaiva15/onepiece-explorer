'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * A rail entry that knows whether it is the current one.
 *
 * The old navigation gave no indication of where you were — seven identical
 * links, on every page, forever. Knowing your position is the cheapest
 * orientation an interface can offer and it was simply missing.
 */

const ICONS: Record<string, string> = {
  // Simple, drawn from primitives so they read at 16px and owe nothing to any
  // icon set that would date the interface.
  graph: 'M5 12h4m6 0h4M7 7l5 5-5 5m10-10l-5 5 5 5',
  time: 'M12 6v6l4 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  mystery: 'M9 9a3 3 0 116 0c0 2-3 2.5-3 4.5M12 18h.01',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4.5-4.5',
  book: 'M4 5h7v14H4zM13 5h7v14h-7z',
  upload: 'M12 16V5m0 0L8 9m4-4l4 4M4 19h16',
  ask: 'M4 5h16v11H9l-5 4z',
  gear: 'M12 9a3 3 0 100 6 3 3 0 000-6zM4 12h2m12 0h2M12 4v2m0 12v2',
}

export function RailLink({
  href,
  label,
  icon,
}: {
  href: string
  label: string
  icon: keyof typeof ICONS | string
}) {
  const pathname = usePathname()
  const active = pathname === href || pathname.startsWith(`${href}/`)

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`etiquette flex items-center gap-2.5 border-[3px] px-2.5 py-1.5 text-sm no-underline transition-colors ${
        active
          ? 'border-ink bg-[var(--accent)] text-ink'
          : 'border-transparent text-white hover:border-ink hover:bg-white/10'
      }`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 shrink-0">
        <path
          d={ICONS[icon] ?? ICONS.graph}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {label}
    </Link>
  )
}
