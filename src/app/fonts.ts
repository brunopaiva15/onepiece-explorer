import localFont from 'next/font/local'

/**
 * Two families, self-hosted, and the reason for each.
 *
 * Self-hosted rather than fetched at build time: `next/font/google` downloads
 * during `next build`, which makes an offline or network-restricted build fail
 * for a reason that has nothing to do with the code. The files are in the repo,
 * Latin subset only, 190 KB for the pair.
 *
 * **IM Fell English** for titles and the wordmark. It is a digitisation of a
 * 17th-century Oxford type — uneven, inked, set by hand. That unevenness is the
 * whole point: it belongs to logbooks and printed charts, which is what this
 * application is, and no interface generated from the statistical middle of the
 * web has ever reached for it.
 *
 * **Alegreya Sans** for everything else. A humanist sans with calligraphic
 * roots, warm enough to sit under the display face without arguing with it, and
 * designed for long reading rather than for dashboards. It is doing the job
 * Inter would do, with a voice.
 */

export const display = localFont({
  src: [
    { path: './fonts/IMFellEnglish-400-latin.woff2', weight: '400', style: 'normal' },
    { path: './fonts/IMFellEnglish-400-italic-latin.woff2', weight: '400', style: 'italic' },
  ],
  variable: '--font-display-loaded',
  display: 'swap',
  // Georgia is the closest thing every machine already has: same warmth, same
  // old-style figures. The swap is then a change of texture, not of layout.
  fallback: ['Georgia', 'Times New Roman', 'serif'],
})

export const sans = localFont({
  src: [
    { path: './fonts/AlegreyaSans-400-latin.woff2', weight: '400', style: 'normal' },
    { path: './fonts/AlegreyaSans-500-latin.woff2', weight: '500', style: 'normal' },
    { path: './fonts/AlegreyaSans-700-latin.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sans-loaded',
  display: 'swap',
  fallback: ['Optima', 'Candara', 'Segoe UI', 'system-ui', 'sans-serif'],
})
