import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { buttonClasses } from '@/components/ui'

/**
 * One row in the dashboard triage banner: a problem, and the single click that fixes it.
 *
 * Severity is never carried by colour alone (brief §7). Each tone pairs its fill with
 * an icon AND a text label that names the severity, so the row is unambiguous in
 * monochrome and to a screen reader.
 */
export type AttentionTone = 'warning' | 'danger' | 'info'

const TONES: Record<AttentionTone, string> = {
  danger: 'border-danger-border bg-danger-subtle',
  warning: 'border-warning-border bg-warning-subtle',
  info: 'border-info-border bg-info-subtle',
}

const ICON_TONES: Record<AttentionTone, string> = {
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
}

/** The non-colour severity channel, read out before the message. */
const SEVERITY_WORD: Record<AttentionTone, string> = {
  danger: 'Critical',
  warning: 'Warning',
  info: 'Notice',
}

export interface AttentionItemProps {
  tone: AttentionTone
  icon: LucideIcon
  /** What is wrong, in one line. */
  title: string
  /** Optional detail: how long, how many, which mailbox. */
  detail?: string
  /** The one-click fix. Omit only when there is genuinely nothing to click. */
  action?: { label: string; href: string }
  className?: string
}

export function AttentionItem({
  tone,
  icon: Icon,
  title,
  detail,
  action,
  className,
}: AttentionItemProps) {
  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-sm border px-4 py-3 sm:flex-row sm:items-center sm:gap-4',
        TONES[tone],
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        strokeWidth={1.75}
        className={cn('size-4 shrink-0', ICON_TONES[tone])}
      />

      <div className="min-w-0 flex-1">
        <p className="text-body-sm text-ink">
          <span className="sr-only">{SEVERITY_WORD[tone]}: </span>
          {title}
        </p>
        {detail ? <p className="text-caption text-ink-secondary mt-0.5">{detail}</p> : null}
      </div>

      {action ? (
        <Link
          href={action.href}
          className={cn(buttonClasses('secondary', 'sm'), 'shrink-0 self-start sm:self-auto')}
        >
          {action.label}
        </Link>
      ) : null}
    </li>
  )
}

/**
 * The triage banner. Renders only when it has rows — there is deliberately no
 * "all clear" card, because the absence of the banner IS the healthy state (frontend
 * spec §4.3.1). A permanent green panel trains people to stop reading this region.
 */
export function AttentionBanner({ count, children }: { count: number; children: React.ReactNode }) {
  if (count === 0) return null

  return (
    <section aria-labelledby="attention-heading" className="mt-6">
      <h2 id="attention-heading" className="text-heading text-ink">
        {count === 1 ? '1 thing needs attention' : `${count} things need attention`}
      </h2>
      <ul className="mt-3 space-y-2">{children}</ul>
    </section>
  )
}
