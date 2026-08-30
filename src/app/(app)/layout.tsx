import type { ReactNode } from 'react'
import { me } from '@/modules/auth'
import { requireWorkspace } from '@/server/ctx'
import { requireSession } from '@/server/session'
import { Sidebar } from '@/components/patterns/sidebar'
import { TopBar } from '@/components/patterns/top-bar'
import { signOut } from './actions'

/**
 * The authenticated shell (design system §10.1): fixed sidebar, sticky top bar, and a
 * single <main> the pages stream into.
 *
 * THIS is the real authentication boundary. `requireWorkspace()` validates the session
 * token against the database, checks it is neither revoked nor expired, resolves live
 * workspace membership and role, and redirects on its own — `/login?next=…` with no
 * valid session, `/onboarding` with no membership. `middleware.ts` is a UX fast path
 * only and is explicitly not a substitute for this.
 *
 * Both calls are wrapped in React `cache()`, so resolving the session here and again in
 * a page costs one query, not two.
 *
 * The workspace NAME is not rendered yet: `Ctx` carries `workspaceId`, `role`, and
 * `timezone` but not the name, and reading it needs `workspace.get(ctx)` through
 * `src/modules/workspace/index.ts`, which has not landed. Importing that module's
 * `service.ts` directly would breach the module-boundary rule, so the chip is omitted
 * rather than filled with a guess.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  // requireWorkspace() is the guard; the session is needed separately for `me()`.
  await requireWorkspace()
  const session = await requireSession()
  const user = await me(session)

  return (
    <div className="bg-bg min-h-dvh">
      {/* First focusable element in the shell, per the accessibility gate. */}
      <a
        href="#main"
        className="focus:bg-surface focus:text-ink focus:border-border-strong focus:z-toast sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:rounded-sm focus:border focus:px-3 focus:py-2 focus:shadow-md"
      >
        Skip to main content
      </a>

      <Sidebar />

      <div className="flex min-h-dvh flex-col lg:pl-[248px]">
        <TopBar workspaceName={null} userName={user.name ?? user.email} signOutAction={signOut} />

        <main id="main" className="flex-1 pb-16">
          {children}
        </main>
      </div>
    </div>
  )
}
