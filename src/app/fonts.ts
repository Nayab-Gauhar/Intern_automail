import { Inter, Instrument_Serif, JetBrains_Mono } from 'next/font/google'

/**
 * next/font/google downloads and self-hosts at build time — no runtime request
 * to Google and no layout shift. Verified reachable from this environment; if a
 * future CI runner lacks egress, swap to next/font/local with the same variable
 * names and nothing else changes.
 */
export const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
  // Variable font: one file covers 400/500/600. Do not list weights.
  adjustFontFallback: true,
})

export const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-instrument-serif',
  weight: '400', // the only weight the family ships
  style: ['normal'], // italic exists; we do not use it
  adjustFontFallback: true,
})

export const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
  weight: ['400', '500'], // 500 for emphasised code spans only
  adjustFontFallback: true,
})

export const fontVariables = [
  inter.variable,
  instrumentSerif.variable,
  jetbrainsMono.variable,
].join(' ')
