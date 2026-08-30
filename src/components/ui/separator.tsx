import type * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * A 1px hairline. Radix Separator is not installed, and the primitive is small
 * enough that the ARIA contract is the whole component: decorative separators are
 * aria-hidden, semantic ones get role="separator" with an orientation.
 *
 * Spacing is the caller's (§9.26): a hairline needs my-6/my-8 around it, and most
 * sections need vertical space instead of a line.
 */
export interface SeparatorProps extends React.ComponentPropsWithoutRef<'div'> {
  orientation?: 'horizontal' | 'vertical'
  /** false only when it divides two genuinely distinct regions. */
  decorative?: boolean
}

export function Separator({
  orientation = 'horizontal',
  decorative = true,
  className,
  ...props
}: SeparatorProps) {
  return (
    <div
      role={decorative ? 'presentation' : 'separator'}
      aria-hidden={decorative ? true : undefined}
      aria-orientation={decorative ? undefined : orientation}
      className={cn(
        'bg-border shrink-0',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  )
}
