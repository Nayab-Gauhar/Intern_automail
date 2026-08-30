'use client'

import * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * §9.7. Track 36x20, thumb 16x16, translate-x-0 -> translate-x-4.
 *
 * Radix Switch is not installed. Built on a native checkbox with `role="switch"`,
 * which is the documented ARIA pattern: the input supplies space-to-toggle, focus, and
 * form participation, and `role="switch"` makes it announce as on/off rather than
 * checked/unchecked. No "On"/"Off" text is needed because aria-checked carries it.
 *
 * When to use this instead of a Checkbox is a real rule (§9.7): a Switch takes effect
 * IMMEDIATELY. Never put one in a form with a Save button. Because it fires on change,
 * the caller owns the optimistic update, the in-flight `busy` window, and an error
 * toast naming what failed. If the consequence is destructive (pausing a live
 * campaign), the caller opens a confirm dialog instead of wiring onChange directly.
 */
export interface SwitchProps extends Omit<
  React.ComponentPropsWithoutRef<'input'>,
  'type' | 'role'
> {
  /** In-flight: disables and sets aria-busy so the state cannot be double-toggled. */
  busy?: boolean
  ref?: React.Ref<HTMLInputElement>
}

export function Switch({ className, busy = false, disabled, ...props }: SwitchProps) {
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <input
        type="checkbox"
        role="switch"
        aria-busy={busy || undefined}
        disabled={disabled ?? busy}
        className={cn(
          'peer rounded-pill bg-border-strong h-5 w-9 shrink-0 appearance-none',
          'duration-fast transition-[background-color] ease-out',
          'checked:bg-accent',
          'disabled:opacity-45',
          className,
        )}
        {...props}
      />
      {/* The thumb is decorative; the input owns role, state, and focus ring. */}
      <span
        aria-hidden="true"
        className={cn(
          'rounded-pill bg-surface pointer-events-none absolute left-0.5 size-4 shadow-xs',
          'duration-fast transition-transform ease-out peer-checked:translate-x-4',
        )}
      />
    </span>
  )
}

/**
 * A labelled switch row. The label is clickable, and because switches act immediately
 * the description is where the consequence gets stated.
 */
export interface SwitchRowProps extends SwitchProps {
  label: React.ReactNode
  description?: React.ReactNode
  rowClassName?: string
}

export function SwitchRow({ label, description, rowClassName, id, ...props }: SwitchRowProps) {
  const generated = React.useId()
  const controlId = id ?? generated
  const descriptionId = description ? `${controlId}-description` : undefined

  return (
    <div className={cn('flex items-start justify-between gap-4 py-1.5', rowClassName)}>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={controlId} className="text-body-sm text-ink cursor-pointer">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="text-caption text-ink-meta">
            {description}
          </p>
        ) : null}
      </div>
      <Switch
        id={controlId}
        className="mt-0.5"
        {...(descriptionId ? { 'aria-describedby': descriptionId } : {})}
        {...props}
      />
    </div>
  )
}
