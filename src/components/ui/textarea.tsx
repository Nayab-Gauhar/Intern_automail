import type * as React from 'react'
import { cn } from '@/lib/cn'
import { inputBaseClasses } from './input'

/**
 * §9.3. Same tokens and states as Input.
 *
 * Auto-grow is `field-sizing-content` + max-h, not a JS resize hook: the CSS property
 * ships in Chrome/Edge/Safari 17.4+, and Firefox's fallback (a fixed min-height) is
 * acceptable degradation. A hook here would be 40 lines of ref juggling for one browser.
 */
export interface TextareaProps extends React.ComponentPropsWithoutRef<'textarea'> {
  /** `resize-y` is for the sequence-step body editor; everything else stays fixed. */
  resizable?: boolean
  ref?: React.Ref<HTMLTextAreaElement>
}

export function Textarea({ className, resizable = false, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(
        inputBaseClasses,
        '[field-sizing:content] max-h-64 min-h-20 py-2.5',
        resizable ? 'resize-y' : 'resize-none',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Character counter for subject lines and platform limits (§9.3).
 *
 * aria-live is armed only within 20 characters of the limit — announcing every
 * keystroke is hostile — and the state is carried by the text itself ("12 over the
 * 150 character limit"), not by colour alone.
 */
export interface CharacterCountProps extends React.ComponentPropsWithoutRef<'p'> {
  value: number
  limit: number
}

export function CharacterCount({ value, limit, className, ...props }: CharacterCountProps) {
  const over = value > limit
  const near = value >= limit * 0.9
  const announce = value >= limit - 20

  return (
    <p
      // aria-live only near the limit; polite so it never interrupts typing.
      aria-live={announce ? 'polite' : 'off'}
      className={cn(
        'text-caption tabular-nums',
        over ? 'text-danger' : near ? 'text-warning' : 'text-ink-meta',
        className,
      )}
      {...props}
    >
      <span aria-hidden="true">
        {value}/{limit}
      </span>
      <span className="sr-only">
        {over
          ? `${value - limit} characters over the ${limit} character limit`
          : `${value} of ${limit} characters used`}
      </span>
    </p>
  )
}
