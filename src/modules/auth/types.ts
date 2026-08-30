import type { Role } from '@prisma/client'

/**
 * Domain types for identity. No Prisma row type crosses this boundary — in
 * particular nothing here carries `passwordHash` or `tokenHash`, so a server
 * component physically cannot hand a credential to a client component.
 */

/** Everything a guard needs from a validated session. Never carries the token. */
export type SessionRecord = {
  id: string
  userId: string
  activeWorkspaceId: string | null
  expiresAt: Date
  absoluteExpiresAt: Date
}

/** The signed-in user, as any surface may render them. */
export type AuthUser = {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  emailVerifiedAt: Date | null
  timezone: string
  createdAt: Date
}

/** One row in /settings/security. `ipMasked`, never the full address (07 §5.7). */
export type SessionSummary = {
  id: string
  createdAt: Date
  lastActiveAt: Date
  isCurrent: boolean
  /** Coarse UA parse, e.g. "Chrome on macOS". Not a fingerprint. */
  device: string
  /** "203.0.113.x" / "2001:db8::" — a full IP history is a stalking aid. */
  ipMasked: string
}

/** What register() produces. The caller sets the cookie; the token never escapes. */
export type RegisteredIdentity = {
  userId: string
  workspaceId: string
  workspaceSlug: string
}

/** Where a session may be pointed on creation, plus the forensic metadata. */
export type SessionMeta = {
  ipAddress?: string
  userAgent?: string
  activeWorkspaceId?: string | null
}

/**
 * One error variant for both "no such account" and "wrong password". Splitting
 * them is the user-enumeration leak (07 §5.2), so the type makes it impossible
 * to render them differently.
 */
export type CredentialFailure = { kind: 'invalid_credentials' }

export type RegisterFailure = { kind: 'email_taken' }

export type ResetFailure = { kind: 'invalid_or_expired_token' }

export type ChangePasswordFailure = { kind: 'invalid_credentials' } | { kind: 'same_password' }

export type ProfileFailure = { kind: 'invalid_timezone' }

/** The membership fields authorization actually reads. Role lives here, never on User. */
export type ActiveMembership = {
  workspaceId: string
  role: Role
  /** The workspace's timezone, joined in because every Ctx needs it. */
  timezone: string
}
