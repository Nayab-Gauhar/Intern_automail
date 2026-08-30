import type * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * §9.2. Dimensions sm 32 / md 36 / lg 40, rounded-sm, text-body.
 *
 * `border-border-control` (not `border-border`) because a form-control outline must
 * clear WCAG 1.4.11 at 3:1 — the warm hairline does not (§6.2). Focus sets
 * `border-accent` on top of the global ring so the field still reads as active in a
 * browser that suppresses the outline.
 *
 * Invalid state is driven off `aria-invalid`, so Field's wiring alone turns the
 * border red — no separate `error` prop to keep in sync.
 */

const SIZES = {
  sm: 'h-8 text-body-sm',
  md: 'h-9',
  lg: 'h-10',
} as const

export const inputBaseClasses = cn(
  'w-full min-w-0 rounded-sm border border-border-control bg-surface px-3 text-body text-ink',
  'transition-[border-color] duration-fast ease-out',
  'hover:border-ink-muted focus-visible:border-accent',
  'disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-subtle disabled:text-ink-muted',
  'read-only:border-border read-only:bg-bg-subtle',
  'aria-invalid:border-danger',
  // Chrome's autofill yellow is not in our palette; repaint it with our own tokens.
  '[&:-webkit-autofill]:shadow-[inset_0_0_0_100px_var(--surface)]',
  '[&:-webkit-autofill]:[-webkit-text-fill-color:var(--ink)]',
)

export interface InputProps extends Omit<React.ComponentPropsWithoutRef<'input'>, 'size'> {
  inputSize?: keyof typeof SIZES
  /** Leaves room for an absolutely positioned 16px icon at left-3. */
  hasLeadingIcon?: boolean
  hasTrailingIcon?: boolean
  ref?: React.Ref<HTMLInputElement>
}

export function Input({
  className,
  inputSize = 'md',
  hasLeadingIcon = false,
  hasTrailingIcon = false,
  type = 'text',
  ...props
}: InputProps) {
  return (
    <input
      type={type}
      className={cn(
        inputBaseClasses,
        SIZES[inputSize],
        hasLeadingIcon && 'pl-9',
        hasTrailingIcon && 'pr-9',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Positioning shell for an input with an icon or a suffix control. Purely layout: the
 * icon itself is the caller's, so this file does not need to know which glyph.
 */
export type InputGroupProps = React.ComponentPropsWithoutRef<'div'>

export function InputGroup({ className, children, ...props }: InputGroupProps) {
  return (
    <div className={cn('relative flex w-full items-center', className)} {...props}>
      {children}
    </div>
  )
}

/** Absolutely positioned slot for a decorative icon inside an InputGroup. */
export interface InputAffixProps extends React.ComponentPropsWithoutRef<'span'> {
  side?: 'leading' | 'trailing'
}

export function InputAffix({ side = 'leading', className, children, ...props }: InputAffixProps) {
  return (
    <span
      // Decorative by default; a real control passed as a child keeps its own events.
      className={cn(
        'text-ink-meta pointer-events-none absolute inset-y-0 flex items-center',
        side === 'leading' ? 'left-3' : 'right-3',
        '[&_button]:pointer-events-auto',
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}
