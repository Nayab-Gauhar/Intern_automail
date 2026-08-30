'use client'

import * as React from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * §9.11. A real <table>, never a div grid — screen-reader table navigation is the
 * whole point of using one.
 *
 * Density is passed through React context rather than repeated on every row, so a
 * table cannot end up with 48px and 44px rows mixed. Zebra striping is banned: the
 * hairline plus the row height does the work, and stripes are the spreadsheet tell.
 */

export type TableDensity = 'compact' | 'default' | 'comfortable'

const ROW_HEIGHTS: Record<TableDensity, string> = {
  compact: 'h-11', // 44px
  default: 'h-12', // 48px
  comfortable: 'h-13', // 52px
}

const DensityContext = React.createContext<TableDensity>('default')

/**
 * Scroll container. The sticky header needs an `overflow-auto` ancestor, and the
 * border lives here so the last row can drop its own and let the container close the
 * shape.
 */
export type TableContainerProps = React.ComponentPropsWithoutRef<'div'>

export function TableContainer({ className, ...props }: TableContainerProps) {
  return (
    <div
      className={cn('border-border relative w-full overflow-auto rounded-md border', className)}
      {...props}
    />
  )
}

export interface TableProps extends React.ComponentPropsWithoutRef<'table'> {
  density?: TableDensity
  /** Required: the sr-only <caption> naming what the table lists. */
  caption: string
  /** Set true when the caption is already announced by a visible heading nearby. */
  captionVisible?: boolean
}

export function Table({
  className,
  density = 'default',
  caption,
  captionVisible = false,
  children,
  ...props
}: TableProps) {
  return (
    <DensityContext.Provider value={density}>
      <table className={cn('text-body-sm w-full border-collapse', className)} {...props}>
        <caption
          className={cn(
            captionVisible ? 'text-body-sm text-ink-secondary px-4 py-3 text-left' : 'sr-only',
          )}
        >
          {caption}
        </caption>
        {children}
      </table>
    </DensityContext.Provider>
  )
}

export function TableHeader({ className, ...props }: React.ComponentPropsWithoutRef<'thead'>) {
  return <thead className={cn(className)} {...props} />
}

export function TableBody({ className, ...props }: React.ComponentPropsWithoutRef<'tbody'>) {
  return <tbody className={cn(className)} {...props} />
}

export function TableFooter({ className, ...props }: React.ComponentPropsWithoutRef<'tfoot'>) {
  return (
    <tfoot
      className={cn('border-border bg-bg-subtle text-ink-secondary border-t', className)}
      {...props}
    />
  )
}

export interface TableRowProps extends React.ComponentPropsWithoutRef<'tr'> {
  selected?: boolean
  /** Adds cursor + hover affordance. The primary cell must still contain a real link. */
  clickable?: boolean
}

export function TableRow({ className, selected, clickable, ...props }: TableRowProps) {
  const density = React.useContext(DensityContext)
  return (
    <tr
      {...(selected ? { 'data-state': 'selected' } : {})}
      className={cn(
        // `group/row` so a row-action cell can reveal itself on hover.
        'group/row border-border duration-fast border-b transition-colors last:border-0',
        ROW_HEIGHTS[density],
        'hover:bg-bg-hover',
        // Selection must survive hover, so it is declared after it.
        'data-[state=selected]:bg-accent-subtle',
        clickable && 'cursor-pointer',
        className,
      )}
      {...props}
    />
  )
}

export interface TableHeadProps extends React.ComponentPropsWithoutRef<'th'> {
  align?: 'left' | 'right'
  /**
   * Sticky is on the <th>, not the <thead> — Safari ignores position:sticky there.
   * The bg fill must stay opaque or rows bleed through as they scroll under it.
   */
  sticky?: boolean
}

export function TableHead({
  className,
  align = 'left',
  sticky = true,
  scope = 'col',
  ...props
}: TableHeadProps) {
  return (
    <th
      scope={scope}
      className={cn(
        'border-border-strong bg-bg-subtle text-label text-ink-meta h-10 border-b px-4 font-medium',
        // Sentence case, not uppercase (§9.11).
        align === 'right' ? 'text-right' : 'text-left',
        sticky && 'z-sticky sticky top-0',
        className,
      )}
      {...props}
    />
  )
}

export interface TableCellProps extends React.ComponentPropsWithoutRef<'td'> {
  align?: 'left' | 'right'
  /** Numeric columns: right-aligned and tabular so digits do not jitter. */
  numeric?: boolean
  /** truncate + max-w-0 lets a flexible cell shrink; pair with `title`. */
  truncate?: boolean
}

export function TableCell({
  className,
  align,
  numeric = false,
  truncate = false,
  ...props
}: TableCellProps) {
  const resolved = align ?? (numeric ? 'right' : 'left')
  return (
    <td
      className={cn(
        'text-ink px-4 align-middle',
        resolved === 'right' ? 'text-right' : 'text-left',
        numeric && 'tabular-nums',
        truncate && 'max-w-0 truncate',
        // Focus inside a row draws an inset ring so overflow-hidden cannot clip it.
        '[&_:focus-visible]:outline-offset-[-2px]',
        className,
      )}
      {...props}
    />
  )
}

/**
 * An absent value. Never blank, never "N/A" (§9.11) — a blank cell is
 * indistinguishable from a rendering bug, and screen readers skip it silently.
 */
export function TableEmptyCellValue() {
  return (
    <>
      <span aria-hidden="true" className="text-ink-muted">
        —
      </span>
      <span className="sr-only">None</span>
    </>
  )
}

export type SortDirection = 'ascending' | 'descending' | 'none'

export interface TableSortButtonProps extends React.ComponentPropsWithoutRef<'button'> {
  direction: SortDirection
}

/**
 * The sortable <th>'s inner button. `aria-sort` belongs on the <th>, so the caller
 * sets it there; this renders the affordance. Sort state lives in the URL (brief §8),
 * so in practice the caller renders a <Link> — use `tableSortButtonClasses` for that.
 */
export const tableSortButtonClasses = cn(
  'group/sort -mx-1 inline-flex items-center gap-1 rounded-xs px-1 py-0.5',
  'text-label font-medium text-ink-meta transition-colors duration-fast',
  'hover:text-ink focus-visible:outline-offset-[-2px]',
)

export function TableSortButton({
  className,
  direction,
  children,
  ...props
}: TableSortButtonProps) {
  const Icon = direction === 'descending' ? ChevronDown : ChevronUp
  return (
    <button type="button" className={cn(tableSortButtonClasses, className)} {...props}>
      <span>{children}</span>
      {/*
        The direction is already in the <th>'s aria-sort, so the glyph is decorative.
        Inactive columns reveal it on hover/focus only, to keep the header quiet.
      */}
      <Icon
        aria-hidden="true"
        strokeWidth={1.75}
        className={cn(
          'duration-fast size-3.5 shrink-0 transition-opacity',
          direction === 'none'
            ? 'opacity-0 group-hover/sort:opacity-60 group-focus-visible/sort:opacity-60'
            : 'opacity-100',
        )}
      />
    </button>
  )
}

/**
 * Trailing row-action cell. Hidden until row hover ON POINTER DEVICES ONLY — the
 * `hover:hover` guard matters: without it the trigger is invisible and unusable on
 * touch (§9.11).
 */
export function TableRowActionsCell({ className, ...props }: TableCellProps) {
  return (
    <TableCell
      className={cn(
        'w-12 text-right',
        '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100',
        '[@media(hover:hover)]:has-[:focus-visible]:opacity-100',
        'duration-fast transition-opacity',
        className,
      )}
      {...props}
    />
  )
}
