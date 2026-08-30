import type * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * §9.8. Two components, deliberately separate.
 *
 * Badge is a neutral count or tag: rounded-xs, not pill — pills are reserved for the
 * primary action and the filter chip.
 *
 * StatusBadge exists as its own component because **status must never be colour
 * alone**. The label is always rendered as a word; the dot or icon is a second,
 * non-colour channel. There is no variant of this that renders a bare coloured dot.
 *
 * The domain -> (tone, icon, label) mapping lives in patterns/status-map.ts, NOT here:
 * ui/ stays free of domain knowledge (brief §3 import rule 3). This file knows about
 * five tones and nothing about campaigns or mailboxes.
 */

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface BadgeProps extends React.ComponentPropsWithoutRef<'span'> {
  /** Adds a leading 1px dot in muted ink — the lead-tag treatment. */
  dot?: boolean
}

export function Badge({ className, dot = false, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'border-border bg-bg-subtle inline-flex h-5 items-center gap-1.5 rounded-xs border px-2',
        'text-caption text-ink-secondary font-medium',
        className,
      )}
      {...props}
    >
      {dot ? (
        <span aria-hidden="true" className="rounded-pill bg-ink-muted size-1 shrink-0" />
      ) : null}
      {children}
    </span>
  )
}

const TONES: Record<StatusTone, string> = {
  neutral: 'border-border bg-bg-subtle text-ink-secondary',
  info: 'border-info-border bg-info-subtle text-info',
  success: 'border-success-border bg-success-subtle text-success',
  warning: 'border-warning-border bg-warning-subtle text-warning',
  danger: 'border-danger-border bg-danger-subtle text-danger',
}

const DOT_TONES: Record<StatusTone, string> = {
  neutral: 'bg-ink-muted',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
}

export interface StatusBadgeProps extends React.ComponentPropsWithoutRef<'span'> {
  tone: StatusTone
  /** Always a word. This is the non-colour channel and it is not optional. */
  label: string
  /** Omit for a filled dot in the tone colour. */
  icon?: LucideIcon
  /**
   * Caveat text — e.g. the mandatory honesty note on OPENED, since open tracking is
   * both over- and under-counted (brief §10). Tooltip is deferred (no Radix), so this
   * renders as a native `title` plus an sr-only sentence: available to both pointer
   * and screen-reader users, and it degrades rather than disappearing.
   */
  hint?: string
}

export function StatusBadge({
  tone,
  label,
  icon: Icon,
  hint,
  className,
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-xs border px-2',
        'text-caption font-medium',
        TONES[tone],
        className,
      )}
      {...(hint ? { title: hint } : {})}
      {...props}
    >
      {Icon ? (
        <Icon aria-hidden="true" strokeWidth={1.75} className="size-3 shrink-0" />
      ) : (
        <span aria-hidden="true" className={cn('rounded-pill size-2 shrink-0', DOT_TONES[tone])} />
      )}
      <span>{label}</span>
      {hint ? <span className="sr-only">{hint}</span> : null}
    </span>
  )
}
