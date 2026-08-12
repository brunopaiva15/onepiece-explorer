import localFont from 'next/font/local'

/**
 * Two faces, chosen for volume.
 *
 * The first attempt at this interface used a 17th-century book type and a
 * humanist sans: defensible, and completely wrong for the brief. This is a tool
 * for reading manga, and the register it needs is loud — big, heavy, high
 * contrast, closer to a chapter title page than to a monograph.
 *
 * **Anton** for anything that shouts: page titles, chapter numbers, step
 * states, counts. One weight, extremely heavy, condensed enough that a large
 * size still fits. It is a poster face, and every number in this application is
 * better as a poster than as a paragraph.
 *
 * **Nunito** for everything else, at 400/600/800/900. Rounded terminals keep it
 * friendly next to Anton's slab of ink, it stays legible at 13px in a dense
 * table, and its heavy weights are heavy enough to carry a badge.
 *
 * Self-hosted, Latin subset, 170 KB for the pair: `next/font/google` downloads
 * during `next build`, which makes an offline build fail for a reason that has
 * nothing to do with the code.
 */

export const display = localFont({
  src: [{ path: './fonts/Anton-400-latin.woff2', weight: '400', style: 'normal' }],
  variable: '--font-display-loaded',
  display: 'swap',
  fallback: ['Impact', 'Haettenschweiler', 'Arial Narrow Bold', 'sans-serif'],
})

export const sans = localFont({
  src: [
    { path: './fonts/Nunito-400-latin.woff2', weight: '400', style: 'normal' },
    { path: './fonts/Nunito-600-latin.woff2', weight: '600', style: 'normal' },
    { path: './fonts/Nunito-800-latin.woff2', weight: '800', style: 'normal' },
    { path: './fonts/Nunito-900-latin.woff2', weight: '900', style: 'normal' },
  ],
  variable: '--font-sans-loaded',
  display: 'swap',
  fallback: ['Trebuchet MS', 'Segoe UI', 'system-ui', 'sans-serif'],
})
