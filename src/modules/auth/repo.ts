import 'server-only'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import type { ActiveMembership, SessionMeta, SessionRecord } from './types'

/**
 * Persistence for identity: User, Session, PasswordResetToken.
 *
 * None of these tables is tenant-owned, so — uniquely in the codebase — the
 * functions here take no `Ctx`. That is not an exemption from the tenancy rule;
 * it is the rule reading correctly. `User` is global (one person, one password, N
 * workspaces), `Session` is identity-scoped, and `PasswordResetToken` hangs off a
 * user. Every function that COULD be tenant-scoped is scoped by `userId` instead,
 * which is the equivalent boundary at this layer.
 *
 * Nothing here selects `Session.tokenHash` or `User.passwordHash` into a returned
 * shape unless a caller demonstrably needs it to verify a credential.
 */

/** The columns a login needs, and nothing else. */
export type LoginCandidate = {
  id: string
  email: string
  passwordHash: string | null
  lockedUntil: Date | null
  failedLoginCount: number
}

export type SessionRow = SessionRecord

// ───────────────────────────────────────────────────────────── users

/**
 * Login lookup. `deletedAt IS NULL` is part of the predicate rather than a
 * post-filter so a soft-deleted user cannot authenticate at all.
 */
export async function findLoginCandidateByEmail(email: string): Promise<LoginCandidate | null> {
  const rows = await db.$queryRaw<LoginCandidate[]>`
    SELECT id, email, "passwordHash", "lockedUntil", "failedLoginCount"
      FROM "User"
     WHERE email = ${email}
       AND "deletedAt" IS NULL
     LIMIT 1`
  return rows[0] ?? null
}

/**
 * The hash for an already-authenticated caller, by id.
 *
 * Separate from `findUserById` so the credential column is only ever selected by a
 * function whose name says it is doing credential work — a reviewer grepping for
 * `passwordHash` finds two call sites, not every profile read.
 */
export async function findPasswordHashById(userId: string): Promise<string | null> {
  const row = await db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { passwordHash: true },
  })
  return row?.passwordHash ?? null
}

export async function findUserById(userId: string) {
  return db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      email: true,
      name: true,
      avatarUrl: true,
      emailVerifiedAt: true,
      timezone: true,
      createdAt: true,
    },
  })
}

/**
 * Registration: User + Workspace + WorkspaceMember(OWNER) in ONE transaction.
 *
 * ARCHITECTURAL NOTE, deliberate and flagged rather than accidental. `Workspace`
 * and `WorkspaceMember` belong to the `workspace` module, and 02-backend §3.5
 * forbids reaching into another module's table from a repo. This is the one place
 * it happens, because the alternatives are worse:
 *
 *   · Two transactions leaves a User with no Workspace when the second fails, and
 *     07 §3.1 calls a workspace-less registration "a dead end".
 *   · Moving the transaction into `workspace/repo.ts` inverts the violation (that
 *     file would write `User`) and moves it away from the module whose public API
 *     the operation belongs to.
 *   · Having `auth` (L1) call `workspace` (L2) creates the cycle §2.4 exists to
 *     prevent.
 *
 * The write set is fixed, named, and unreachable from anywhere but `register()`.
 *
 * A unique violation aborts the whole Postgres transaction, so slug-collision
 * retries happen in the service by calling this again with a fresh candidate.
 */
export async function createUserWithOwnedWorkspace(input: {
  email: string
  passwordHash: string
  name: string
  timezone: string
  workspaceName: string
  workspaceSlug: string
}): Promise<{ userId: string; workspaceId: string; workspaceSlug: string }> {
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        name: input.name,
        timezone: input.timezone,
      },
      select: { id: true },
    })

    const workspace = await tx.workspace.create({
      data: {
        name: input.workspaceName,
        slug: input.workspaceSlug,
        timezone: input.timezone,
      },
      select: { id: true, slug: true },
    })

    // A workspace always has at least one OWNER (07 §9.5). This is where that
    // invariant is established; assertNotLastOwner is what preserves it.
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
    })

    return { userId: user.id, workspaceId: workspace.id, workspaceSlug: workspace.slug }
  })
}

export async function updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
  await db.user.updateMany({ where: { id: userId }, data: { passwordHash } })
}

/**
 * Records a failed attempt and locks the account once the threshold is crossed.
 * One statement, so two concurrent failures cannot both read the same count.
 */
