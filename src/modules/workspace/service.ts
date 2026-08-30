import 'server-only'
import type { Prisma, Role } from '@prisma/client'
import { NotFoundError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { err, ok, type Result } from '@/lib/result'
import { hashToken, mintToken } from '@/lib/tokens'
import { assertRoleChangeAllowed, requireCan } from '@/server/authz'
import type { Ctx } from '@/server/ctx'
import * as authRepo from '@/modules/auth/repo'
import type { SessionRecord } from '@/modules/auth/types'
import * as repo from './repo'
import type {
  AcceptInviteFailure,
  AuditEntry,
  InviteDescription,
  InviteFailure,
  Member,
  PendingInvite,
  RemoveMemberFailure,
  RoleChangeFailure,
  Workspace,
  WorkspaceSummary,
} from './types'
import type {
  ChangeRoleInput,
  InviteMemberInput,
  ListAuditLogInput,
  UpdateWorkspaceSettingsInput,
} from './schema'

/**
 * Workspace administration: settings, members, invites, roles, the audit log.
 *
 * `requireCan(ctx, capability)` is the FIRST statement of every mutating function
 * here. The `action()` wrapper checks the same capability, which looks redundant
 * and is not: a service is also reachable from a route handler and from a job
 * handler, and only the service-level check covers all three entry points. The UI
 * hides, the server stops.
 *
 * Read paths get `requireCan` too, even where every role passes, because it
 * documents intent and costs an array lookup.
 */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ─────────────────────────────────────────────────────────── workspace

export async function get(ctx: Ctx): Promise<Workspace> {
  const workspace = await repo.findWorkspace(ctx)
  if (!workspace) throw new NotFoundError('Workspace')
  return workspace
}

/** The switcher's list. Takes a session rather than a Ctx: it spans workspaces. */
export async function listForUser(session: SessionRecord): Promise<WorkspaceSummary[]> {
  return repo.listWorkspacesForUser(session.userId)
}

export async function updateSettings(
  ctx: Ctx,
  input: UpdateWorkspaceSettingsInput,
): Promise<Workspace> {
  requireCan(ctx, 'workspace.edit')

  const count = await repo.updateWorkspace(ctx, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.dailySendLimit !== undefined ? { dailySendLimit: input.dailySendLimit } : {}),
    ...(input.trackOpensDefault !== undefined
      ? { trackOpensDefault: input.trackOpensDefault }
      : {}),
    ...(input.trackClicksDefault !== undefined
      ? { trackClicksDefault: input.trackClicksDefault }
      : {}),
    ...(input.unsubscribeFooterHtml !== undefined
      ? { unsubscribeFooterHtml: input.unsubscribeFooterHtml }
      : {}),
  })
  if (count !== 1) throw new NotFoundError('Workspace')

  await repo.insertAuditLog(ctx, {
    action: 'workspace.settings_updated',
    targetType: 'Workspace',
    targetId: ctx.workspaceId,
    metadata: { fields: Object.keys(input) },
  })
  logger.info('workspace.settings_updated', { userId: ctx.userId, workspaceId: ctx.workspaceId })

  return get(ctx)
}

/** OWNER only. Two-phase: mark deleted here, MAINTENANCE purges later. */
export async function softDelete(ctx: Ctx): Promise<void> {
  requireCan(ctx, 'workspace.delete')

  const count = await repo.softDeleteWorkspace(ctx)
  if (count !== 1) throw new NotFoundError('Workspace')

  await repo.insertAuditLog(ctx, {
    action: 'workspace.deleted',
    targetType: 'Workspace',
    targetId: ctx.workspaceId,
  })
  logger.warn('workspace.deleted', { userId: ctx.userId, workspaceId: ctx.workspaceId })
}

