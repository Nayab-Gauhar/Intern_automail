import type * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * §9.10. A Panel is a structural REGION of a page, not a raised object: rounded-lg,
 * no shadow, and it fills its grid area.
 *
 * `min-h-0` on the flex column and on PanelBody is load-bearing. Without it a flex
 * child refuses to shrink below its content and the body will not scroll — the panel
 * grows and the page scrolls instead. It looks redundant and gets deleted by
 * well-meaning cleanups; it is not redundant.
 */
export interface PanelProps extends React.ComponentPropsWithoutRef<'section'> {
  ref?: React.Ref<HTMLElement>
}

export function Panel({ className, ...props }: PanelProps) {
  return (
    <section
      className={cn(
        'border-border bg-surface flex min-h-0 flex-col overflow-hidden rounded-lg border',
        className,
      )}
      {...props}
    />
  )
}

export function PanelHeader({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={cn(
        'border-border flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4',
        className,
      )}
      {...props}
    />
  )
}

export interface PanelTitleProps extends React.ComponentPropsWithoutRef<'h2'> {
  as?: 'h2' | 'h3'
}

export function PanelTitle({ className, as: Tag = 'h2', ...props }: PanelTitleProps) {
  return <Tag className={cn('text-subheading text-ink', className)} {...props} />
}

export function PanelBody({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  // min-h-0 again: see the note on Panel. It is what makes overflow-y-auto work here.
  return <div className={cn('min-h-0 flex-1 overflow-y-auto p-4', className)} {...props} />
}

export function PanelFooter({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={cn(
        'border-border bg-bg-subtle flex shrink-0 items-center gap-2 border-t px-4 py-3',
        className,
      )}
      {...props}
    />
  )
}
