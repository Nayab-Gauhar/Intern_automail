import type * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * §9.21. Five distinct kinds, and **using the wrong one is a bug** (brief §8):
 *
 *   first-run  no records ever created  -> primary create action
 *   no-results filters returned nothing -> "Clear filters", NEVER a create action
 *   blocked    a prerequisite is missing-> link to the prerequisite
 *   not-built  the feature is unbuilt   -> no action, and no fake controls nearby
 *   error      the load failed          -> Retry + an error id (see ErrorState)
 *
 * `not-built` exists because the brief forbids fake functionality: an honest "not
 * available yet" is the correct thing to ship for an unfinished slice.
 *
 * This is one of the four legal serif placements — the empty state is the most-seen
 * screen in a new workspace and earns the editorial voice. One Lucide glyph in muted
 * ink at stroke 1.5; never an illustration, never an emoji, never a coloured icon.
 *
 * Actions are `children` rather than a props-shaped button, so this file needs no
 * knowledge of routing and stays renderable from a Server Component.
 */

export type EmptyStateKind = 'first-run' | 'no-results' | 'blocked' | 'not-built'

export interface EmptyStateProps extends React.ComponentPropsWithoutRef<'div'> {
  kind: EmptyStateKind
  title: string
  description?: string
  icon?: LucideIcon
  /** Heading level, so an empty state inside a card does not skip levels. */
  as?: 'h2' | 'h3'
}

export function EmptyState({
  kind,
  title,
  description,
  icon: Icon,
  as: Tag = 'h2',
  className,
  children,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-empty-kind={kind}
      className={cn(
        'mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center',
        className,
      )}
      {...props}
    >
      {Icon ? (
        <span className="bg-bg-subtle mb-5 flex size-18 items-center justify-center rounded-md">
          <Icon aria-hidden="true" strokeWidth={1.5} className="text-ink-muted size-10" />
        </span>
      ) : null}

      <Tag className="font-display text-display-md text-ink">{title}</Tag>

      {description ? (
        <p className="text-body-sm text-ink-secondary mt-2 max-w-sm">{description}</p>
      ) : null}

      {/*
        `not-built` renders no action by contract. If a caller passes one anyway it is
        dropped here rather than shipped, because a control beside "not available yet"
        is exactly the fake functionality the brief bans.
      */}
      {kind !== 'not-built' && children ? (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{children}</div>
      ) : null}
    </div>
  )
}