/**
 * Switches the active workspace.
 *
 * The membership check IS the authorization. The incoming slug is
 * attacker-controlled, so it is VALIDATED against `WorkspaceMember` rather than
 * trusted. This is not an exception to brief §4 rule 2: the slug is a selector
 * among the user's own memberships, and the resulting `Ctx` is still built
 * server-side from the row we just verified.
 *
 * A miss is `NotFoundError` (404), never `ForbiddenError` (403) — a 403 here would
 * confirm that a workspace with that slug exists, which is a cross-tenant existence
 * oracle on a globally unique column.
 *
 * The caller must follow this with `revalidatePath('/', 'layout')`. Without it,
 * cached RSC payloads from the previous workspace render under the new one — a
 * tenant leak through the framework's cache rather than through a query. It is the
 * caller's job because a service that imports `next/cache` cannot run in the worker.
 */
export async function switchWorkspace(
  session: SessionRecord,
  slug: string,
): Promise<{ workspaceId: string }> {
  const membership = await repo.findActiveMembershipBySlug(session.userId, slug)
  if (!membership) {
    logger.warn('authz.cross_workspace_attempt', {
      userId: session.userId,
      requestedType: 'Workspace',
      requestedSlug: slug,
    })
    throw new NotFoundError('Workspace')
  }

  await authRepo.setActiveWorkspace(session.id, membership.workspaceId)
  logger.info('workspace.switched', {
    userId: session.userId,
    workspaceId: membership.workspaceId,
  })
  return { workspaceId: membership.workspaceId }
}

// ───────────────────────────────────────────────────────────── members

export async function listMembers(ctx: Ctx): Promise<Member[]> {
  requireCan(ctx, 'members.view')
  return repo.listMembers(ctx)
}

export async function listPendingInvites(ctx: Ctx): Promise<PendingInvite[]> {
  requireCan(ctx, 'members.view')
  return repo.listPendingInvites(ctx)
}

/**
 * Invites someone to the workspace.
 *
 * Returns the plaintext token so the caller can hand it to a `Mailer`. It must
 * never reach an HTTP response body — the token IS the capability.
 */
export async function invite(
  ctx: Ctx,
  input: InviteMemberInput,
): Promise<Result<{ inviteId: string; token: string }, InviteFailure>> {
  requireCan(ctx, 'members.invite')

  // Nobody may mint a role above their own: an ADMIN inviting a puppet account as
  // OWNER is self-escalation. There is deliberately no runtime check for it here,
  // because `inviteMemberSchema.role` is `z.enum(['ADMIN','MEMBER'])` — an OWNER
  // invite is UNREPRESENTABLE in this function's input type, and tsc rejects the
  // comparison as dead code. The type is the control. If the schema ever widens to
  // include OWNER, that comparison stops being dead and must be reinstated; the
  // `role_above_own` failure variant is kept for exactly that day.
  //
  // An existing ACTIVE member is not an invite, it is a no-op with a clear error.
  const existing = await repo.findActiveMemberByEmail(ctx, input.email)
  if (existing) return err({ kind: 'already_member' })

  const token = mintToken()
  const invited = await repo.replacePendingInvite({
    ctx,
    email: input.email,
    role: input.role,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    invitedById: ctx.userId,
  })

  await repo.insertAuditLog(ctx, {
    action: 'member.invited',
    targetType: 'WorkspaceInvite',
    targetId: invited.id,
    metadata: { email: input.email, role: input.role },
  })
  logger.info('workspace.member_invited', {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    role: input.role,
  })

  return ok({ inviteId: invited.id, token })
}

export async function revokeInvite(ctx: Ctx, inviteId: string): Promise<void> {
  requireCan(ctx, 'members.invite')

  const count = await repo.revokeInvite(ctx, inviteId)
  // Scoped by workspaceId in the query, so another tenant's invite id is simply a
  // miss — 404, never 403.
  if (count !== 1) throw new NotFoundError('Invite')

  await repo.insertAuditLog(ctx, {
    action: 'member.invite_revoked',
    targetType: 'WorkspaceInvite',
    targetId: inviteId,
  })
}

