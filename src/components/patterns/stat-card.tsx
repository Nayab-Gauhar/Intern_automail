import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Card } from '@/components/ui'

/**
 * The one place a metric gets display type (design system §9.9).
 *
 * Two rules the props enforce rather than document:
 *
 * 1. **The denominator is not optional.** A bare "4.2%" is a lie waiting to happen, so
 *    `context` is a required prop. If you have no denominator to show, you are not
 *    ready to show the number.
 * 2. **An unavailable metric says so.** `unavailable` renders an em dash and a reason
 *    instead of a zero. A zero means "we counted and found none"; an unbuilt module
 *    means "we did not count". Conflating them is the fake functionality the brief
 *    bans, and it is how a broken pipeline looks healthy.
 *
 * No sparkline and no delta here — Phase 1 has no chart library and no historical
 * comparison to draw from. The props are absent rather than ignored.
 */
export interface StatCardProps {
  /** Uppercase micro label. */
  label: string
  /** The number. Pre-formatted by the caller so locale rules live in one place. */
  value?: string | number
  /** The denominator or qualifier. Required — see rule 1. */
  context: string
  /** Renders the honest unavailable state instead of `value`; the string is the reason. */
  unavailable?: string
  /** Makes the whole card a link into the filtered view the number describes. */
  href?: string
  className?: string
}

export function StatCard({ label, value, context, unavailable, href, className }: StatCardProps) {
  const body = (
    <>
      <p className="text-micro text-ink-meta uppercase">{label}</p>

      {unavailable ? (
        <>
          {/* aria-hidden on the dash: a screen reader announces the reason, not "—". */}
          <p aria-hidden="true" className="font-display text-display-md text-ink-muted mt-3">
            —
          </p>
          <p className="text-caption text-ink-meta mt-1">{unavailable}</p>
        </>
      ) : (
        <>
          <p data-tabular className="font-display text-display-md text-ink mt-3">
            {value}
          </p>
          <p className="text-caption text-ink-meta mt-1">{context}</p>
        </>
      )}
    </>
  )

  if (href && !unavailable) {
    return (
      <Card
        interactive
        className={cn(
          'duration-fast transition-[box-shadow,border-color] ease-out',
          'hover:border-border-strong hover:shadow-sm',
          'focus-within:border-border-strong',
          className,
        )}
      >
        {/* The whole card is one link. `block p-5` puts the padding inside the hit area. */}
        <Link href={href} className="block rounded-md p-5">
          {body}
        </Link>
      </Card>
    )
  }

  return <Card className={cn('p-5', className)}>{body}</Card>
}

/** A row of stat cards. Four across on desktop, two on tablet, one on mobile. */
export function StatCardRow({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
}
