import Link from 'next/link'

/**
 * The head of a page: a title big enough to be one, and the action that
 * belongs to it.
 *
 * Every page grew its own version of this — a breadcrumb in 14px grey, an h1,
 * a button floated right — and no two agreed on spacing or size. One component
 * means a page looks like this application before anyone has read a word of it.
 */
export function PageTitle({
  title,
  lead,
  back,
  action,
}: {
  title: string
  /** One line, at most. If it needs two, it belongs in a panel. */
  lead?: string
  back?: { href: string; label: string }
  action?: React.ReactNode
}) {
  return (
    <header className="rayons">
      {back && (
        <Link
          href={back.href}
          className="etiquette text-sm text-muted no-underline hover:text-primary"
        >
          ‹ {back.label}
        </Link>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-primary">{title}</h1>
        {action}
      </div>
      {lead && <p className="mt-2 max-w-3xl text-secondary">{lead}</p>}
      <hr className="regle mt-3" />
    </header>
  )
}
