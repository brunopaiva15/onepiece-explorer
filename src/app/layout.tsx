import type { Metadata, Viewport } from 'next'
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
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body>
        <a href="#contenu" className="skip-link">
          Aller au contenu principal
        </a>
        {children}
      </body>
    </html>
  )
}
