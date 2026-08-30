import type * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * §9.9. The raised container on the off-white ground.
 *
 * No hover lift (`-translate-y-1` is the most template-y hover in SaaS), no decorative
 * icon in a tinted rounded square, and a card nested inside a card drops its shadow —
 * stacked depth reads as clutter.
 *
 * There is no `asChild`: for an interactive card, render `<Link className={cardClasses
 * ({ interactive: true })}>`. That keeps one anchor per card, which is what makes the
 * whole surface keyboard-reachable.
 */

export interface CardOptions {
  interactive?: boolean | undefined
  selected?: boolean | undefined
  /** A card inside a card: subtle fill, no shadow. */
  nested?: boolean | undefined
}

export function cardClasses({ interactive, selected, nested }: CardOptions = {}) {
  return cn(
    'rounded-md border border-border bg-surface shadow-xs',
    nested && 'border-border bg-bg-subtle shadow-none',
    interactive &&
      'transition-[box-shadow,border-color] duration-fast ease-out hover:border-border-strong hover:shadow-sm',
    selected && 'border-accent ring-1 ring-accent-border',
  )
}

export interface CardProps extends React.ComponentPropsWithoutRef<'div'>, CardOptions {
  ref?: React.Ref<HTMLDivElement>
}

export function Card({ className, interactive, selected, nested, ...props }: CardProps) {
  return (
    <div
      {...(selected ? { 'data-selected': 'true' } : {})}
      className={cn(cardClasses({ interactive, selected, nested }), className)}
      {...props}
    />
  )
}

export interface CardHeaderProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Use when the body is a table or list, so the header owns the divider. */
  divided?: boolean
}

export function CardHeader({ className, divided = false, ...props }: CardHeaderProps) {
  return (
    <div className={cn('p-5', divided ? 'border-border border-b' : 'pb-0', className)} {...props} />
  )
}

export interface CardTitleProps extends React.ComponentPropsWithoutRef<'h3'> {
  /** Heading level. A card in a page section is usually h3; do not skip levels. */
  as?: 'h2' | 'h3' | 'h4'
}

export function CardTitle({ className, as: Tag = 'h3', ...props }: CardTitleProps) {
  return <Tag className={cn('text-heading text-ink', className)} {...props} />
}

export function CardDescription({ className, ...props }: React.ComponentPropsWithoutRef<'p'>) {
  return <p className={cn('text-body-sm text-ink-secondary mt-1', className)} {...props} />
}

export function CardContent({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div className={cn('p-5', className)} {...props} />
}

export interface CardFooterProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Action-bar treatment: top border and a recessed fill. */
  bar?: boolean
}

export function CardFooter({ className, bar = false, ...props }: CardFooterProps) {
  return (
    <div
      className={cn(
        bar ? 'border-border bg-bg-subtle flex items-center gap-2 border-t px-5 py-3' : 'p-5 pt-0',
        className,
      )}
      {...props}
    />
  )
}
