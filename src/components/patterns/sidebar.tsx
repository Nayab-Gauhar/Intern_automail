'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  ChartNoAxesColumn,
  Inbox,
  LayoutDashboard,
  Mail,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge } from '@/components/ui'

/**
 * The primary navigation (design system §10.2).
 *
 * A client component for one reason only: it needs `usePathname()` to mark the current
 * route. Everything else about it is static.
 *
 * `bg-bg` — the sidebar is the SAME warm ground as the page, separated only by a
 * hairline right border. A darker or white sidebar produces the two-tone dashboard
 * look the design system explicitly rejects. This is deliberate; please do not "fix" it.
 *
 * The ten destinations are brief §3's list, in its order. The shortcut items the
 * frontend spec sketches (Tasks, Lists, Sequences) are deliberately absent: they point
 * into pages and tab states that do not exist yet, and a nav entry that lands on an
 * unbuilt tab is worse than no entry.
 */

type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  /**
   * True once the section renders real data. False marks a section whose page is an
   * honest "not built yet" placeholder — surfaced in the nav as a visible "Soon" tag
   * plus screen-reader text, so nobody clicks expecting a working feature.
   */
  built: boolean
}

type NavGroup = { label: string; items: NavItem[] }

const GROUPS: NavGroup[] = [
  {
    label: 'Work',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, built: true },
      { href: '/inbox', label: 'Inbox', icon: Inbox, built: false },
    ],
  },
  {
    label: 'Audience',
    items: [{ href: '/leads', label: 'Leads', icon: Users, built: false }],
  },
  {
    label: 'Outreach',
    items: [
      { href: '/campaigns', label: 'Campaigns', icon: Send, built: false },
      { href: '/mailboxes', label: 'Mailboxes', icon: Mail, built: false },
    ],
  },
  {
    label: 'Revenue',
    items: [
      { href: '/crm', label: 'CRM', icon: Target, built: false },
      { href: '/analytics', label: 'Analytics', icon: ChartNoAxesColumn, built: false },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/ai', label: 'AI', icon: Sparkles, built: false },
      { href: '/deliverability', label: 'Deliverability', icon: ShieldCheck, built: false },
      { href: '/settings', label: 'Settings', icon: Settings, built: false },
    ],
  },
]

/** `/leads` is current for `/leads/123`; `/` never matches everything. */
function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function SidebarNav({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const pathname = usePathname()

  return (
    <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 pb-6">
      {GROUPS.map((group, index) => (
        <div key={group.label} className={index === 0 ? 'mt-2' : 'mt-6'}>
          <h2 className="text-micro text-ink-meta mb-1.5 px-2.5 uppercase">{group.label}</h2>
          <ul>
            {group.items.map((item) => {
              const current = isCurrent(pathname, item.href)
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    // Spread rather than pass `undefined`: exactOptionalPropertyTypes
                    // rejects an explicit undefined for an optional handler.
                    {...(onNavigate ? { onClick: onNavigate } : {})}
                    // aria-current is the programmatic channel; the tinted fill is
                    // the visual one. Neither alone is sufficient.
                    aria-current={current ? 'page' : undefined}
                    className={cn(
                      'text-body-sm flex h-9 items-center gap-2.5 rounded-sm px-2.5',
                      'duration-fast transition-colors ease-out',
                      current
                        ? 'bg-accent-subtle text-accent font-medium'
                        : 'text-ink-secondary hover:bg-bg-hover hover:text-ink',
                    )}
                  >
                    <item.icon
                      aria-hidden="true"
                      strokeWidth={1.75}
                      className={cn('size-4 shrink-0', current ? 'text-accent' : 'text-ink-meta')}
                    />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {!item.built ? (
                      <>
                        <Badge className="shrink-0">Soon</Badge>
                        <span className="sr-only">(not built yet)</span>
                      </>
                    ) : null}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

/**
 * The fixed desktop sidebar. Hidden below `lg`, where navigation moves into the
 * top bar's disclosure instead.
 */
export function Sidebar() {
  return (
    <div className="border-border bg-bg z-sticky fixed inset-y-0 left-0 hidden w-[248px] flex-col border-r lg:flex">
      <div className="flex h-[60px] shrink-0 items-center px-5">
        {/* The one place the serif appears in chrome, because it is a logotype. */}
        <Link href="/dashboard" className="font-display text-heading text-ink rounded-sm">
          Instant Mail
        </Link>
      </div>
      <SidebarNav />
    </div>
  )
}
