import type { Metadata, Viewport } from 'next'
import { display, sans } from './fonts.ts'
import { AppShell } from './ui/app-shell.tsx'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'One Piece Explorer',
    template: '%s · One Piece Explorer',
  },
  description:
    "Graphe de connaissances temporel et anti-spoiler, construit chapitre après chapitre à partir de vos propres fichiers.",
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The chrome is sea-blue at the top and parchment below; naming both stops
  // the browser painting a white bar above the header on mobile.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#123f5e' },
    { media: '(prefers-color-scheme: dark)', color: '#10161c' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" className={`${display.variable} ${sans.variable}`} suppressHydrationWarning>
      {/* suppressHydrationWarning on the body too: password managers and
          colour-picker extensions inject attributes here before React loads,
          and the resulting console error sends people hunting for a bug in
          their own code. */}
      <body suppressHydrationWarning>
        <a href="#contenu" className="skip-link">
          Aller au contenu principal
        </a>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  )
}
