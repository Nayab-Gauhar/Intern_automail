import type * as React from 'react'
import { TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * §9.21, `error` kind. What failed, a way to retry, and the error id in mono so a user
 * can quote it to support.
 *
 * role="alert" because this replaces content the user was waiting for: it must be
 * announced, not silently swapped in. The retry control is `children` so this file
 * imports no router and no action.
 *
 * lucide-react v1 renamed `AlertTriangle` to `TriangleAlert`.
 */
export interface ErrorStateProps extends React.ComponentPropsWithoutRef<'div'> {
  title?: string
  /** What failed, in plain language. Never a raw exception message. */
  description?: string
  /** Correlation id from the logger, shown for support. */
  errorId?: string
  as?: 'h2' | 'h3'
}

export function ErrorState({
  title = 'Something went wrong',
  description = 'This did not load. Try again, and if it keeps happening quote the reference below.',
  errorId,
  as: Tag = 'h2',
  className,
  children,
  ...props
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center',
        className,
      )}
      {...props}
    >
      <span className="bg-danger-subtle mb-5 flex size-18 items-center justify-center rounded-md">
        <TriangleAlert aria-hidden="true" strokeWidth={1.5} className="text-danger size-10" />
      </span>

      <Tag className="text-heading text-ink">{title}</Tag>
      <p className="text-body-sm text-ink-secondary mt-2 max-w-sm">{description}</p>

      {children ? (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{children}</div>
      ) : null}

      {errorId ? (
        <p className="text-caption text-ink-meta mt-6">
          Reference <span className="text-mono text-ink-secondary font-mono">{errorId}</span>
        </p>
      ) : null}
    </div>
  )
}

/**
 * The inline variant: a load failure inside a region that still has usable chrome
 * around it (a card body, a panel section). Same contract, less vertical space.
 */
export interface ErrorInlineProps extends React.ComponentPropsWithoutRef<'div'> {
  message: string
  errorId?: string
}

export function ErrorInline({ message, errorId, className, children, ...props }: ErrorInlineProps) {
  return (
    <div
      role="alert"
      className={cn(
        'border-danger-border bg-danger-subtle flex items-start gap-3 rounded-sm border px-3 py-2.5',
        className,
      )}
      {...props}
    >
      <TriangleAlert
        aria-hidden="true"
        strokeWidth={1.75}
        className="text-danger mt-0.5 size-4 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body-sm text-danger">{message}</p>
        {errorId ? (
          <p className="text-caption text-ink-meta">
            Reference <span className="text-mono font-mono">{errorId}</span>
          </p>
        ) : null}
      </div>
      {children}
    </div>
  )
}
