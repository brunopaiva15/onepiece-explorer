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
        Chaque chapitre importé agrandit un graphe de connaissances o&ugrave;
        tout fait sait &agrave; quel chapitre le lecteur a pu l&apos;apprendre.
        D&eacute;placez le curseur de chapitre et l&apos;&oelig;uvre se
        rétr&eacute;cit &agrave; ce que vous saviez alors.
      </p>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/import"
          className="rounded-sm bg-accent px-5 py-2.5 text-sm font-medium text-inverted transition-colors hover:bg-accent-strong"
        >
          Importer le prochain chapitre
        </Link>
        <Link
          href="/graph"
          className="rounded-sm border border-line-strong px-5 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-surface-raised"
        >
          Explorer le graphe
        </Link>
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
