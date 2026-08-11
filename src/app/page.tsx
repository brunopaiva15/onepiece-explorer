import Link from 'next/link'

export default function HomePage() {
  return (
    <main id="contenu" className="mx-auto max-w-3xl px-6 py-24">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
        Journal d&apos;exploration
      </p>
      <h1 className="mt-3 text-5xl font-semibold text-primary">
        One Piece Explorer
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-secondary">
        Chaque chapitre import&eacute; agrandit un seul grand graphe
        interconnect&eacute; : personnages, groupes, lieux, objets,
        &eacute;v&eacute;nements, promesses, myst&egrave;res. C&apos;est l&agrave;
        qu&apos;apparaissent les liens auxquels on n&apos;avait pas pens&eacute;
        &mdash; un chemin entre deux personnages, une r&eacute;currence, un
        recoupement &agrave; trois cents chapitres d&apos;&eacute;cart.
      </p>
      <p className="mt-4 max-w-2xl text-secondary">
        Chaque fait sait aussi &agrave; quel chapitre vous avez pu
        l&apos;apprendre. Vous voyez tout ce que vous avez import&eacute; par
        d&eacute;faut ; le curseur sert &agrave; <em>revenir en arri&egrave;re</em>
        quand vous le voulez, pour retrouver ce que vous saviez alors &mdash; et
        &agrave; ne rien vous g&acirc;cher tant que vous n&apos;avez pas fini de
        lire.
      </p>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/import"
          className="rounded-sm bg-accent px-5 py-2.5 text-sm font-medium text-inverted transition-colors hover:bg-accent-strong"
        >
          Importer le prochain chapitre
        </Link>
        {(
          [
            ['/graph', 'Explorer le graphe'],
            ['/recherche', 'Chercher'],
            ['/ask', 'Poser une question'],
            ['/chronologie', 'Chronologie'],
            ['/chapitres', 'Chapitres'],
            ['/reglages', 'Réglages'],
          ] as const
        ).map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="rounded-sm border border-line-strong px-5 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-surface-raised"
          >
            {label}
          </Link>
        ))}
      </div>

      <p className="mt-16 border-t border-line pt-6 text-sm text-muted">
        Outil priv&eacute;. Aucun chapitre n&apos;est t&eacute;l&eacute;charg&eacute;,
        r&eacute;cup&eacute;r&eacute; en ligne ni partag&eacute; : vous importez
        des fichiers que vous poss&eacute;dez d&eacute;j&agrave;, et ils restent
        accessibles &agrave; vous seul.
      </p>
    </main>
  )
}
