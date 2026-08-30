import type * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * §9.2. A real <label htmlFor>, never a <div> pretending to be one.
 *
 * The required marker is the *word* "Required" in meta ink, not a red asterisk: an
 * asterisk has no accessible name and most users cannot say what it means. Pick one
 * direction per form — mark the required fields or the optional ones, never both.
 */
export interface LabelProps extends React.ComponentPropsWithoutRef<'label'> {
  requiredHint?: boolean
  optionalHint?: boolean
  ref?: React.Ref<HTMLLabelElement>
}

export function Label({
  className,
  children,
  requiredHint = false,
  optionalHint = false,
  ...props
}: LabelProps) {
  return (
    <label className={cn('text-label text-ink flex items-baseline gap-2', className)} {...props}>
      <span>{children}</span>
      {requiredHint ? <span className="text-caption text-ink-meta">Required</span> : null}
      {optionalHint && !requiredHint ? (
        <span className="text-caption text-ink-meta">Optional</span>
      ) : null}
    </label>
  )
}