export async function bumpFailedLogin(
  userId: string,
  threshold: number,
  lockUntil: Date,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "User"
       SET "failedLoginCount" = "failedLoginCount" + 1,
           "lockedUntil" = CASE
             WHEN "failedLoginCount" + 1 >= ${threshold} THEN ${lockUntil}::timestamptz
             ELSE "lockedUntil"
           END
     WHERE id = ${userId}`
}

/** Clears the lockout counters and stamps lastLoginAt. Called on success only. */
export async function markLoginSucceeded(userId: string): Promise<void> {
  await db.user.updateMany({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })
}

export async function updateProfile(
  userId: string,
  data: { name?: string; timezone?: string },
): Promise<void> {
  await db.user.updateMany({ where: { id: userId, deletedAt: null }, data })
}

/** Completing a reset proves control of the mailbox, which is what verification proves. */
export async function markEmailVerifiedIfUnset(userId: string): Promise<void> {
  await db.user.updateMany({
    where: { id: userId, emailVerifiedAt: null },
    data: { emailVerifiedAt: new Date() },
  })
}

// ───────────────────────────────────────────────────────────── sessions

/**
 * Inserts a session. Takes the HASH, never the token — the plaintext lives only
 * in the caller that mints it and sets the cookie.
 */
export async function insertSession(input: {
  tokenHash: string
  userId: string
  expiresAt: Date
  absoluteExpiresAt: Date
  meta: SessionMeta
}): Promise<SessionRecord> {
  const row = await db.session.create({
    data: {
      tokenHash: input.tokenHash,
      userId: input.userId,
      expiresAt: input.expiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
      ...(input.meta.activeWorkspaceId != null
        ? { activeWorkspaceId: input.meta.activeWorkspaceId }
        : {}),
      ...(input.meta.ipAddress != null ? { ipAddress: input.meta.ipAddress } : {}),
      ...(input.meta.userAgent != null ? { userAgent: input.meta.userAgent } : {}),
    },
    select: {
      id: true,
      userId: true,
      activeWorkspaceId: true,
      expiresAt: true,
      absoluteExpiresAt: true,
    },
  })
  return row
}

/**
 * The session validation query. Written as raw SQL because the ORDER of the
 * predicates is the design, not an implementation detail:
 *
 *   · `revokedAt` is checked BEFORE `expiresAt`. A revoked-but-unexpired session
 *     must be dead immediately — that is the entire reason sessions live
 *     server-side rather than in a signed cookie.
 *   · The `User` join is not decoration. It makes a soft-deleted user's live
 *     sessions inert with no sweeper job.
 *
 * `tokenHash` is `@unique`, so this is an index probe, not a scan. It leaks
 * nothing to time against: the hash is derived from the caller's own input, so
 * there is no stored secret in the comparison.
 */
export async function findLiveSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
  const rows = await db.$queryRaw<SessionRecord[]>`
    SELECT s.id, s."userId", s."activeWorkspaceId", s."expiresAt", s."absoluteExpiresAt"
      FROM "Session" s
      JOIN "User" u ON u.id = s."userId"
     WHERE s."tokenHash"         = ${tokenHash}
       AND s."revokedAt"         IS NULL
       AND s."expiresAt"         > now()
       AND s."absoluteExpiresAt" > now()
       AND u."deletedAt"         IS NULL
     LIMIT 1`
  return rows[0] ?? null
}

/** Extends the sliding window. Rate-limited to one write per session per 24h by the caller. */
export async function touchSession(sessionId: string, expiresAt: Date): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId },
    data: { expiresAt, lastActiveAt: new Date() },
  })
}

/**
 * Moves the active-workspace pointer.
 *
 * The pointer is not an authorization (07 §3): whether the user MAY see that
 * workspace is re-derived from `WorkspaceMember` on every request, so a stale
 * pointer grants nothing. Validating membership is the caller's job.
 */
export async function setActiveWorkspace(
  sessionId: string,
  workspaceId: string | null,
): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId },
    data: { activeWorkspaceId: workspaceId },
  })
}

/** `revokedAt`, never DELETE: the row stays forensically useful until MAINTENANCE prunes it. */
export async function revokeByTokenHash(tokenHash: string): Promise<void> {
  await db.session.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/** Scoped by userId so one user can never revoke another's session by guessing an id. */
export async function revokeSessionForUser(userId: string, sessionId: string): Promise<number> {
  const res = await db.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return res.count
}

export async function revokeAllSessionsForUser(
  userId: string,
  opts?: { exceptSessionId?: string },
): Promise<number> {
  const res = await db.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(opts?.exceptSessionId != null ? { id: { not: opts.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  })
  return res.count
}

/** The caller's own live sessions, newest first. `tokenHash` is never selected. */
export async function listLiveSessionsForUser(userId: string) {
  return db.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      id: true,
      createdAt: true,
      lastActiveAt: true,
      ipAddress: true,
      userAgent: true,
    },
    orderBy: { lastActiveAt: 'desc' },
    take: 100,
  })
}

// ─────────────────────────────────────────────── password reset tokens

export async function insertPasswordResetToken(input: {
  tokenHash: string
  userId: string
  expiresAt: Date
}): Promise<void> {
  await db.passwordResetToken.create({ data: input })
}

/** Burns every other live token for this user, so requesting a new link retires the old one. */
export async function invalidateLivePasswordResetTokens(userId: string): Promise<number> {
  const res = await db.passwordResetToken.updateMany({
    where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  })
  return res.count
}

/**
 * Atomically consumes the token. Returns the userId on success, null otherwise.
 *
 * ONE conditional UPDATE, never SELECT-then-UPDATE: the read-then-write shape
 * lets two concurrent requests bearing the same token both pass the check. Here
 * the database is the arbiter and the row count is the answer.
 */
export async function consumePasswordResetToken(tokenHash: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ userId: string }[]>`
    UPDATE "PasswordResetToken"
       SET "usedAt" = now()
     WHERE "tokenHash" = ${tokenHash}
       AND "usedAt"    IS NULL
       AND "expiresAt" > now()
    RETURNING "userId"`
  return rows[0]?.userId ?? null
}

/**
 * The password reset transaction. Everything in 07 §7's ACT step commits together
 * or not at all: a new hash with sessions left alive would be the worst of both.
 */
export async function applyPasswordReset(input: {
  userId: string
  passwordHash: string
}): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.user.updateMany({
      where: { id: input.userId },
      data: {
        passwordHash: input.passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    })

    // Completing a reset proves mailbox control, which is what verification proves.
    await tx.user.updateMany({
      where: { id: input.userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    })

    // ALL sessions, with no exception (07 §5.6): the person clicking reset may be
    // recovering from a compromise, so keeping any session alive defeats it.
    await tx.session.updateMany({
      where: { userId: input.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })

    await tx.passwordResetToken.updateMany({
      where: { userId: input.userId, usedAt: null },
      data: { usedAt: new Date() },
    })
  })
}

/**
 * Password CHANGE: new hash plus revoke-all-but-current, atomically. Returns how
 * many sessions were evicted so the UI can say "signed out of 3 other devices".
 */
export async function applyPasswordChange(input: {
  userId: string
  passwordHash: string
  exceptSessionId: string
}): Promise<number> {
  return db.$transaction(async (tx) => {
    await tx.user.updateMany({
      where: { id: input.userId },
      data: { passwordHash: input.passwordHash },
    })
    const revoked = await tx.session.updateMany({
      where: { userId: input.userId, revokedAt: null, id: { not: input.exceptSessionId } },
      data: { revokedAt: new Date() },
    })
    return revoked.count
  })
}

// ─────────────────────────────────────────────────────────── membership

/**
 * The authorization root, duplicated here so `requireWorkspace()` resolves a
 * session and its membership without `auth` importing `workspace` (L1 may not
 * depend on L2). `workspace/repo.ts` owns the canonical copy; this one exists so
 * the session-to-Ctx path is a single module hop.
 *
 * Not used by anything but the guard layer.
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

/**
 * The workspace this user was last looking at, if that membership is still live.
 *
 * Read from their most recent session rather than a column on `User`: the pointer
 * is already there, and a second copy would be a second thing to keep in sync.
 * Membership is re-verified by the caller — a stale pointer is not access.
 */
export async function findMostRecentActiveWorkspaceId(userId: string): Promise<string | null> {
  const row = await db.session.findFirst({
    where: { userId, activeWorkspaceId: { not: null } },
    select: { activeWorkspaceId: true },
    orderBy: { lastActiveAt: 'desc' },
  })
  return row?.activeWorkspaceId ?? null
}

/** The fallback when the session's pointer is stale: the oldest live membership. */
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

/** True when the slug is already taken. Used only to pick a candidate before insert. */
export function isUniqueViolationOn(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code !== 'P2002') return false
  const target = error.meta?.['target']
  const asText = Array.isArray(target) ? target.join(',') : String(target ?? '')
  return asText.toLowerCase().includes(field.toLowerCase())
}
