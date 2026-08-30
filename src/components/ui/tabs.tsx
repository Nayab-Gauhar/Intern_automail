'use client'

import * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * §9.12. Underline tabs — no pills, no boxed tabs, no segmented-control look, and no
 * sliding indicator (the underline snaps; a 160ms slide is exactly the motion that
 * ages badly).
 *
 * Radix Tabs is not installed, so this implements the WAI-ARIA tabs pattern by hand
 * with a **roving tabindex**: exactly one trigger is tabbable, ArrowLeft/ArrowRight
 * move between triggers with wraparound, Home/End jump to the ends, and disabled
 * triggers are skipped. Activation is automatic (focus selects), which is correct here
 * because every panel is already-rendered client content.
 *
 * Trigger order is read from the DOM at keydown time, not from a registry. A registry
 * would have to be rebuilt whenever the selected value changes, and the
 * unregister/re-register cycle silently reorders it; querying `[role="tab"]` cannot
 * drift from what the user sees.
 *
 * IMPORTANT (§9.12): use this ONLY for genuinely client-side, same-payload switching.
 * If switching a tab changes what data is loaded (Campaign -> Overview / Leads /
 * Sequence), those are LINKS styled as tabs with aria-current="page", not this
 * component — URL is state (brief §8) and each panel is its own RSC segment. Use
 * `tabsListClasses` / `tabTriggerClasses` to style that nav.
 */

interface TabsContextValue {
  value: string
  setValue: (next: string) => void
  baseId: string
}

const TabsContext = React.createContext<TabsContextValue | null>(null)

function useTabs(component: string): TabsContextValue {
  const ctx = React.useContext(TabsContext)
  if (!ctx) throw new Error(`<${component}> must be rendered inside <Tabs>`)
  return ctx
}

export interface TabsProps extends Omit<React.ComponentPropsWithoutRef<'div'>, 'onChange'> {
  /** Controlled selection. Omit for uncontrolled with `defaultValue`. */
  value?: string
  defaultValue: string
  onValueChange?: (value: string) => void
}

export function Tabs({
  value: controlled,
  defaultValue,
  onValueChange,
  className,
  children,
  ...props
}: TabsProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue)
  const value = controlled ?? uncontrolled
  const baseId = React.useId()

  const setValue = React.useCallback(
    (next: string) => {
      if (controlled === undefined) setUncontrolled(next)
      onValueChange?.(next)
    },
    [controlled, onValueChange],
  )

  const ctx = React.useMemo<TabsContextValue>(
    () => ({ value, setValue, baseId }),
    [value, setValue, baseId],
  )

  return (
    <TabsContext.Provider value={ctx}>
      <div className={cn('flex flex-col', className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  )
}

/** Shared with route-tab navs so the two visual styles cannot drift apart. */
export const tabsListClasses = 'flex h-10 items-center gap-6 border-b border-border'

export interface TabsListProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Names the tab set for screen readers. */
  label: string
}

export function TabsList({ className, label, children, onKeyDown, ...props }: TabsListProps) {
  const ref = React.useRef<HTMLDivElement>(null)

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event)
    if (event.defaultPrevented) return

    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(event.key) || !ref.current) return

    // DOM order, disabled triggers dropped. This is the authoritative sequence.
    const tabs = Array.from(ref.current.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter(
      (tab) => !tab.disabled,
    )
    if (tabs.length === 0) return

    event.preventDefault()

    if (event.key === 'Home') {
      tabs[0]?.focus()
      return
    }
    if (event.key === 'End') {
      tabs[tabs.length - 1]?.focus()
      return
    }

    // Walk from whichever tab currently holds focus, wrapping at both ends.
    const active = document.activeElement
    const current = tabs.findIndex((tab) => tab === active)
    const step = event.key === 'ArrowRight' ? 1 : -1
    const from = current === -1 ? 0 : current
    tabs[(from + step + tabs.length) % tabs.length]?.focus()
  }

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn(tabsListClasses, className)}
      {...props}
    >
      {children}
    </div>
  )
}

export const tabTriggerClasses = cn(
  'relative inline-flex h-10 items-center gap-1.5 text-label text-ink-secondary',
  'transition-colors duration-fast hover:text-ink',
  // Inset ring: the 40px strip would clip an offset one.
  'focus-visible:outline-offset-[-2px]',
  'disabled:pointer-events-none disabled:opacity-45',
)

/** The 2px underline on the active tab. Snaps; nothing animates. */
export const tabTriggerActiveClasses =
  'text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-accent'

export interface TabsTriggerProps extends React.ComponentPropsWithoutRef<'button'> {
  value: string
}

export function TabsTrigger({
  className,
  value,
  children,
  disabled,
  onFocus,
  onClick,
  ...props
}: TabsTriggerProps) {
  const { value: selectedValue, setValue, baseId } = useTabs('TabsTrigger')
  const selected = selectedValue === value

  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      data-tab-value={value}
      aria-selected={selected}
      aria-controls={`${baseId}-panel-${value}`}
      // Roving tabindex: only the selected trigger sits in the tab sequence, so Tab
      // enters and leaves the strip rather than stepping through every tab.
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      onFocus={(event) => {
        onFocus?.(event)
        // Automatic activation: arrowing to a tab selects it.
        if (!disabled) setValue(value)
      }}
      onClick={(event) => {
        onClick?.(event)
        setValue(value)
      }}
      className={cn(tabTriggerClasses, selected && tabTriggerActiveClasses, className)}
      {...props}
    >
      {children}
    </button>
  )
}

export interface TabsPanelProps extends React.ComponentPropsWithoutRef<'div'> {
  value: string
}

export function TabsPanel({ className, value, children, ...props }: TabsPanelProps) {
  const { value: selectedValue, baseId } = useTabs('TabsPanel')
  const selected = selectedValue === value

  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      hidden={!selected}
      // tabIndex 0 so the panel is reachable after the strip; the ARIA pattern requires
      // it for panels that hold no focusable content of their own.
      tabIndex={selected ? 0 : -1}
      className={cn('pt-5 focus-visible:outline-offset-[-2px]', className)}
      {...props}
    >
      {selected ? children : null}
    </div>
  )
}