/**
 * What an unauthenticated visitor may see at `/accept-invite/[token]`.
 *
 * Takes no `Ctx` by necessity. Safe because the lookup is keyed by the hash of an
 * unguessable 256-bit token and returns only the invite's own contents — no member
 * list, no workspace id, nothing that is not already implied by holding the link.
 */
export async function describeInvite(token: string): Promise<InviteDescription | null> {
  return repo.describeInviteByTokenHash(hashToken(token))
}

/**
 * Accepts an invite for an already-signed-in user.
 *
 * The invited email must match the accepting user's, or a forwarded invite would
 * grant access to whoever opens it. The comparison, the consume, the membership
 * upsert, and the session pointer all happen in one transaction in the repo.
 *
 * Identity is never auto-switched: when the signed-in user is someone else, the
 * caller renders an explicit warning and a "sign out and accept" path.
 */
export async function acceptInvite(
  session: SessionRecord,
  userEmail: string,
  token: string,
): Promise<Result<{ workspaceId: string; role: Role }, AcceptInviteFailure>> {
  const result = await repo.consumeInviteAndJoin({
    tokenHash: hashToken(token),
    userId: session.userId,
    userEmail,
    sessionId: session.id,
  })

  if (!result.ok) {
    logger.warn('workspace.invite_rejected', { userId: session.userId, reason: result.reason })
    return result.reason === 'email_mismatch'
      ? err({ kind: 'email_mismatch', invitedEmail: result.invitedEmail })
      : err({ kind: 'invalid_or_expired' })
  }

  logger.info('auth.invite.accepted', {
    userId: session.userId,
    workspaceId: result.workspaceId,
    role: result.role,
  })
  return ok({ workspaceId: result.workspaceId, role: result.role })
}

/**
 * Changes a member's role.
 *
 * Three layers, and each catches something the others cannot:
 *   1. `requireCan` — does this role hold the capability at all?
 *   2. `assertRoleChangeAllowed` — the two rules the matrix cannot express: nobody
 *      grants a role above their own, and nobody changes an OWNER's role unless
 *      they are an OWNER. Throws `ForbiddenError`.
 *   3. The last-OWNER invariant, enforced with `FOR UPDATE` inside the mutating
 *      transaction in the repo. Checked outside it, it is a TOCTOU bug.
 */
export async function changeRole(
  ctx: Ctx,
  input: ChangeRoleInput,
): Promise<Result<{ userId: string; role: Role }, RoleChangeFailure>> {
  requireCan(ctx, 'members.change_role')

  const target = await repo.findMembership(ctx, input.userId)
  if (!target) return err({ kind: 'not_a_member' })

  assertRoleChangeAllowed(ctx, target, input.role)

  const result = await repo.changeMemberRole(ctx, input.userId, input.role)
  if (!result.ok) return err({ kind: result.reason })

  await repo.insertAuditLog(ctx, {
    action: 'member.role_changed',
    targetType: 'WorkspaceMember',
    targetId: input.userId,
    metadata: { from: target.role, to: input.role },
  })
  logger.info('workspace.role_changed', {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    targetUserId: input.userId,
    from: target.role,
    to: input.role,
  })

  return ok({ userId: input.userId, role: input.role })
}

/**
 * Removes a member.
 *
 * NO SESSION REVOCATION, deliberately. The session remains a valid IDENTITY; the
 * user loses this workspace only. `requireWorkspace()` re-checks membership on
 * every request, so access ends on the next navigation with no revocation
 * machinery and no cache to invalidate. That is the payoff for never
 * denormalising role or membership into the session row.
 */
export async function removeMember(
  ctx: Ctx,
  userId: string,
): Promise<Result<{ userId: string }, RemoveMemberFailure>> {
  requireCan(ctx, 'members.remove')

  const target = await repo.findMembership(ctx, userId)
  if (!target) return err({ kind: 'not_a_member' })

  // Removing an OWNER is a role change in disguise; the same guard applies.
  if (target.role === 'OWNER' && ctx.role !== 'OWNER') {
    assertRoleChangeAllowed(ctx, target, 'MEMBER')
  }

  const result = await repo.removeMember(ctx, userId)
  if (!result.ok) return err({ kind: result.reason })

  await repo.insertAuditLog(ctx, {
    action: 'member.removed',
    targetType: 'WorkspaceMember',
    targetId: userId,
    metadata: { role: target.role },
  })
  logger.info('workspace.member_removed', {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    targetUserId: userId,
  })

  return ok({ userId })
}

