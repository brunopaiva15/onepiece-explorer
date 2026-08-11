import type { NextConfig } from 'next'

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
  serverExternalPackages: [
    '@napi-rs/canvas',
    'pdfjs-dist',
    'postgres',
    'pg-boss',
    'sharp',
    'tesseract.js',
    'yauzl',
  ],

  // Private assets are only ever served through an authenticated route handler.
  // Nothing under var/ is exposed statically, and no remote image host is allowed.
  images: {
    remotePatterns: [],
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
