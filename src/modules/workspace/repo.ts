import 'server-only'
import { Prisma } from '@prisma/client'
import type { InviteStatus, Role } from '@prisma/client'
import { db } from '@/lib/db'
import type { Ctx } from '@/server/ctx'
import type {
  AuditEntry,
  InviteDescription,
  Member,
  PendingInvite,
  Workspace,
  WorkspaceSummary,
} from './types'
import type { ActiveMembership } from '@/modules/auth/types'

/**
 * Persistence for the tenant root: Workspace, WorkspaceMember, WorkspaceInvite,
 * AuditLog.
 *
 * TENANCY. Every function that reads or writes tenant data names its scope from
 * `ctx.workspaceId` in the `where` clause of the statement that actually runs —
 * not in a wrapper, not in a Prisma extension. `findUnique` is never used on a
 * tenant-owned model: it accepts only unique fields, so `id` alone cannot be
 * scoped, and it would return another tenant's row for a caller-supplied id.
 * Single-row writes go through `updateMany`/`deleteMany` with the compound where
 * for the same reason, and the caller asserts the count.
 *
 * The three functions that take a `userId` instead of a `Ctx` —
 * `findActiveMembership`, `findFirstActiveMembership`, `listWorkspacesForUser` —
 * are the authorization ROOT. They cannot take a `Ctx` because they are what
 * produces one. Each is scoped by `userId`, which is the equivalent boundary at
 * that layer.
 */

// ─────────────────────────────────────────── the authorization root

/**
 * The whole authorization root, so its predicates are written out rather than
 * expressed through the query builder.
 *
 * `status = 'ACTIVE'` means a SUSPENDED member gets nothing, and
 * `w."deletedAt" IS NULL` means a soft-deleted workspace is inaccessible without a
 * sweeper having run.
 */
export async function findActiveMembership(
  userId: string,
  workspaceId: string,
): Promise<ActiveMembership | null> {
  const rows = await db.$queryRaw<ActiveMembership[]>`
    SELECT m."workspaceId", m.role, w.timezone
      FROM "WorkspaceMember" m
      JOIN "Workspace" w ON w.id = m."workspaceId"
     WHERE m."userId"      = ${userId}
       AND m."workspaceId" = ${workspaceId}
       AND m.status        = 'ACTIVE'::"MemberStatus"
       AND w."deletedAt"   IS NULL
     LIMIT 1`
  return rows[0] ?? null
}

/** Same query keyed by slug, for the switcher. A miss is a 404 in the service. */
export async function findActiveMembershipBySlug(
  userId: string,
  slug: string,
): Promise<ActiveMembership | null> {
  const rows = await db.$queryRaw<ActiveMembership[]>`
    SELECT m."workspaceId", m.role, w.timezone
      FROM "WorkspaceMember" m
      JOIN "Workspace" w ON w.id = m."workspaceId"
     WHERE m."userId"    = ${userId}
       AND w.slug        = ${slug}
       AND m.status      = 'ACTIVE'::"MemberStatus"
       AND w."deletedAt" IS NULL
     LIMIT 1`
  return rows[0] ?? null
}

export async function findFirstActiveMembership(userId: string): Promise<ActiveMembership | null> {
  const rows = await db.$queryRaw<ActiveMembership[]>`
    SELECT m."workspaceId", m.role, w.timezone
      FROM "WorkspaceMember" m
      JOIN "Workspace" w ON w.id = m."workspaceId"
     WHERE m."userId"    = ${userId}
       AND m.status      = 'ACTIVE'::"MemberStatus"
       AND w."deletedAt" IS NULL
     ORDER BY m."createdAt" ASC
     LIMIT 1`
  return rows[0] ?? null
}

