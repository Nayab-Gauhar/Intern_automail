import type * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * §9.4 specifies Radix Select. Radix is not installed, so this is a **native
 * <select>** styled to match Input's dimensions exactly.
 *
 * What that costs, stated plainly rather than hidden: no grouped items with icons, no
 * checkmark alignment slot, no in-menu search, and the option list is painted by the
 * OS. What it buys: correct keyboard behaviour, typeahead, and mobile pickers for
 * free, and zero new dependencies. Swap in Radix behind this same export when the
 * lead ratifies the dependency.
 *
 * `appearance-none` plus our own ChevronDown, because the platform arrow does not
 * respect the palette. The chevron is aria-hidden and pointer-events-none so clicks
 * fall through to the select.
 */

const SIZES = {
  sm: 'h-8 text-body-sm',
  md: 'h-9',
  lg: 'h-10',
} as const

export interface SelectProps extends Omit<React.ComponentPropsWithoutRef<'select'>, 'size'> {
  selectSize?: keyof typeof SIZES
  /** Rendered as a disabled, selected-by-default first option. */
  placeholder?: string
  ref?: React.Ref<HTMLSelectElement>
}

export function Select({
  className,
  selectSize = 'md',
  placeholder,
  children,
  defaultValue,
  value,
  ...props
}: SelectProps) {
  const uncontrolledPlaceholder =
    placeholder !== undefined && value === undefined && defaultValue === undefined

  return (
    <div className="relative flex w-full items-center">
      <select
        className={cn(
          'border-border-control bg-surface w-full min-w-0 appearance-none rounded-sm border',
          'text-body text-ink pr-9 pl-3',
          'duration-fast transition-[border-color] ease-out',
          'hover:border-ink-muted focus-visible:border-accent',
          'disabled:border-border disabled:bg-bg-subtle disabled:text-ink-muted disabled:cursor-not-allowed',
          'aria-invalid:border-danger',
          SIZES[selectSize],
          className,
        )}
        {...(uncontrolledPlaceholder ? { defaultValue: '' } : { defaultValue, value })}
        {...props}
      >
        {placeholder !== undefined ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        strokeWidth={1.75}
        className="text-ink-meta pointer-events-none absolute right-3 size-4"
      />
    </div>
  )
}
