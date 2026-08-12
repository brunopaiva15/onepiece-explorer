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
 *
 * Rebuilt from the hero-and-pills shape it had, which said nothing about the
 * product. The three ideas that make this thing what it is — one graph, two
 * timelines, every fact sourced — are now three framed panels a reader can
 * scan, and the navigation lives in the header where it belongs instead of
 * being a row of undifferentiated buttons under a paragraph.
 */

const IDEAS = [
  {
    title: 'Un seul graphe',
    body:
      "Personnages, équipages, îles, fruits, promesses, mystères — tout dans le même " +
      'réseau. C’est là qu’apparaissent les liens auxquels on n’avait pas pensé : ' +
      'un chemin entre deux personnages, une récurrence, un recoupement à trois cents ' +
      'chapitres d’écart.',
  },
  {
    title: 'Deux temps',
    body:
      'Le temps du récit et le temps de la révélation. Chaque fait sait au chapitre près ' +
      'quand un lecteur a pu l’apprendre, ce qui permet de reposer le curseur où vous ' +
      'en êtes : le graphe redevient ce qu’on savait à ce moment-là, et rien de la ' +
      'suite ne vous est montré.',
  },
  {
    title: 'Rien sans preuve',
    body:
      'Chaque affirmation cite son chapitre, sa page, sa case et l’extrait exact. ' +
      'Ce que l’IA propose n’entre pas dans le graphe : ça entre dans une file de ' +
      'revue, et c’est vous qui tranchez.',
  },
] as const

export default async function HomePage() {
  const user = await getCurrentUser()
  const isOwner = user !== null
  const publiclyOpen = publicLibraryOwnerId() !== null

  return (
    <main id="contenu" className="mx-auto max-w-6xl px-5 py-10">
      {/* The masthead: a title that behaves like the head of a chart, not a
          marketing hero. Rule above, rule below, subtitle in the middle. */}
      {/* The title as a cover, not a hero: straw block, ink outline, hard
          shadow, and one line under it instead of three paragraphs. */}
      <section className="rayons">
        <div
          className="border-[4px] border-ink bg-[var(--accent)] px-5 py-6 text-center"
          style={{ boxShadow: 'var(--shadow-hard)' }}
        >
          <h1 className="text-ink">Ce que l&apos;on savait,<br />chapitre après chapitre</h1>
        </div>
        <p className="mx-auto mt-4 max-w-2xl text-center text-secondary">
          Un atlas construit à partir des chapitres que vous possédez. Chaque
          fait porte le numéro où il a été révélé&nbsp;— reculez le curseur, le
          graphe oublie la suite.
        </p>
      </section>

      <section className="mt-10 grid gap-5 md:grid-cols-3">
        {IDEAS.map((idea) => (
          <article key={idea.title} className="panneau">
            <h2 className="panneau-titre">{idea.title}</h2>
            <div className="panneau-corps text-[0.97rem] text-secondary">{idea.body}</div>
          </article>
        ))}
      </section>

      <section className="mt-8 grid gap-5 md:grid-cols-[2fr_1fr]">
        <div className="panneau">
          <h2 className="panneau-titre">Par où commencer</h2>
          <div className="panneau-corps">
            <ul className="space-y-3">
              <li>
                <Link href="/graph" className="font-display text-xl uppercase text-primary underline decoration-[var(--accent)] decoration-[4px] underline-offset-2 hover:decoration-[6px]">
                  Explorer le graphe
                </Link>
                <p className="text-sm text-secondary">
                  Posez le curseur de chapitre, cherchez un personnage, suivez les
                  arêtes. Le plus court chemin entre deux nœuds est souvent la
                  chose la plus intéressante de la page.
                </p>
              </li>
              <li>
                <Link href="/chronologie" className="font-display text-xl uppercase text-primary underline decoration-[var(--accent)] decoration-[4px] underline-offset-2 hover:decoration-[6px]">
                  Remonter la chronologie
                </Link>
                <p className="text-sm text-secondary">
                  Dates exactes, ordres relatifs, flashbacks et incertitudes
                  assumées — une chronologie qui dit ce qu&apos;elle ne sait pas
                  plutôt que d&apos;inventer une précision.
                </p>
              </li>
              <li>
                <Link href="/recherche" className="font-display text-xl uppercase text-primary underline decoration-[var(--accent)] decoration-[4px] underline-offset-2 hover:decoration-[6px]">
                  Chercher un nom, un lieu, une phrase
                </Link>
                <p className="text-sm text-secondary">
                  Plein texte, approximatif et par graphe. Chaque résultat dit
                  pourquoi il est là.
                </p>
              </li>
              {isOwner && (
                <li>
                  <Link href="/import" className="font-display text-xl uppercase text-primary underline decoration-[var(--accent)] decoration-[4px] underline-offset-2 hover:decoration-[6px]">
                    Importer le prochain chapitre
                  </Link>
                  <p className="text-sm text-secondary">
                    PDF, CBZ ou images. Un PDF avec couche texte évite l&apos;OCR :
                    l&apos;extraction est alors exacte et gratuite.
                  </p>
                </li>
              )}
            </ul>
          </div>
        </div>

        <aside className="panneau self-start">
          <h2 className="panneau-titre">Cette bibliothèque</h2>
          <div className="panneau-corps space-y-3 text-sm text-secondary">
            {isOwner ? (
              <>
                <p>
                  <span className="cartouche block">Accès</span>
                  Vous en êtes le propriétaire : import, traitement, revue et
                  publication.
                </p>
                <p>
                  <span className="cartouche block">Lecture publique</span>
                  {publiclyOpen
                    ? 'Ouverte. Le graphe, la chronologie et les fiches sont visibles de tous ; les pages de manga, non.'
                    : 'Fermée. Tout exige une connexion.'}
                </p>
              </>
            ) : (
              <>
                <p>
                  <span className="cartouche block">Accès</span>
                  Lecture seule. Le graphe, la chronologie, les fiches et la
                  recherche sont ouverts.
                </p>
                <p>
                  <span className="cartouche block">Ce qui reste fermé</span>
                  Les pages de manga elles-mêmes, et elles le resteront. Chaque
                  fait affiche sa référence de chapitre, de page et de case ainsi
                  que l&apos;extrait cité — de quoi tout vérifier dans votre
                  propre exemplaire.
                </p>
                <p>
                  <Link href="/connexion" className="text-accent hover:underline">
                    Se connecter
                  </Link>{' '}
                  si cette bibliothèque est la vôtre.
                </p>
              </>
            )}
            <hr className="regle" />
            <p className="text-xs text-muted">
              Aucun chapitre n&apos;est téléchargé ni récupéré en ligne : vous
              importez des fichiers que vous possédez déjà.
            </p>
          </div>
        </aside>
      </section>
    </main>
  )
}