export async function suspendMember(
  ctx: Ctx,
  userId: string,
): Promise<Result<{ userId: string }, RemoveMemberFailure>> {
  requireCan(ctx, 'members.remove')

  const target = await repo.findMembership(ctx, userId)
  if (!target) return err({ kind: 'not_a_member' })

  // A suspended OWNER is no longer an ACTIVE owner, so this can violate the
  // last-OWNER invariant exactly as a demotion can.
  if (target.role === 'OWNER') {
    const demoted = await repo.changeMemberRole(ctx, userId, 'ADMIN')
    if (!demoted.ok) return err({ kind: demoted.reason })
  }

  const count = await repo.setMemberStatus(ctx, userId, 'SUSPENDED')
  if (count !== 1) return err({ kind: 'not_a_member' })

  await repo.insertAuditLog(ctx, {
    action: 'member.suspended',
    targetType: 'WorkspaceMember',
    targetId: userId,
  })
  return ok({ userId })
}

/**
 * Transfers ownership. OWNER only, and the repo promotes the target BEFORE
 * demoting the caller so the last-OWNER invariant holds at every intermediate
 * state.
 */
export async function transferOwnership(
  ctx: Ctx,
  toUserId: string,
): Promise<Result<{ userId: string }, RoleChangeFailure>> {
  requireCan(ctx, 'workspace.transfer_ownership')

  const result = await repo.transferOwnership(ctx, toUserId)
  if (!result.ok) return err({ kind: 'not_a_member' })

  await repo.insertAuditLog(ctx, {
    action: 'workspace.ownership_transferred',
    targetType: 'WorkspaceMember',
    targetId: toUserId,
  })
  logger.warn('workspace.ownership_transferred', {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    targetUserId: toUserId,
  })

  return ok({ userId: toUserId })
}

// ─────────────────────────────────────────────────────────── audit log

export async function listAuditLog(ctx: Ctx, params: ListAuditLogInput): Promise<AuditEntry[]> {
  requireCan(ctx, 'audit.view')
  return repo.listAuditLog(ctx, {
    limit: params.limit,
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    ...(params.action !== undefined ? { action: params.action } : {}),
  })
}

/**
 * Writes one audit row for callers doing their own work alongside it.
 *
 * `metadata` is `Prisma.InputJsonValue` rather than `Record<string, unknown>`: the
 * column is `Json`, and `unknown` values would accept a `Date`, a `BigInt`, or a
 * class instance that fails to serialise at the driver rather than at the call
 * site. Redacted, structured detail only — never secrets, tokens, or email bodies.
 */
export async function writeAudit(
  ctx: Ctx,
  entry: {
    action: string
    targetType?: string
    targetId?: string
    metadata?: Prisma.InputJsonValue
  },
): Promise<void> {
  await repo.insertAuditLog(ctx, {
    action: entry.action,
    ...(entry.targetType !== undefined ? { targetType: entry.targetType } : {}),
    ...(entry.targetId !== undefined ? { targetId: entry.targetId } : {}),
    ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
  })
}

// ─────────────────────────────────────────────── maintenance (no Ctx)

/**
 * Cross-tenant maintenance. Reachable only from `worker/maintenance.ts`, and named
 * with the `AcrossWorkspaces` suffix so an unreviewed addition is greppable.
 */
export async function expireInvitesAcrossWorkspaces(): Promise<number> {
  const count = await repo.expireInvitesAcrossWorkspaces()
  if (count > 0) logger.info('workspace.invites_expired', { count })
  return count
}
