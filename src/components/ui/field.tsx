'use client'

import * as React from 'react'
import { CircleAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Label } from './label'

/**
 * §9.2. The composite every form consumes. Field owns the id / aria-describedby /
 * aria-invalid wiring so no form has to remember it, and passes those down through a
 * render prop rather than cloning children — cloning breaks as soon as a control is
 * wrapped in a layout div.
 *
 * Error replaces hint at the same position so layout never shifts. Error text sits in
 * the aria-describedby chain, so it is announced when the control takes focus, and
 * carries an icon as well as colour (never colour alone).
 *
 * lucide-react v1 renamed `AlertCircle` to `CircleAlert`.
 */

export interface FieldControlProps {
  id: string
  'aria-describedby': string | undefined
  'aria-invalid': true | undefined
  required: boolean
}

export interface FieldProps extends Omit<React.ComponentPropsWithoutRef<'div'>, 'children'> {
  label: string
  /** Omit to have one generated; pass when a server-rendered id must be stable. */
  htmlFor?: string
  hint?: string
  /** Present => the field renders as invalid and the hint is replaced. */
  error?: string
  required?: boolean
  /** Shows "Optional" beside the label instead of "Required". */
  optional?: boolean
  children: (control: FieldControlProps) => React.ReactNode
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  optional = false,
  className,
  children,
  ...props
}: FieldProps) {
  const generated = React.useId()
  const id = htmlFor ?? generated
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = error ? errorId : hint ? hintId : undefined

  return (
    <div className={cn('flex flex-col gap-1.5', className)} {...props}>
      <Label htmlFor={id} requiredHint={required} optionalHint={optional}>
        {label}
      </Label>

      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        required,
      })}

      {error ? (
        <p id={errorId} className="text-caption text-danger flex items-start gap-1.5">
          <CircleAlert aria-hidden="true" strokeWidth={1.75} className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={hintId} className="text-caption text-ink-meta">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Form-level error summary. Server Actions fail for reasons no single field owns
 * (rate limit, provider rejection); those render here, not in a toast (§9.17).
 * aria-live so a submit failure is announced without moving focus.
 */
export interface FormMessageProps extends React.ComponentPropsWithoutRef<'div'> {
  tone?: 'danger' | 'success'
  children?: React.ReactNode
}

export function FormMessage({ tone = 'danger', className, children, ...props }: FormMessageProps) {
  return (
    <div role="status" aria-live="polite" className={cn('min-h-0', className)} {...props}>
      {children ? (
        <p
          className={cn(
            'text-body-sm flex items-start gap-1.5 rounded-sm border px-3 py-2',
            tone === 'danger'
              ? 'border-danger-border bg-danger-subtle text-danger'
              : 'border-success-border bg-success-subtle text-success',
          )}
        >
          <CircleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0" />
          <span>{children}</span>
        </p>
      ) : null}
    </div>
  )
}
