'use client'

import * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * §9.27. <kbd> chips. Multi-key renders separate chips with no "+" glyph (⌘ K, not ⌘+K).
 *
 * aria-hidden, always: the shortcut must be stated in the accessible name of whatever
 * it triggers ("Search leads, keyboard shortcut slash"), not announced as loose
 * punctuation in the middle of a menu item.
 *
 * ONLY render this for shortcuts that actually exist. A decorative ⌘K next to a search
 * box that ignores ⌘K is fake functionality (brief §8).
 */

const GLYPHS: Record<string, string> = {
  mod: 'Ctrl', // replaced with ⌘ on Apple after hydration
  cmd: '⌘',
  ctrl: 'Ctrl',
  shift: '⇧',
  alt: '⌥',
  option: '⌥',
  enter: '⏎',
  return: '⏎',
  space: '␣',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  esc: 'Esc',
  escape: 'Esc',
  tab: 'Tab',
  backspace: '⌫',
  delete: '⌦',
}

/** The platform never changes mid-session, so the store never notifies. */
const noopSubscribe = () => () => {}

function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}

/**
 * useSyncExternalStore, not useState + useEffect: it takes a distinct server snapshot,
 * so SSR renders `Ctrl` and the client resolves the real platform during hydration
 * without a cascading render or a mismatch warning. The one-frame flash on a decorative
 * element is not worth a client-only wrapper (§9.27).
 */
function useIsApple(): boolean {
  return React.useSyncExternalStore(noopSubscribe, isApplePlatform, () => false)
}

export interface KeyboardHintProps extends React.ComponentPropsWithoutRef<'span'> {
  /** e.g. ['mod','k'] or ['/'] — 'mod' renders ⌘ on Apple, Ctrl elsewhere. */
  keys: string[]
}

export function KeyboardHint({ keys, className, ...props }: KeyboardHintProps) {
  const isApple = useIsApple()

  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex items-center gap-0.5', className)}
      {...props}
    >
      {keys.map((key, i) => {
        const lower = key.toLowerCase()
        const glyph =
          lower === 'mod' ? (isApple ? '⌘' : 'Ctrl') : (GLYPHS[lower] ?? key.toUpperCase())
        return (
          <kbd
            key={`${key}-${i}`}
            className="border-border bg-bg-subtle text-ink-meta inline-flex h-5 min-w-5 items-center justify-center rounded-xs border px-1.5 font-mono text-[0.6875rem] leading-none"
          >
            {glyph}
          </kbd>
        )
      })}
    </span>
  )
}
