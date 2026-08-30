import type * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * A single shimmering placeholder shape. `skeleton` is our own @utility from
 * globals.css §5 — it carries the fill, the sheen, and the reduced-motion opt-out.
 *
 * Skeletons mirror real geometry (§9.19): same heights and widths as the loaded
 * state. Individual shapes are aria-hidden; announcement is the container's job,
 * which is what SkeletonGroup provides.
 */
export type SkeletonProps = React.ComponentPropsWithoutRef<'div'>

export function Skeleton({ className, ...props }: SkeletonProps) {
  return <div aria-hidden="true" className={cn('skeleton h-4 w-full', className)} {...props} />
}

export interface SkeletonTextProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Number of lines. Widths vary so it does not read as a barcode (§9.19). */
  lines?: number
}

const LINE_WIDTHS = ['w-full', 'w-4/5', 'w-11/12', 'w-2/3'] as const

export function SkeletonText({ lines = 3, className, ...props }: SkeletonTextProps) {
  return (
    <div aria-hidden="true" className={cn('flex flex-col gap-2', className)} {...props}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3.5', LINE_WIDTHS[i % LINE_WIDTHS.length])} />
      ))}
    </div>
  )
}

export interface SkeletonGroupProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Named in the screen-reader announcement: "Loading campaigns". */
  label: string
}

/**
 * Wraps a set of skeletons so assistive tech is told once, not per shape (§9.19).
 */
export function SkeletonGroup({ label, className, children, ...props }: SkeletonGroupProps) {
  return (
    <div role="status" aria-busy="true" className={cn(className)} {...props}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}
