import type * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * §9.18. Initials only. No image loading at all in v1.
 *
 * Cold outreach almost never has a lead's photo, so initials-in-warm-grey IS the
 * default state and the design is built for it. We do not fetch third-party enrichment
 * images to fill the gap, and there is no generated hue-per-user: arbitrary saturated
 * colour injected into a strictly limited palette is enough on its own to make the
 * product look generic (§9.18).
 */

const SIZES = {
  xs: 'size-5 text-[0.625rem]',
  sm: 'size-6 text-[0.6875rem]',
  md: 'size-8 text-caption',
  lg: 'size-10 text-body-sm',
  xl: 'size-14 text-body',
} as const

export type AvatarSize = keyof typeof SIZES

/** First letter of the first and last word. Falls back to "?" for an empty name. */
export function initialsFrom(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0]?.[0] ?? ''
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : ''
  return (first + last).toUpperCase() || '?'
}

export interface AvatarProps extends React.ComponentPropsWithoutRef<'span'> {
  /** Full name or email; initials are derived from it. */
  name: string
  size?: AvatarSize
  /**
   * true when the avatar stands alone and must carry the name itself. Beside a visible
   * name, leave it false — the name is already the label and repeating it is noise.
   */
  standalone?: boolean
}

export function Avatar({
  name,
  size = 'md',
  standalone = false,
  className,
  ...props
}: AvatarProps) {
  return (
    <span
      role={standalone ? 'img' : undefined}
      aria-label={standalone ? name : undefined}
      aria-hidden={standalone ? undefined : true}
      className={cn(
        'rounded-pill inline-flex shrink-0 items-center justify-center select-none',
        'border-border bg-bg-subtle text-ink-secondary border font-medium',
        SIZES[size],
        className,
      )}
      {...props}
    >
      {initialsFrom(name)}
    </span>
  )
}

export interface AvatarGroupProps extends React.ComponentPropsWithoutRef<'span'> {
  names: string[]
  size?: AvatarSize
  /** Overflow beyond this collapses into a +N avatar. */
  max?: number
}

export function AvatarGroup({
  names,
  size = 'sm',
  max = 4,
  className,
  ...props
}: AvatarGroupProps) {
  const shown = names.slice(0, max)
  const overflow = names.length - shown.length

  return (
    <span
      role="img"
      // The group names the full set, including the people hidden behind "+N".
      aria-label={names.join(', ')}
      className={cn('inline-flex items-center', className)}
      {...props}
    >
      {shown.map((name, i) => (
        <Avatar
          key={`${name}-${i}`}
          name={name}
          size={size}
          className={cn('ring-bg ring-2', i > 0 && '-ml-2')}
        />
      ))}
      {overflow > 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            'rounded-pill inline-flex shrink-0 items-center justify-center select-none',
            'border-border bg-bg-active text-ink-secondary ring-bg -ml-2 border font-medium ring-2',
            SIZES[size],
          )}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  )
}
