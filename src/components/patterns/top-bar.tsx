'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Menu, X } from 'lucide-react'
import { Avatar, Button } from '@/components/ui'
import { SidebarNav } from './sidebar'

/**
 * The authenticated top bar (design system §10.3). 60px, sticky, translucent over the
 * warm ground with an opaque fallback for browsers without backdrop-filter.
 *
 * A client component because it owns the below-`lg` navigation disclosure.
 *
 * The page title deliberately does NOT live here — it lives in PageHeader, so it can be
 * 30px display type.
 *
 * Sign-out is a real <form> posting to a server action, never a link: signing out is a
 * state change and a GET that mutates is forbidden (brief §6). The action is passed in
 * as a prop so this file stays free of server imports.
 *
 * `signOutAction` is optional because the session layer has not landed yet. When it is
 * absent the control renders disabled with a spelled-out reason rather than as a button
 * that silently does nothing — the brief forbids a control that looks live and is not.
 */
export interface TopBarProps {
  /** Null until the session layer lands and a real workspace can be resolved. */
  workspaceName: string | null
  userName: string | null
  /** Server action bound by the layout. A <form action={fn}> works without JS. */
  signOutAction?: (() => void | Promise<void>) | undefined
}

export function TopBar({ workspaceName, userName, signOutAction }: TopBarProps) {
  const [navOpen, setNavOpen] = useState(false)

  return (
    <>
      <header
        className={[
          'z-sticky sticky top-0 flex h-[60px] shrink-0 items-center gap-3',
          'gutter-x border-border border-b',
          'bg-bg/85 supports-[not(backdrop-filter:blur(0px))]:bg-bg backdrop-blur-md',
        ].join(' ')}
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={navOpen}
          aria-controls="mobile-nav"
          onClick={() => setNavOpen((open) => !open)}
          className="lg:hidden"
        >
          {navOpen ? (
            <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
          ) : (
            <Menu aria-hidden="true" strokeWidth={1.75} className="size-4" />
          )}
        </Button>

        {/* The wordmark only appears here below lg, where the sidebar is hidden. */}
        <Link href="/dashboard" className="font-display text-heading text-ink rounded-sm lg:hidden">
          Instant Mail
        </Link>

        <div className="hidden min-w-0 items-center gap-2 lg:flex">
          <span className="text-caption text-ink-meta">Workspace</span>
          {workspaceName ? (
            <span className="text-label text-ink truncate">{workspaceName}</span>
          ) : (
            <span className="text-label text-ink-muted truncate">Not signed in</span>
          )}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-3">
          {userName ? (
            <span className="hidden items-center gap-2 sm:flex">
              <Avatar name={userName} size="sm" />
              <span className="text-label text-ink-secondary truncate">{userName}</span>
            </span>
          ) : null}

          {/*
            No dropdown: Radix is not installed, and a hand-rolled menu without a focus
            trap is worse than two plain controls. Profile lives in Settings.
          */}
          {signOutAction ? (
            <form action={signOutAction}>
              <Button type="submit" variant="secondary" size="sm">
                Sign out
              </Button>
            </form>
          ) : (
            <>
              <Button variant="secondary" size="sm" disabled aria-describedby="signout-unavailable">
                Sign out
              </Button>
              <span id="signout-unavailable" className="sr-only">
                Sign out is unavailable: the session layer is not built yet, so there is no session
                to end.
              </span>
            </>
          )}
        </div>
      </header>

      {navOpen ? (
        <div
          id="mobile-nav"
          className="border-border bg-bg z-dropdown sticky top-[60px] flex flex-col border-b lg:hidden"
        >
          <SidebarNav onNavigate={() => setNavOpen(false)} />
        </div>
      ) : null}
    </>
  )
}
