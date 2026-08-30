import type { InviteStatus, MemberStatus, Role } from '@prisma/client'

/**
 * Domain types for the tenant root: workspaces, members, invites.
 *
 * No Prisma row type crosses this boundary, and nothing here carries an invite's
 * `tokenHash` — a summary sent to a client component must not contain the value
 * that IS the capability.
 */

export type Workspace = {
  id: string
  name: string
  slug: string
  timezone: string
  dailySendLimit: number | null
  trackOpensDefault: boolean
  trackClicksDefault: boolean
  unsubscribeFooterHtml: string | null
  createdAt: Date
}

/** A workspace as it appears in the switcher. */
export type WorkspaceSummary = {
  id: string
  name: string
  slug: string
  role: Role
}

export type Member = {
  userId: string
  email: string
  name: string | null
  avatarUrl: string | null
  role: Role
  status: MemberStatus
  joinedAt: Date
  lastLoginAt: Date | null
}

/** A pending invite as staff see it. Carries no token. */
export type PendingInvite = {
  id: string
  email: string
  role: Role
  status: InviteStatus
  expiresAt: Date
  createdAt: Date
  invitedByName: string | null
}

/**
 * What `/accept-invite/[token]` may reveal to an unauthenticated visitor: the
 * invite's own contents and nothing else. No member list, no workspace id.
 */
export type InviteDescription = {
  workspaceName: string
  role: Role
  email: string
  expiresAt: Date
}

export type AuditEntry = {
  id: string
  action: string
  actorUserId: string | null
  actorName: string | null
  targetType: string | null
  targetId: string | null
  metadata: unknown
  createdAt: Date
}

export type InviteFailure = { kind: 'already_member' } | { kind: 'role_above_own' }

export type AcceptInviteFailure =
  | { kind: 'invalid_or_expired' }
  /** The invite binds to an address; a forwarded invite must not grant access. */
  | { kind: 'email_mismatch'; invitedEmail: string }

export type RoleChangeFailure = { kind: 'last_owner' } | { kind: 'not_a_member' }

export type RemoveMemberFailure = { kind: 'last_owner' } | { kind: 'not_a_member' }
