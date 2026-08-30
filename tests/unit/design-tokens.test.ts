import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * Design-token tests.
 *
 * globals.css IS the Tailwind v4 configuration — there is no tailwind.config.js —
 * so a deleted token silently removes a utility class, and every component using it
 * renders unstyled with no error anywhere. These assert the contract the components
 * were written against.
 */

const css = readFileSync(new URL('../../src/app/globals.css', import.meta.url), 'utf8')

describe('structure', () => {
  test('imports tailwind exactly once', () => {
    expect(css.match(/^@import ['"]tailwindcss['"];/gm)).toHaveLength(1)
  })

  test('declares :root tokens and maps them under @theme', () => {
    expect(css).toContain(':root {')
    // @theme must be top-level and appear once, or Tailwind ignores the mapping.
    expect(css.match(/^@theme inline \{/gm)).toHaveLength(1)
  })
})

describe('the brief’s locked colour values are intact', () => {
  test.each([
    ['--bg', '#FBFAF8'],
    ['--ink', '#0F1E37'],
    ['--accent', '#1B3A6B'],
    ['--border', '#E6E2DA'],
    ['--surface', '#FFFFFF'],
    ['--bg-subtle', '#F5F3EF'],
  ])('%s is %s', (token, value) => {
    // These are named in the locked brief. Drifting one changes the product's
    // identity, so they are pinned rather than reviewed by eye.
    expect(css).toMatch(new RegExp(`${token}:\\s*${value}`, 'i'))
  })

  test('the ground is never pure white', () => {
    const bg = /--bg:\s*(#[0-9a-f]{6})/i.exec(css)?.[1]?.toUpperCase()
    expect(bg).not.toBe('#FFFFFF')
  })
})

describe('semantic tokens the components depend on', () => {
  test.each([
    ['--ink-secondary'],
    ['--ink-meta'],
    ['--ink-muted'],
    ['--ink-inverse'],
    ['--accent-hover'],
    ['--accent-subtle'],
    ['--border-strong'],
    ['--border-control'],
    ['--success'],
    ['--warning'],
    ['--danger'],
    ['--info'],
    ['--ring'],
    ['--overlay'],
    ['--radius-sm'],
    ['--radius-md'],
    ['--radius-lg'],
    ['--radius-pill'],
    ['--shadow-xs'],
    ['--shadow-md'],
    ['--font-sans'],
    ['--font-serif'],
    ['--font-mono'],
    ['--duration-fast'],
    ['--ease-out'],
    ['--z-modal'],
    ['--z-toast'],
    ['--z-tooltip'],
  ])('%s is declared', (token) => {
    expect(css).toContain(`${token}:`)
  })
})

describe('the type scale carries its own metrics', () => {
  test.each([
    ['display-xl'],
    ['display-lg'],
    ['display-md'],
    ['heading'],
    ['subheading'],
    ['body'],
    ['body-sm'],
    ['label'],
    ['caption'],
    ['mono'],
  ])('text-%s defines size and line-height', (role) => {
    expect(css).toContain(`--text-${role}:`)
    // Without the paired line-height the utility silently inherits, which is how
    // an editorial layout turns into a cramped one.
    expect(css).toContain(`--text-${role}--line-height:`)
  })

  test('display roles stay at weight 400', () => {
    // Serif display at 600+ reads as a generic dashboard heading.
    for (const role of ['display-xl', 'display-lg', 'display-md']) {
      expect(css).toMatch(new RegExp(`--text-${role}--font-weight:\\s*400`))
    }
  })

  test('no UI role uses weight 700 or heavier', () => {
    const weights = [...css.matchAll(/--text-[\w-]+--font-weight:\s*(\d+)/g)].map((m) =>
      Number(m[1]),
    )
    expect(weights.length).toBeGreaterThan(5)
    expect(Math.max(...weights)).toBeLessThan(700)
  })
})

describe('accessibility and motion commitments', () => {
  test('a global focus-visible ring is defined', () => {
    expect(css).toContain(':focus-visible')
    expect(css).toMatch(/outline:\s*2px solid var\(--ring\)/)
  })

  test('prefers-reduced-motion is honoured', () => {
    expect(css).toContain('prefers-reduced-motion: reduce')
  })

  test('reduced motion uses 1ms, not 0s, so transitionend still fires', () => {
    // At 0s the events never fire and presence-based components never unmount.
    expect(css).toMatch(/animation-duration:\s*1ms/)
    expect(css).toMatch(/transition-duration:\s*1ms/)
  })

  test('tables use tabular numerals so figures do not jitter', () => {
    expect(css).toMatch(/font-variant-numeric:\s*tabular-nums/)
  })
})

describe('anti-patterns that would break the aesthetic', () => {
  test('no gradient is used as decoration', () => {
    // The one legal gradient is the skeleton sheen, which is motion not decor.
    const gradients = [...css.matchAll(/linear-gradient\([^)]*\)/g)].map((m) => m[0])
    for (const g of gradients) {
      expect(css.slice(Math.max(0, css.indexOf(g) - 400), css.indexOf(g))).toMatch(/skeleton/i)
    }
  })

  test('no coloured or glowing shadow', () => {
    // Only the :root definitions carry real values; @theme re-declares each token
    // as `var(--shadow-xs)` to expose it as a utility, so scope to :root.
    const root = /:root \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    const shadows = [...root.matchAll(/--shadow-[\w-]+:\s*([^;]+);/g)].map((m) => m[1]!)
    expect(shadows.length).toBeGreaterThanOrEqual(4)
    // Every shadow must be the same navy at low alpha; a coloured or glowing
    // shadow reads as a generic template.
    for (const body of shadows) {
      expect(body).toMatch(/rgb\(15 30 55 \/|rgba?\(15,\s*30,\s*55/)
    }
  })

  test('declares no more than three font families', () => {
    const families = new Set([...css.matchAll(/--font-(sans|serif|mono):/g)].map((m) => m[1]))
    expect(families.size).toBe(3)
  })
})
