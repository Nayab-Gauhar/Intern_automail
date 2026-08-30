'use server'

import { redirect } from 'next/navigation'
import { destroyCurrentSession } from '@/server/session'

/**
 * Sign out.
 *
 * A server action, not a link: ending a session is a state change, and a
 * state-changing GET is forbidden (brief §6). Next's Server Actions are POSTs with
 * an origin check, which is the CSRF story here.
 *
 * This does not go through the `action()` wrapper, deliberately. That wrapper starts
 * by calling `requireWorkspace()` and refuses when there is no workspace — which
 * would make it impossible to sign out of a session whose workspace membership was
 * revoked, exactly when signing out matters most. Signing out also needs no
 * capability check: ending your own session is always permitted.
 *
 * `destroyCurrentSession()` revokes the row server-side and clears the cookie, so a
 * copy of the cookie taken beforehand is dead too.
 */
export async function signOut(): Promise<void> {
  await destroyCurrentSession()
  redirect('/login')
}
