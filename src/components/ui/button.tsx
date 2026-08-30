import type * as React from 'react'
import { cn } from '@/lib/cn'
import { Spinner } from './spinner'

/**
 * §9.1. Six variants, six sizes, no `asChild` — Radix Slot is not installed, so a
 * button-styled link uses `buttonClasses()` on a real <a>/<Link> instead. That is
 * the correct markup anyway: an <a> inside a <button> is invalid.
 *
 * Not a client component. A Server Component must be able to render it (§8.5).
 */

export type ButtonVariant =
  'primary' | 'secondary' | 'ghost' | 'destructive' | 'destructive-ghost' | 'link'

export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon-sm' | 'icon' | 'icon-lg'

const VARIANTS: Record<ButtonVariant, string> = {
  // The pill. Max one per page region.
  primary:
    'rounded-pill bg-accent text-ink-inverse shadow-xs hover:bg-accent-hover active:bg-accent-active',
  secondary:
    'rounded-sm bg-surface text-ink border border-border-strong shadow-xs hover:bg-surface-hover hover:border-ink-muted active:bg-bg-active',
  ghost: 'rounded-sm text-ink-secondary hover:bg-bg-hover hover:text-ink active:bg-bg-active',
  // The navy focus ring on a clay fill is muddy, so destructive fills re-point it.
  destructive:
    'rounded-sm bg-danger text-ink-inverse shadow-xs hover:bg-danger-hover active:bg-danger-active focus-visible:outline-[var(--ring-danger)]',
  'destructive-ghost':
    'rounded-sm text-danger hover:bg-danger-subtle active:bg-danger-subtle focus-visible:outline-[var(--ring-danger)]',
  link: 'text-accent underline underline-offset-4 decoration-border-strong hover:decoration-accent',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-label gap-1.5',
  md: 'h-9 px-4 text-label gap-2',
  lg: 'h-11 px-6 text-body gap-2',
  'icon-sm': 'size-7 p-0',
  icon: 'size-8 p-0',
  'icon-lg': 'size-9 p-0',
}

/** `link` has no box, so it opts out of the height/padding grid entirely. */
const BASE =
  'inline-flex items-center justify-center whitespace-nowrap select-none font-medium ' +
  'transition-[background-color,border-color,color,text-decoration-color] duration-fast ease-out ' +
  'disabled:opacity-45 disabled:pointer-events-none aria-disabled:opacity-45 ' +
  '[&_svg]:shrink-0'

export function buttonClasses(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md') {
  return cn(BASE, VARIANTS[variant], variant === 'link' ? 'gap-1.5' : SIZES[size])
}

/**
 * Icon-only sizes carry no text, so `aria-label` is required by the type — the a11y
 * gate is not left to review (§9.1).
 */
type IconOnlyProps = { size: 'icon-sm' | 'icon' | 'icon-lg'; 'aria-label': string }
type LabelledProps = { size?: 'sm' | 'md' | 'lg'; 'aria-label'?: string }

type BaseButtonProps = Omit<React.ComponentPropsWithoutRef<'button'>, 'aria-label'> & {
  variant?: ButtonVariant
  /** Swaps the leading slot for a spinner, disables, and sets aria-busy. Label stays. */
  loading?: boolean
  /** Lucide icon at size-4, stroke 1.75. Replaced by the spinner while `loading`. */
  leadingIcon?: React.ReactNode
  trailingIcon?: React.ReactNode
  ref?: React.Ref<HTMLButtonElement>
}

export type ButtonProps = BaseButtonProps & (IconOnlyProps | LabelledProps)

export function Button({
  className,
  variant = 'secondary',
  size,
  loading = false,
  leadingIcon,
  trailingIcon,
  disabled,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      // Explicit type, always: a bare <button> in a form submits it (§9.1).
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      className={cn(buttonClasses(variant, size ?? 'md'), className)}
      {...props}
    >
      {loading ? <Spinner size={size === 'sm' || size === 'icon-sm' ? 'sm' : 'md'} /> : leadingIcon}
      {/* On icon-only sizes `children` IS the icon; the accessible name is aria-label. */}
      {children}
      {loading ? null : trailingIcon}
    </button>
  )
}
