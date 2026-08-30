'use client'

import * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * §9.5. A real <input type="checkbox">, visually replaced.
 *
 * Radix Checkbox is not installed, and here that costs almost nothing: the native
 * input already gives us space-to-toggle, form participation, and the checked state
 * in the a11y tree. The one thing it does not give is `indeterminate`, which is a DOM
 * property rather than an attribute — hence the effect below.
 *
 * The 16px box is never the hit target on its own. Use CheckboxRow for a 32px
 * clickable label row; inside a table cell, pass `expandHitArea` instead, because a
 * label row would break cell alignment.
 */
export interface CheckboxProps extends Omit<React.ComponentPropsWithoutRef<'input'>, 'type'> {
  indeterminate?: boolean
  /** Invisible padded hit area for table header / cell checkboxes. */
  expandHitArea?: boolean
  ref?: React.Ref<HTMLInputElement>
}

export function Checkbox({
  className,
  indeterminate = false,
  expandHitArea = false,
  ref,
  ...props
}: CheckboxProps) {
  const inner = React.useRef<HTMLInputElement | null>(null)

  // Merge our internal ref with the caller's, rather than casting a possibly-null node.
  const setRef = React.useCallback(
    (node: HTMLInputElement | null) => {
      inner.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )

  React.useEffect(() => {
    // `indeterminate` exists only as a DOM property; React cannot set it via JSX.
    if (inner.current) inner.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <span className={cn('relative inline-flex shrink-0', expandHitArea && 'isolate')}>
      <input
        ref={setRef}
        type="checkbox"
        className={cn(
          'peer border-border-control bg-surface size-4 shrink-0 appearance-none rounded-xs border',
          'duration-fast transition-[background-color,border-color] ease-out',
          'hover:border-ink-muted',
          'checked:border-accent checked:bg-accent checked:hover:bg-accent-hover',
          'indeterminate:border-accent indeterminate:bg-accent',
          'disabled:hover:border-border-control disabled:opacity-45',
          'disabled:not-checked:bg-bg-subtle',
          'aria-invalid:border-danger',
          expandHitArea && 'before:absolute before:-inset-2.5 before:content-[""]',
          className,
        )}
        {...props}
      />
      {/*
        Tick and dash are drawn as CSS-driven overlays keyed off the peer's state, so
        the single source of truth stays the native input. aria-hidden: the input owns
        the accessible state.
      */}
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className={cn(
          'text-ink-inverse pointer-events-none absolute inset-0 size-4 opacity-0',
          'peer-checked:opacity-100 peer-indeterminate:opacity-0',
        )}
      >
        <path
          d="M4 8.5l2.5 2.5L12 5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute top-1/2 left-1/2 h-[1.5px] w-2 -translate-x-1/2 -translate-y-1/2',
          'rounded-pill bg-ink-inverse opacity-0 peer-indeterminate:opacity-100',
        )}
      />
    </span>
  )
}

/**
 * The 32px clickable row that a bare checkbox must never be without (§9.5).
 * The whole row is the label, so the text is part of the hit target.
 */
export interface CheckboxRowProps extends Omit<CheckboxProps, 'children'> {
  label: React.ReactNode
  description?: React.ReactNode
  /** Wrapper classes; `className` still targets the box itself. */
  rowClassName?: string
}

export function CheckboxRow({ label, description, rowClassName, id, ...props }: CheckboxRowProps) {
  const generated = React.useId()
  const controlId = id ?? generated
  const descriptionId = description ? `${controlId}-description` : undefined

  return (
    <div className={cn('flex flex-col', rowClassName)}>
      <label
        htmlFor={controlId}
        className="text-body-sm text-ink has-disabled:text-ink-muted flex min-h-8 cursor-pointer items-start gap-2.5 py-1.5 has-disabled:cursor-not-allowed"
      >
        <Checkbox
          id={controlId}
          className="mt-0.5"
          {...(descriptionId ? { 'aria-describedby': descriptionId } : {})}
          {...props}
        />
        <span>{label}</span>
      </label>
      {description ? (
        <p id={descriptionId} className="text-caption text-ink-meta pl-6.5">
          {description}
        </p>
      ) : null}
    </div>
  )
}
