import type { NextConfig } from 'next'

/**
 * Le CLI que le SDK lance, et ce qu'il faut embarquer pour qu'il existe.
 *
 * Ce projet a longtemps cru que Claude Code était « plusieurs mégaoctets de
 * JavaScript » à l'intérieur du paquet du SDK. Ce n'est plus vrai, et le
 * démenti a coûté un balayage : le CLI est un **exécutable natif** de trois
 * cents mégaoctets, livré par un paquet optionnel propre à la plateforme —
 * `@anthropic-ai/claude-agent-sdk-linux-x64` et ses sept frères — que le paquet
 * du SDK ne contient pas et que le traceur ne voit pas. Embarquer le SDK seul
 * donnait une installation qui se résout, un build qui passe, et « Native CLI
 * binary for linux-x64 not found » au premier appel.
 *
 * Alors pourquoi ne pas l'embarquer toujours ? Parce qu'une fonction Vercel
 * plafonne à 250 Mo décompressés et que le binaire en pèse plus à lui seul :
 * l'inclure sans y penser ferait échouer le *déploiement entier* — le site,
 * pas la fonctionnalité — pour une dorsale que la plupart des installations
 * n'utilisent pas. Il n'est donc embarqué que quand on a demandé `inline`, ce
 * qui est exactement le moment où on en a besoin.
 *
 * L'autre moitié n'est pas ici et ne peut pas y être : au-delà de 250 Mo il
 * faut aussi que le projet ait le droit de déployer une grosse fonction
 * (`VERCEL_SUPPORT_LARGE_FUNCTIONS=1`, qui demande Fluid compute, et qui monte
 * la limite à 5 Go). Une variable de projet chez l'hébergeur ; rien qu'un
 * fichier de configuration puisse poser.
 *
 * Les deux dispositions sont listées parce que les deux existent : `.pnpm/`
 * pour l'installation de ce dépôt, et le chemin à plat pour npm et yarn.
 *
 * Et les motifs s'arrêtent aux *fichiers* — `…/@anthropic-ai/&#42;/&#42;` et non
 * `…/@anthropic-ai/&#42;&#42;`. Sous pnpm, le paquet de la plateforme apparaît une
 * seconde fois comme lien symbolique dans le dossier du SDK ; un motif qui
 * ramasse ce lien fait échouer le build entier sur « Is a directory (os error
 * 21) », le traceur essayant de lire un dossier comme un fichier.
 */
function claudeCodeFiles(): string[] {
  const sdk = ['./node_modules/@anthropic-ai/claude-agent-sdk/**']

  if (process.env.CLAUDE_AGENT_RUNTIME?.trim() !== 'inline') return sdk

  return [
    ...sdk,
    './node_modules/@anthropic-ai/claude-agent-sdk-*/*',
    './node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-*/node_modules/@anthropic-ai/*/*',
  ]
}

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
   * works is a trap waiting for whoever flips the switch. Ce piège s'est
   * refermé : voir `claudeCodeFiles`, qui dit ce qu'il manquait et pourquoi il
   * n'est ajouté que sur demande.
   */
  outputFileTracingIncludes: {
    '/**': claudeCodeFiles(),
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
