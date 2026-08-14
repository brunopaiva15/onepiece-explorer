import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Mentions légales',
  description:
    "Sources, licences et droits : d'où vient le contenu de One Piece Explorer et à qui appartiennent les œuvres dont il parle.",
}

/**
 * Sources, licences, droits.
 *
 * A site that publishes derived knowledge about somebody else's work owes three
 * statements, and owes them somewhere a reader can find without asking: where
 * the text came from and under what licence, who owns the work itself, and that
 * this is not affiliated with them. The footer carries the short form on every
 * page; this is the long one.
 *
 * Static on purpose — no session, no database. It is the page that must still
 * answer when the rest of the deployment cannot.
 */

function Section({
  titre,
  children,
}: {
  titre: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-8">
      <h2 className="font-display text-xl uppercase text-primary">{titre}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-secondary">
        {children}
      </div>
    </section>
  )
}

export default function MentionsLegalesPage() {
  return (
    <main id="contenu" className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="font-display text-3xl uppercase text-primary sm:text-4xl">
        Mentions légales
      </h1>
      <p className="mt-2 text-sm text-muted">
        Sources, licences et droits relatifs aux contenus présentés sur One Piece
        Explorer.
      </p>

      <Section titre="Nature du projet">
        <p>
          One Piece Explorer est un projet de fan, non commercial et non officiel.
          Il présente un graphe de connaissances daté chapitre par chapitre :
          des faits, des relations, des noms et des références de chapitre, tels
          qu&apos;ils sont connus à un point donné de la lecture.
        </p>
        <p>
          <strong className="text-primary">
            One Piece Explorer n&apos;est ni affilié, ni approuvé, ni sponsorisé par
            Eiichiro Oda, Shueisha ou Toei Animation.
          </strong>
        </p>
      </Section>

      <Section titre="Sources du contenu">
        <p>
          Les informations narratives — personnages, équipages, lieux, fruits du
          démon, événements, mystères et leurs résolutions — proviennent
          principalement du One Piece Wiki hébergé par Fandom, complété par les
          catalogues publics cités ci-dessous.
        </p>
        <p className="border-l-[3px] border-ink bg-surface-raised px-3 py-2 text-primary">
          Source : One Piece Wiki / Fandom — contenu sous licence{' '}
          <a
            href="https://creativecommons.org/licenses/by-sa/3.0/deed.fr"
            rel="noreferrer noopener nofollow"
            target="_blank"
            className="text-accent-strong underline underline-offset-2"
          >
            CC BY-SA 3.0
          </a>
          .
        </p>
        <p>
          Conformément à cette licence, les contenus dérivés du wiki restent
          diffusés sous CC BY-SA 3.0, avec attribution à leurs auteurs
          respectifs. Le One Piece Wiki est consultable sur{' '}
          <a
            href="https://onepiece.fandom.com/fr"
            rel="noreferrer noopener nofollow"
            target="_blank"
            className="text-accent-strong underline underline-offset-2"
          >
            onepiece.fandom.com
          </a>
          .
        </p>
        <p>
          Les illustrations et métadonnées d&apos;entités proviennent en outre de
          trois catalogues publics et gratuits : onepieceapi.com,
          api-onepiece.com et AniList. Chaque illustration affichée sur le site
          indique sa provenance.
        </p>
      </Section>

      <Section titre="Droits relatifs aux images">
        <p>
          Les illustrations, captures, personnages et autres éléments visuels
          issus de ONE PIECE sont la propriété de leurs ayants droit respectifs,
          notamment Eiichiro Oda, Shueisha Inc. et Toei Animation.
        </p>
        <p className="text-primary">© Eiichiro Oda/Shueisha, Toei Animation.</p>
        <p>
          Aucune planche de manga n&apos;est publiée sur ce site. Les pages et les
          cases restent hors de la partie publique : un visiteur lit la référence
          du chapitre et l&apos;extrait cité, jamais l&apos;image scannée.
        </p>
      </Section>

      <Section titre="Marques et œuvre citée">
        <p>
          ONE PIECE est une œuvre d&apos;Eiichiro Oda, publiée par Shueisha et
          adaptée en animation par Toei Animation. Les noms, titres et marques
          cités appartiennent à leurs détenteurs respectifs et ne sont utilisés
          ici qu&apos;à des fins d&apos;identification et de commentaire.
        </p>
      </Section>

      <Section titre="Signalement">
        <p>
          Si vous êtes ayant droit et estimez qu&apos;un contenu de ce site porte
          atteinte à vos droits, contactez l&apos;éditeur du site : le contenu
          concerné sera retiré.
        </p>
      </Section>

      <p className="mt-10 text-sm">
        <Link href="/" className="text-accent-strong underline underline-offset-2">
          ← Retour à l&apos;accueil
        </Link>
      </p>
    </main>
  )
}
