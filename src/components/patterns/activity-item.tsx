import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * One fact in the recent-activity timeline. Read-only by design (frontend spec §4.5).
 *
 * Timestamps: the server renders an ISO 8601 UTC string into `dateTime` and a
 * pre-formatted display string into the visible text. The formatting happens on the
 * server against the workspace timezone rather than in a client effect, so there is
 * no hydration mismatch and no flash of a wrong time. All storage is UTC (brief §9);
 * this component never converts anything, it only displays what it is handed.
 */
export interface ActivityItemProps {
  icon: LucideIcon
  /** What happened, past tense. */
  title: string
  /** Who or what it happened to. */
  subject?: string
  /** Machine-readable UTC instant, e.g. 2026-08-30T22:04:00.000Z. */
  dateTime: string
  /** Human-readable time, pre-formatted server-side. */
  displayTime: string
  className?: string
}

export function ActivityItem({
  icon: Icon,
  title,
  subject,
  dateTime,
  displayTime,
  className,
}: ActivityItemProps) {
  return (
    <li className={cn('flex items-start gap-3 py-3', className)}>
      <span className="bg-bg-subtle mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-sm">
        <Icon aria-hidden="true" strokeWidth={1.75} className="text-ink-meta size-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-body-sm text-ink">{title}</p>
        {subject ? <p className="text-caption text-ink-secondary mt-0.5">{subject}</p> : null}
      </div>

      <time dateTime={dateTime} className="text-caption text-ink-meta shrink-0 whitespace-nowrap">
        {displayTime}
      </time>
    </li>
  )
}

/** The list wrapper: hairline separators between items, none at the ends. */
export function ActivityList({ children }: { children: React.ReactNode }) {
  return <ul className="divide-border divide-y">{children}</ul>
}
