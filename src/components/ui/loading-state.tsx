import type * as React from 'react'
import { cn } from '@/lib/cn'
import { Skeleton, SkeletonGroup } from './skeleton'
import { Spinner } from './spinner'

/**
 * The loading surface for a region whose geometry is known.
 *
 * §9.19 / §14.28: a shaped skeleton, not a centred spinner. Skeletons keep the real
 * row height and column widths so the layout does not pop when data lands, and a table
 * that holds its geometry while loading feels twice as fast as one that reflows.
 *
 * `LoadingState` is the generic shaped block. `TableLoadingRows` is here rather than in
 * patterns/ because the row height must stay in step with table.tsx's densities, and a
 * copy in another file would drift.
 */

export interface LoadingStateProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Named in the announcement: "Loading campaigns". */
  label: string
  lines?: number
}

export function LoadingState({ label, lines = 4, className, ...props }: LoadingStateProps) {
  return (
    <SkeletonGroup label={label} className={cn('flex flex-col gap-3 p-5', className)} {...props}>
      <Skeleton className="h-5 w-40" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cn('h-4', i % 3 === 0 ? 'w-full' : i % 3 === 1 ? 'w-4/5' : 'w-2/3')}
        />
      ))}
    </SkeletonGroup>
  )
}

const ROW_HEIGHTS = {
  compact: 'h-11',
  default: 'h-12',
  comfortable: 'h-13',
} as const

export interface TableLoadingRowsProps {
  /** Render exactly the page size, so the table keeps its real height (§9.11). */
  rows: number
  /** One Tailwind width class per column, matching the loaded content's widths. */
  columnWidths: string[]
  density?: keyof typeof ROW_HEIGHTS
}

export function TableLoadingRows({
  rows,
  columnWidths,
  density = 'default',
}: TableLoadingRowsProps) {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <tr
          key={rowIndex}
          className={cn('border-border border-b last:border-0', ROW_HEIGHTS[density])}
        >
          {columnWidths.map((width, colIndex) => (
            <td key={colIndex} className="px-4">
              <Skeleton className={cn('h-3.5', width)} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

/**
 * The narrow exception to "no spinners": an action already in flight, where there is no
 * geometry to shape because nothing new is arriving yet. Announced politely so a screen
 * reader is told once.
 */
export interface LoadingInlineProps extends React.ComponentPropsWithoutRef<'div'> {
  label: string
}

export function LoadingInline({ label, className, ...props }: LoadingInlineProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn('text-body-sm text-ink-secondary flex items-center gap-2', className)}
      {...props}
    >
      <Spinner size="sm" />
      <span>{label}</span>
    </div>
  )
}
