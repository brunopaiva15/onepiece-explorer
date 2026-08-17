import type { NextConfig } from 'next'

/*
 * Le binaire de Claude Code n'est **pas** embarqué ici, et c'est une décision.
 *
 * Ce projet a longtemps cru que le CLI était « plusieurs mégaoctets de
 * JavaScript » dans le paquet du SDK. Ce n'est plus vrai : c'est un exécutable
 * natif de trois cent dix mégaoctets, livré par un paquet optionnel propre à la
 * plateforme — `@anthropic-ai/claude-agent-sdk-linux-x64` et ses sept frères —
 * que le paquet du SDK ne contient pas et que le traceur ne suit pas. La
 * dorsale `inline` en déploiement échoue donc sur « Native CLI binary for
 * linux-x64 not found », et la tentation est grande d'ajouter le paquet aux
 * fichiers tracés.
 *
 * Elle a été essayée, derrière une garde qui ne l'ajoutait que si
 * CLAUDE_AGENT_RUNTIME=inline. Le build passait ; le déploiement, non. Trois
 * limites de plateforme s'y opposent, et il faut les franchir toutes les trois :
 *
 *   250 Mo par fonction, que le binaire crève à lui seul. Franchissable avec
 *   VERCEL_SUPPORT_LARGE_FUNCTIONS=1, qui monte la limite à 5 Go et demande
 *   Fluid compute.
 *
 *   12 fonctions par déploiement en Hobby. Ce dépôt a vingt-cinq routes, et
 *   Vercel ne tient sous la limite qu'en les fusionnant ; une inclusion posée
 *   sur `'/**'` rend chaque route trop grosse pour être fusionnée, et le
 *   déploiement entier est refusé — le site, pas la fonctionnalité. C'est ce
 *   qui est arrivé.
 *
 *   Et l'on n'embarquerait de toute façon trois cent dix mégaoctets dans
 *   `/graph`, `/recherche` et `/mentions-legales` que pour deux ou trois routes
 *   qui parlent à un modèle.
 *
 * Ce qui reste, et qui marche : `sandbox` en déploiement, où la microVM
 * installe le SDK elle-même et n'a aucune de ces limites ; et, pour les
 * balayages, le bouton « Réparations (production) » des Actions GitHub, qui
 * tourne sur un runner où rien de tout cela ne se pose.
 *
 * Si quelqu'un reprend cette idée : les motifs doivent s'arrêter aux *fichiers*
 * (`…/@anthropic-ai/&#42;/&#42;`), parce que pnpm pose le paquet de la plateforme une
 * seconde fois comme lien symbolique dans le dossier du SDK et qu'un motif qui
 * ramasse ce lien fait échouer le build sur « Is a directory (os error 21) ».
 */

const nextConfig: NextConfig = {
  reactStrictMode: true,

  experimental: {
    serverActions: {
      /*
       * A Server Action's body is capped at 1 MB by default, which is fine for a
       * form and useless for a chapter. Raised to the ingestion ceiling so a
       * self-hosted or local instance can accept a real file.
       *
       * This does nothing on a serverless host: the platform caps the request
       * before Next sees it — 4.5 MB on Vercel, not configurable. See
       * uploadTransportLimitBytes().
       */
      bodySizeLimit: Number(process.env.MAX_UPLOAD_BYTES ?? 524_288_000),
    },
  },

  // sharp, pdfjs-dist and @napi-rs/canvas are native/heavy modules that must stay
  // outside the bundler and run in the Node runtime.
  //
  // @anthropic-ai/claude-agent-sdk is here for a different reason: it does not
  // export a library so much as launch one. It resolves and spawns a bundled
  // Claude Code executable by path at runtime, and a bundler that inlined its
  // modules would rewrite the paths it resolves against. It has to stay a real
  // package in node_modules.
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    '@napi-rs/canvas',
    '@vercel/sandbox',
    'pdfjs-dist',
    'postgres',
    'pg-boss',
    'sharp',
    'tesseract.js',
    'yauzl',
  ],

  /**
   * Ship the whole Agent SDK, not the files the tracer could see.
   *
   * File tracing follows imports. The SDK's imports are a thin wrapper; the CLI
   * it actually runs is reached by a path computed at runtime, which the tracer
   * has no way to follow. Without this the package deploys as a stub that
   * resolves cleanly, builds cleanly, and fails on the first chapter with a
   * missing file.
   *
   * This only matters for CLAUDE_AGENT_RUNTIME=inline. The sandbox runtime
   * installs its own copy inside the microVM and does not read this one — but
   * the two are meant to be interchangeable, and a build where only one of them
   * works is a trap waiting for whoever flips the switch.
   *
   * Ce piège s'est refermé, et il ne se referme pas ici. Ce qui manque à
   * `inline` en déploiement est le binaire natif, et il n'est pas dans cette
   * liste : le commentaire en tête de fichier dit pourquoi, et ce qu'il a coûté
   * d'essayer. Ce qui suit reste utile sur une machine et sur un runner, où le
   * paquet de la plateforme est déjà installé à côté.
   */
  outputFileTracingIncludes: {
    '/**': ['./node_modules/@anthropic-ai/claude-agent-sdk/**'],
  },

  // Private assets are only ever served through an authenticated route handler.
  // Nothing under var/ is exposed statically, and no remote image host is allowed.
  images: {
    remotePatterns: [],
  },

  /**
   * The workshop's old addresses, kept working.
   *
   * `/import`, `/chapitres`, `/reglages` and the rest moved under `/admin` when
   * the reading site was opened to the public. Every one of them is in
   * somebody's bookmarks and in the browser's address bar autocomplete, and
   * without this they would land on the sign-in page and then on a 404 — the
   * proxy sends an anonymous request to `?suite=/import`, which no longer
   * exists. Permanent, because the move is.
   */
  async redirects() {
    const moved = [
      'connexion',
      'import',
      'chapitres',
      'runs',
      'review',
      'reglages',
      'ask',
      'etat',
    ]
    return moved.flatMap((segment) => [
      { source: `/${segment}`, destination: `/admin/${segment}`, permanent: true },
      {
        source: `/${segment}/:path*`,
        destination: `/admin/${segment}/:path*`,
        permanent: true,
      },
    ])
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
          },
        ],
      },
      {
        // Signed asset URLs are short-lived and user-scoped: never cache them
        // in a shared cache, and never let them be indexed.
        source: '/api/assets/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ]
  },
}

export default nextConfig
