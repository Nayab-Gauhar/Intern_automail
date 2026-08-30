import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { Role } from '@prisma/client'
import { logger } from '@/lib/logger'
import * as repo from '@/modules/auth/repo'
import type { ActiveMembership, SessionRecord } from '@/modules/auth/types'
import { requireSession } from './session'

/**
 * `Ctx` — the only thing a service function trusts.
 *
 * Brief §4 rule 3, plus the two fields every caller ends up needing anyway.
 * Every service entrypoint takes one as its first parameter, and every repo query
 * filters or sets `workspaceId` from it.
 */
export type Ctx = {
  userId: string
  workspaceId: string
  /** Read from WorkspaceMember on every request, never denormalised into Session. */
  role: Role
  /** So changePassword can revoke every session EXCEPT the caller's own. */
  sessionId: string
  /** The workspace's IANA zone. For rendering; never for storage. */
  timezone: string
}

/**
 * `Ctx` is constructed ONLY by `requireWorkspace()`.
 *
 * There is deliberately no `buildCtx(workspaceId)` exported from this module, no
 * test helper that fabricates one against production code, and no service that
 * takes a `workspaceId` alongside a `Ctx`. Making `Ctx` the sole carrier of
 * tenancy is what lets the isolation sweep be exhaustive: there is exactly one way
 * in, so "did we scope this query" is answerable by reading one file per module
 * rather than auditing forty call sites.
 */
function toCtx(session: SessionRecord, membership: ActiveMembership): Ctx {
  return {
    userId: session.userId,
    workspaceId: membership.workspaceId,
    role: membership.role,
    sessionId: session.id,
    timezone: membership.timezone,
  }
}

/**
 * Resolves the session and its live membership into a `Ctx`.
 *
 * Redirects rather than throwing, because every caller is a layout, page, or
 * action that wants a redirect. Wrapped in React `cache()`, so a page with eight
 * server components each calling this performs one session probe and one
 * membership lookup rather than sixteen queries.
 *
 * The membership lookup is the whole authorization root. `Session.activeWorkspaceId`
 * is a POINTER, not an authorization (07 §3): it says which workspace the user is
 * looking at, and whether they may is re-derived here on every request. A stale
 * pointer — member removed, membership suspended, workspace soft-deleted — falls
 * through to the fallback and grants nothing.
 *
 * Reading role per request rather than caching it in the session row is what makes
 * a role downgrade take effect on the next navigation with no revocation
 * machinery and no cache to invalidate (07 §5.6).
 */
export const requireWorkspace: () => Promise<Ctx> = cache(async (): Promise<Ctx> => {
  const session = await requireSession()

  const membership = session.activeWorkspaceId
    ? await repo.findActiveMembership(session.userId, session.activeWorkspaceId)
    : null

  if (membership) return toCtx(session, membership)

  // Either there is no active workspace yet, or the pointer went stale. Fall back
  // to any other live membership before giving up.
  const fallback = await repo.findFirstActiveMembership(session.userId)
  if (!fallback) redirect('/onboarding')

  await repo.setActiveWorkspace(session.id, fallback.workspaceId)
  return toCtx(session, fallback)
})

/**
 * Records — and discards — a `workspaceId` that arrived from a client.
 *
 * The rule (brief §4 rule 2, 07 §9.2): a `workspaceId` appearing in a request
 * body, query string, form field, route parameter, or JSON payload is IGNORED, and
 * logging it at `warn` is mandatory so §20's alert has a source to fire on.
 *
 * In practice every action schema is `.strict()`, so a stray `workspaceId` key is
 * a validation failure long before it reaches here. This exists for the surfaces
 * that read raw params — route handlers and `searchParams` — and as the one named
 * place the event is emitted.
 *
 * Honest caveat: most hits will be stale bookmarks, not attacks. It is a
 * rate-of-change signal, not a per-event alarm.
 */
export function noteCrossWorkspaceAttempt(
  ctx: Ctx,
  requested: { requestedId?: string; requestedType?: string },
): void {
  logger.warn('authz.cross_workspace_attempt', {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    ...(requested.requestedId != null ? { requestedId: requested.requestedId } : {}),
    ...(requested.requestedType != null ? { requestedType: requested.requestedType } : {}),
  })
}
