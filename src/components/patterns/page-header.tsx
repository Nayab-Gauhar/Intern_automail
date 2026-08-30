import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * The page header composite (design system §10.4). Renders the page's single <h1> in
 * display type.
 *
 * The bottom-border rule is load-bearing: with `tabs` the header owns the border and
 * the tab strip sits flush against it; without tabs there is NO border, and whitespace
 * alone separates header from content. That contrast is much of what makes the layout
 * read as editorial rather than as a generic admin panel.
 */
export interface PageHeaderProps {
  /** The page's single <h1>. */
  title: string
  /** One sentence. */
  description?: string
  breadcrumb?: ReactNode
  /** Right-aligned. At most one primary action. */
  actions?: ReactNode
  /** Route tabs, flush to the bottom border. */
  tabs?: ReactNode
  /** StatusBadge / timestamps under the title. */
  meta?: ReactNode
  className?: string
}

export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  tabs,
  meta,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        'gutter-x mx-auto w-full max-w-[1280px] pt-8 pb-5 md:pt-10 md:pb-6',
        tabs && 'border-border border-b pb-0 md:pb-0',
        className,
      )}
    >
      {breadcrumb ? <div className="mb-2">{breadcrumb}</div> : null}

      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:gap-6">
        <div className="min-w-0">
          <h1 className="font-display text-display-md text-ink">{title}</h1>
          {description ? (
            <p className="text-body text-ink-secondary mt-2 max-w-[60ch]">{description}</p>
          ) : null}
          {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>

        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>

      {tabs ? <div className="mt-6">{tabs}</div> : null}
    </header>
  )
}

/**
 * The content column below a PageHeader. Same max width and gutter, so the header
 * title and the content beneath it share one left edge.
 */
export function PageBody({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('gutter-x mx-auto w-full max-w-[1280px] pb-16', className)}>{children}</div>
  )
}

/**
 * A titled region within a page (design system §10.5). Sections are separated by
 * space, not rules.
 */
export interface SectionProps {
  title?: string
  description?: string
  /** Secondary or ghost only — never a pill here. */
  actions?: ReactNode
  className?: string
  children: ReactNode
}

export function Section({ title, description, actions, className, children }: SectionProps) {
  return (
    <section className={cn('mt-8 space-y-4 md:mt-10', className)}>
      {title || actions ? (
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            {title ? <h2 className="text-heading text-ink">{title}</h2> : null}
            {description ? (
              <p className="text-body-sm text-ink-secondary mt-1">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}
