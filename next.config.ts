import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,

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
