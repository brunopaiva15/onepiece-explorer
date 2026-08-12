import type { Metadata, Viewport } from 'next'
import { display, sans } from './fonts.ts'
import { AppShell } from './ui/app-shell.tsx'
import { getDict, getLocale } from '@/lib/i18n/server.ts'
import './globals.css'

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict()
  return {
    title: {
      default: 'One Piece Explorer',
      template: '%s · One Piece Explorer',
    },
    description: dict.shell.metadataDescription,
    robots: { index: false, follow: false },
  }
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

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale()
  const dict = await getDict()
  return (
    <html
      lang={locale}
      className={`${display.variable} ${sans.variable}`}
      suppressHydrationWarning
    >
      {/* suppressHydrationWarning on the body too: password managers and
          colour-picker extensions inject attributes here before React loads,
          and the resulting console error sends people hunting for a bug in
          their own code. */}
      <body suppressHydrationWarning>
        <a href="#contenu" className="skip-link">
          {dict.shell.skipToContent}
        </a>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  )
}
