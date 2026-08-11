import Link from 'next/link'
import { getCurrentUser } from '@/domains/auth/server.ts'
import { publicLibraryOwnerId } from '@/lib/env.ts'

export const dynamic = 'force-dynamic'

/**
 * The front door, which now has two kinds of visitor.
 *
 * The owner gets the whole toolbox. Anyone else gets the reading half and is
 * told plainly what they cannot do and why — a row of buttons that all bounce
 * off a sign-in page would be worse than no buttons, and "you cannot import
 * because this is somebody's private library" is information, not a refusal.
 */
export default async function HomePage() {
  const user = await getCurrentUser()
  const isOwner = user !== null
  const publiclyOpen = publicLibraryOwnerId() !== null

  const readingLinks = [
    ['/graph', 'Explorer le graphe'],
    ['/recherche', 'Chercher'],
    ['/chronologie', 'Chronologie'],
  ] as const

  const ownerLinks = [
    ['/ask', 'Poser une question'],
    ['/chapitres', 'Chapitres'],
    ['/reglages', 'Réglages'],
  ] as const

  return (
    <main id="contenu" className="mx-auto max-w-3xl px-6 py-24">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
        Journal d&apos;exploration
      </p>
      <h1 className="mt-3 text-5xl font-semibold text-primary">
        One Piece Explorer
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-secondary">
        Un seul grand graphe interconnect&eacute; : personnages, groupes, lieux,
        objets, &eacute;v&eacute;nements, promesses, myst&egrave;res. C&apos;est
        l&agrave; qu&apos;apparaissent les liens auxquels on n&apos;avait pas
        pens&eacute; &mdash; un chemin entre deux personnages, une
        r&eacute;currence, un recoupement &agrave; trois cents chapitres
        d&apos;&eacute;cart.
      </p>
      <p className="mt-4 max-w-2xl text-secondary">
        Chaque fait sait &agrave; quel chapitre on a pu l&apos;apprendre. Le
        curseur sert &agrave; <em>revenir en arri&egrave;re</em> : posez-le
        o&ugrave; vous en &ecirc;tes de votre lecture et le graphe redevient ce
        qu&apos;on savait &agrave; ce moment-l&agrave;. Rien de la suite ne vous
        sera montr&eacute;.
      </p>

      <div className="mt-10 flex flex-wrap gap-3">
        {isOwner && (
          <Link
            href="/import"
            className="rounded-sm bg-accent px-5 py-2.5 text-sm font-medium text-inverted transition-colors hover:bg-accent-strong"
          >
            Importer le prochain chapitre
          </Link>
        )}

        {[...readingLinks, ...(isOwner ? ownerLinks : [])].map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className={
              isOwner
                ? 'rounded-sm border border-line-strong px-5 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-surface-raised'
                : 'rounded-sm bg-accent px-5 py-2.5 text-sm font-medium text-inverted transition-colors hover:bg-accent-strong'
            }
          >
            {label}
          </Link>
        ))}
      </div>

      {!isOwner && (
        <p className="mt-8 max-w-2xl rounded-sm border border-line bg-surface-raised p-4 text-sm text-secondary">
          Vous consultez une biblioth&egrave;que en lecture seule. Le graphe, la
          chronologie, les fiches et la recherche sont ouverts ; les pages de
          manga elles-m&ecirc;mes ne le sont pas, et ne le seront pas. Chaque
          fait affiche sa r&eacute;f&eacute;rence de chapitre, de page et de case
          ainsi que l&apos;extrait cit&eacute; &mdash; de quoi tout
          v&eacute;rifier dans votre propre exemplaire.
        </p>
      )}

      <p className="mt-16 border-t border-line pt-6 text-sm text-muted">
        {publiclyOpen ? (
          <>
            Le graphe est public&nbsp;; les chapitres ne le sont pas. Aucun
            chapitre n&apos;est t&eacute;l&eacute;charg&eacute; ni
            r&eacute;cup&eacute;r&eacute; en ligne, et aucune page
            import&eacute;e n&apos;est servie sans authentification &mdash; ni
            par une URL publique permanente.
          </>
        ) : (
          <>
            Outil priv&eacute;. Aucun chapitre n&apos;est
            t&eacute;l&eacute;charg&eacute;, r&eacute;cup&eacute;r&eacute; en
            ligne ni partag&eacute; : vous importez des fichiers que vous
            poss&eacute;dez d&eacute;j&agrave;, et ils restent accessibles
            &agrave; vous seul.
          </>
        )}
      </p>

      {!isOwner && (
        <p className="mt-4 text-sm text-muted">
          <Link href="/connexion" className="text-accent hover:underline">
            Se connecter
          </Link>{' '}
          si cette biblioth&egrave;que est la v&ocirc;tre.
        </p>
      )}
    </main>
  )
}
