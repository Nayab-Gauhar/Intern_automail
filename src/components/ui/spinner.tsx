import type * as React from 'react'
import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * The one thing in the system allowed to loop (§12.1 rule 5). Use it for in-flight
 * actions — buttons, async validation, a pending toolbar. For content that is
 * arriving, use a shaped Skeleton instead: §14 anti-pattern 28 bans a centred
 * spinner where geometry is knowable.
 *
 * lucide-react v1 renamed `Loader2` to `LoaderCircle`; the spec's name is stale.
 */

const SIZES = {
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-5',
} as const

export interface SpinnerProps extends React.ComponentPropsWithoutRef<'svg'> {
  size?: keyof typeof SIZES
  /**
   * Accessible label. Defaults to none: a spinner inside a button whose own
   * aria-busy is set would otherwise announce twice. Pass a label only when the
   * spinner is the sole indicator.
   */
  label?: string
}

export function Spinner({ size = 'md', label, className, ...props }: SpinnerProps) {
  return (
    <LoaderCircle
      aria-hidden={label ? undefined : true}
      role={label ? 'status' : undefined}
      aria-label={label}
      strokeWidth={1.75}
      className={cn(SIZES[size], 'shrink-0 animate-spin text-current', className)}
      {...props}
    />
  )
}
