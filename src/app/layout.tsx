import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { fontVariables } from './fonts'
import './globals.css'

/**
 * The root layout. Deliberately thin: it establishes the document, loads the three
 * self-hosted families as CSS variables, and pulls in the token stylesheet. Chrome
 * belongs to a route group — the marketing pages and the authenticated shell share
 * nothing but the <html> element.
 *
 * `fontVariables` goes on <html> rather than <body> so the variables are in scope for
 * anything portalled outside the body tree later (dialogs, toasts).
 */

export const metadata: Metadata = {
  title: {
    default: 'Instant Mail',
    template: '%s · Instant Mail',
  },
  description:
    'Cold email outreach that runs itself: multi-step sequences from real mailboxes, with replies detected and sequences stopped automatically.',
  applicationName: 'Instant Mail',
  // Outreach tooling has no business being indexed or previewed by crawlers.
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The ground colour, so the browser chrome matches the page on mobile.
  themeColor: '#FBFAF8',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>
      <body>{children}</body>
    </html>
  )
}