/** The switcher's list: only ACTIVE memberships of live workspaces. */
export async function listWorkspacesForUser(userId: string): Promise<WorkspaceSummary[]> {
  const rows = await db.workspaceMember.findMany({
    where: { userId, status: 'ACTIVE', workspace: { deletedAt: null } },
    select: {
      role: true,
      workspace: { select: { id: true, name: true, slug: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  return rows.map((row) => ({
    id: row.workspace.id,
    name: row.workspace.name,
    slug: row.workspace.slug,
    role: row.role,
  }))
}

// ─────────────────────────────────────────────────────────── workspace

/** `findFirst` with the id from `Ctx`, never `findUnique` — see the header note. */
export async function findWorkspace(ctx: Ctx): Promise<Workspace | null> {
  return db.workspace.findFirst({
    where: { id: ctx.workspaceId, deletedAt: null },
    select: {
      id: true,
      name: true,
      slug: true,
      timezone: true,
      dailySendLimit: true,
      trackOpensDefault: true,
      trackClicksDefault: true,
      unsubscribeFooterHtml: true,
      createdAt: true,
    },
  })
}

export async function updateWorkspace(
  ctx: Ctx,
  data: Prisma.WorkspaceUpdateManyMutationInput,
): Promise<number> {
  const res = await db.workspace.updateMany({
    where: { id: ctx.workspaceId, deletedAt: null },
    data,
  })
  return res.count
}

/**
 * Soft delete. A hard delete would cascade across every table in the schema, so
 * deletion is two-phase: mark here, and a MAINTENANCE job purges later.
 *
 * `Session.activeWorkspaceId` is `onDelete: SetNull`, and every session pointing
 * here falls through to `requireWorkspace()`'s fallback on the next request. No
 * sweeper needed for the pointers.
 */
export async function softDeleteWorkspace(ctx: Ctx): Promise<number> {
  const res = await db.workspace.updateMany({
    where: { id: ctx.workspaceId, deletedAt: null },
    data: { deletedAt: new Date() },
  })
  return res.count
}

// ───────────────────────────────────────────────────────────── members

export async function listMembers(ctx: Ctx): Promise<Member[]> {
  const rows = await db.workspaceMember.findMany({
    where: { workspaceId: ctx.workspaceId, user: { deletedAt: null } },
    select: {
      role: true,
      status: true,
      createdAt: true,
      user: {
        select: { id: true, email: true, name: true, avatarUrl: true, lastLoginAt: true },
      },
    },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  })

  return rows.map((row) => ({
    userId: row.user.id,
    email: row.user.email,
    name: row.user.name,
    avatarUrl: row.user.avatarUrl,
    role: row.role,
    status: row.status,
    joinedAt: row.createdAt,
    lastLoginAt: row.user.lastLoginAt,
  }))
}

/** The target of a role change or removal, scoped to the caller's workspace. */
export async function findMembership(
  ctx: Ctx,
  userId: string,
): Promise<{ role: Role; status: string } | null> {
  return db.workspaceMember.findFirst({
    where: { workspaceId: ctx.workspaceId, userId },
    select: { role: true, status: true },
  })
}

/**
 * Changes a member's role, with the last-OWNER invariant enforced INSIDE the same
 * transaction as the write.
 *
 * Returns null when the invariant would be violated, so the service can map it to
 * a typed failure without needing to know about row locks.
 */
export async function changeMemberRole(
  ctx: Ctx,
  userId: string,
  nextRole: Role,
): Promise<{ ok: true } | { ok: false; reason: 'last_owner' | 'not_a_member' }> {
  return db.$transaction(async (tx) => {
    const guard = await assertNotLastOwner(tx, ctx.workspaceId, userId, nextRole !== 'OWNER')
    if (!guard.ok) return guard

    const res = await tx.workspaceMember.updateMany({
      where: { workspaceId: ctx.workspaceId, userId },
      data: { role: nextRole },
    })
    return res.count === 1 ? { ok: true } : { ok: false, reason: 'not_a_member' }
  })
}

export async function removeMember(
  ctx: Ctx,
  userId: string,
): Promise<{ ok: true } | { ok: false; reason: 'last_owner' | 'not_a_member' }> {
  return db.$transaction(async (tx) => {
    const guard = await assertNotLastOwner(tx, ctx.workspaceId, userId, true)
    if (!guard.ok) return guard

    const res = await tx.workspaceMember.deleteMany({
      where: { workspaceId: ctx.workspaceId, userId },
    })
    return res.count === 1 ? { ok: true } : { ok: false, reason: 'not_a_member' }
  })
}

export async function setMemberStatus(
  ctx: Ctx,
  userId: string,
  status: 'ACTIVE' | 'SUSPENDED',
): Promise<number> {
  const res = await db.workspaceMember.updateMany({
    where: { workspaceId: ctx.workspaceId, userId },
    data: { status },
  })
  return res.count
}

/**
 * THE LAST-OWNER INVARIANT. Every workspace has at least one ACTIVE OWNER, always.
 *
 * Violated, the workspace becomes unadministrable — nobody can invite, change
 * roles, or delete it — and there is no self-service recovery.
 *
 * `FOR UPDATE` is load-bearing, not defensive habit. Two concurrent "demote the
 * other owner" requests both read `count = 2` and both proceed, leaving zero
 * owners. The row lock on the OWNER memberships serialises them so the second
 * request reads the first one's result.
 *
 * Called INSIDE the mutating transaction, never before it. Checked outside, it is a
 * TOCTOU bug that a test will not catch and production will.
 */
async function assertNotLastOwner(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  losingUserId: string,
  /** False when the operation leaves the target an OWNER, in which case there is nothing to guard. */
  targetLosesOwnership: boolean,
): Promise<{ ok: true } | { ok: false; reason: 'last_owner' }> {
  if (!targetLosesOwnership) return { ok: true }

  const owners = await tx.$queryRaw<{ userId: string }[]>`
    SELECT "userId" FROM "WorkspaceMember"
     WHERE "workspaceId" = ${workspaceId}
       AND role   = 'OWNER'::"Role"
       AND status = 'ACTIVE'::"MemberStatus"
     FOR UPDATE`

  if (owners.length <= 1 && owners.some((o) => o.userId === losingUserId)) {
    return { ok: false, reason: 'last_owner' }
  }
  return { ok: true }
}

/**
 * Ownership transfer: promote the target BEFORE demoting the caller, in one
 * transaction, so the last-OWNER invariant holds at every intermediate state.
 * Doing it the other way round leaves a window with zero owners.
 */
export async function transferOwnership(
  ctx: Ctx,
  toUserId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_a_member' }> {
  return db.$transaction(async (tx) => {
    const promoted = await tx.workspaceMember.updateMany({
      where: { workspaceId: ctx.workspaceId, userId: toUserId, status: 'ACTIVE' },
      data: { role: 'OWNER' },
    })
    if (promoted.count !== 1) return { ok: false, reason: 'not_a_member' }

    await tx.workspaceMember.updateMany({
      where: { workspaceId: ctx.workspaceId, userId: ctx.userId },
      data: { role: 'ADMIN' },
    })
    return { ok: true }
  })
}

// ───────────────────────────────────────────────────────────── invites

export async function findActiveMemberByEmail(
  ctx: Ctx,
  email: string,
): Promise<{ userId: string } | null> {
  const row = await db.workspaceMember.findFirst({
    where: { workspaceId: ctx.workspaceId, status: 'ACTIVE', user: { email } },
    select: { userId: true },
  })
  return row
}

/**
 * Revokes any live invite for this address, then creates a fresh one — in one
 * transaction.
 *
 * The revoke-then-create is mandatory rather than tidy: a PARTIAL unique index
 * (`WHERE status = 'PENDING'`) in the migration SQL permits at most one live invite
 * per email per workspace, so creating without revoking raises a unique violation.
 */
export async function replacePendingInvite(input: {
  ctx: Ctx
  email: string
  role: Role
  tokenHash: string
  expiresAt: Date
  invitedById: string
}): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    await tx.workspaceInvite.updateMany({
      where: { workspaceId: input.ctx.workspaceId, email: input.email, status: 'PENDING' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    })

    return tx.workspaceInvite.create({
      data: {
        workspaceId: input.ctx.workspaceId,
        email: input.email,
        role: input.role,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        invitedById: input.invitedById,
        status: 'PENDING',
      },
      select: { id: true },
    })
  })
}

export async function listPendingInvites(ctx: Ctx): Promise<PendingInvite[]> {
  const rows = await db.workspaceInvite.findMany({
    where: { workspaceId: ctx.workspaceId, status: 'PENDING' },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      invitedBy: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    invitedByName: row.invitedBy?.name ?? null,
  }))
}

export async function revokeInvite(ctx: Ctx, inviteId: string): Promise<number> {
  const res = await db.workspaceInvite.updateMany({
    where: { workspaceId: ctx.workspaceId, id: inviteId, status: 'PENDING' },
    data: { status: 'REVOKED', revokedAt: new Date() },
  })
  return res.count
}

/**
 * Describes an invite to an unauthenticated visitor.
 *
 * Takes no `Ctx` — by definition the caller has no session yet. This is not a
 * tenancy hole: the lookup is keyed by the SHA-256 of an unguessable 256-bit
 * token, and it returns only the invite's own contents.
 *
 * `expiresAt > now()` is checked regardless of `status`, because `InviteStatus`
 * `EXPIRED` is set by MAINTENANCE rather than by the read path — a not-yet-swept
 * row must not be acceptable late.
 */
export async function describeInviteByTokenHash(
  tokenHash: string,
): Promise<InviteDescription | null> {
  const rows = await db.$queryRaw<
    { workspaceName: string; role: Role; email: string; expiresAt: Date }[]
  >`
    SELECT w.name AS "workspaceName", i.role, i.email, i."expiresAt"
      FROM "WorkspaceInvite" i
      JOIN "Workspace" w ON w.id = i."workspaceId"
     WHERE i."tokenHash" = ${tokenHash}
       AND i.status      = 'PENDING'::"InviteStatus"
       AND i."revokedAt" IS NULL
       AND i."expiresAt" > now()
       AND w."deletedAt" IS NULL
     LIMIT 1`
  return rows[0] ?? null
}

/**
 * Accepts an invite: consume it atomically, then upsert the membership and point
 * the session at the new workspace — all in one transaction.
 *
 * The consume is a single conditional UPDATE, so two concurrent accepts of one
 * token cannot both win. `rowCount = 1` means we won; 0 means invalid, used,
 * revoked, or expired.
 *
 * This is the one place a `workspaceId` legitimately comes from outside the
 * session — and it comes from the server-side ROW, keyed by a hashed unguessable
 * token, never from a request parameter. That is what keeps it consistent with
 * brief §4 rule 2.
 */
export async function consumeInviteAndJoin(input: {
  tokenHash: string
  userId: string
  userEmail: string
  sessionId: string
}): Promise<
  | { ok: true; workspaceId: string; role: Role }
  | { ok: false; reason: 'invalid_or_expired' }
  | { ok: false; reason: 'email_mismatch'; invitedEmail: string }
> {
  return db.$transaction(async (tx) => {
    // Read the row for the email comparison, locked, so the consume below cannot
    // race another accept between the check and the update.
    const found = await tx.$queryRaw<{ workspaceId: string; role: Role; email: string }[]>`
      SELECT "workspaceId", role, email
        FROM "WorkspaceInvite"
       WHERE "tokenHash" = ${input.tokenHash}
         AND status      = 'PENDING'::"InviteStatus"
         AND "revokedAt" IS NULL
         AND "expiresAt" > now()
       FOR UPDATE`

    const invite = found[0]
    if (!invite) return { ok: false, reason: 'invalid_or_expired' as const }

    // The invite binds to an address, and the accepting user's must match.
    // Otherwise a forwarded invite grants access to whoever opens it. Compared
    // lowercased; both sides are normalised at their own boundary.
    if (invite.email.toLowerCase() !== input.userEmail.toLowerCase()) {
      return { ok: false, reason: 'email_mismatch' as const, invitedEmail: invite.email }
    }

    const consumed = await tx.workspaceInvite.updateMany({
      where: { tokenHash: input.tokenHash, status: 'PENDING' },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    })
    if (consumed.count !== 1) return { ok: false, reason: 'invalid_or_expired' as const }

    await tx.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId: input.userId } },
      create: {
        workspaceId: invite.workspaceId,
        userId: input.userId,
        role: invite.role,
        status: 'ACTIVE',
      },
      // A previously-suspended member accepting a fresh invite is reinstated at the
      // invited role, not silently left suspended.
      update: { role: invite.role, status: 'ACTIVE' },
    })

    // Accepting an invite proves control of that mailbox, which is what email
    // verification proves.
    await tx.user.updateMany({
      where: { id: input.userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    })

    await tx.session.updateMany({
      where: { id: input.sessionId, userId: input.userId },
      data: { activeWorkspaceId: invite.workspaceId },
    })

    return { ok: true as const, workspaceId: invite.workspaceId, role: invite.role }
  })
}

/** MAINTENANCE only: marks swept invites EXPIRED. Cross-tenant by design, so no `Ctx`. */
export async function expireInvitesAcrossWorkspaces(): Promise<number> {
  const res = await db.workspaceInvite.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED' satisfies InviteStatus },
  })
  return res.count
}

// ─────────────────────────────────────────────────────────── audit log

/**
 * Appends an audit row.
 *
 * Takes an optional transaction client so the row is written INSIDE the
 * transaction it describes: an audit entry for a change that then rolled back is
 * worse than no entry.
 */
export async function insertAuditLog(
  ctx: Ctx,
  entry: {
    action: string
    targetType?: string
    targetId?: string
    metadata?: Prisma.InputJsonValue
    ipAddress?: string
    userAgent?: string
  },
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? db
  await client.auditLog.create({
    data: {
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId === 'system' ? null : ctx.userId,
      action: entry.action,
      ...(entry.targetType != null ? { targetType: entry.targetType } : {}),
      ...(entry.targetId != null ? { targetId: entry.targetId } : {}),
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      ...(entry.ipAddress != null ? { ipAddress: entry.ipAddress } : {}),
      ...(entry.userAgent != null ? { userAgent: entry.userAgent } : {}),
    },
  })
}

/** Keyset pagination over the workspace's own audit rows. */
export async function listAuditLog(
  ctx: Ctx,
  params: { cursor?: string; limit: number; action?: string },
): Promise<AuditEntry[]> {
  const rows = await db.auditLog.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      ...(params.action != null ? { action: params.action } : {}),
      ...(params.cursor != null ? { id: { lt: BigInt(params.cursor) } } : {}),
    },
    select: {
      id: true,
      action: true,
      actorUserId: true,
      actorUser: { select: { name: true } },
      targetType: true,
      targetId: true,
      metadata: true,
      createdAt: true,
    },
    orderBy: { id: 'desc' },
    take: params.limit,
  })

  return rows.map((row) => ({
    // BigInt does not survive serialisation to a client component, so the id
    // crosses the boundary as a string.
    id: row.id.toString(),
    action: row.action,
    actorUserId: row.actorUserId,
    actorName: row.actorUser?.name ?? null,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  }))
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}
