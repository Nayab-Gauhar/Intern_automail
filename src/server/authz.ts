import 'server-only'
import type { Role } from '@prisma/client'
import { ForbiddenError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import type { Ctx } from './ctx'

/**
 * The permission matrix, transcribed from docs/architecture/07-auth-and-security.md §9.4.
 *
 * Scattering `if (ctx.role === 'ADMIN')` across dozens of service functions is
 * how a permission silently drifts. One table instead, checked at the top of
 * every mutating service function.
 *
 * Deny-by-default is a type guarantee: MATRIX is Record<Capability, ...>, so
 * adding a Capability without giving it a row fails to compile. There is no
 * fallthrough that grants access.
 */

export type Capability =
  // leads
  | 'leads.view'
  | 'leads.create'
  | 'leads.edit'
  | 'leads.delete'
  | 'leads.bulk_delete'
  | 'leads.import'
  | 'leads.export'
  // campaigns & sequences
  | 'campaigns.view'
  | 'campaigns.create'
  | 'campaigns.edit'
  | 'campaigns.delete'
  | 'campaigns.launch'
  | 'campaigns.pause'
  | 'sequences.edit'
  // mailboxes & deliverability
  | 'mailboxes.view'
  | 'mailboxes.connect'
  | 'mailboxes.edit'
  | 'mailboxes.disconnect'
  | 'mailboxes.limits_edit'
  | 'warmup.manage'
  | 'domains.manage'
  // inbox
  | 'inbox.view'
  | 'inbox.reply'
  | 'inbox.archive'
  | 'suppressions.manage'
  // crm
  | 'crm.view'
  | 'crm.edit'
  | 'crm.delete'
  // analytics & ai
  | 'analytics.view'
  | 'ai.use'
  | 'ai.configure'
  // workspace administration
  | 'members.view'
  | 'members.invite'
  | 'members.remove'
  | 'members.change_role'
  | 'workspace.edit'
  | 'workspace.delete'
  | 'workspace.transfer_ownership'
  | 'billing.view'
  | 'billing.manage'
  | 'audit.view'
  | 'apikeys.manage'
  | 'jobs.view'
  | 'jobs.replay'

const ALL = ['OWNER', 'ADMIN', 'MEMBER'] as const satisfies readonly Role[]
const STAFF = ['OWNER', 'ADMIN'] as const satisfies readonly Role[]
const OWNER_ONLY = ['OWNER'] as const satisfies readonly Role[]

export const MATRIX: Readonly<Record<Capability, readonly Role[]>> = {
  // Leads. Everyone works the list; only staff may take the whole list out of
  // the product or destroy it in bulk — see the export/bulk_delete note below.
  'leads.view': ALL,
  'leads.create': ALL,
  'leads.edit': ALL,
  'leads.delete': ALL,
  'leads.bulk_delete': STAFF,
  'leads.import': ALL,
  'leads.export': STAFF,

  // Campaigns. MEMBER may launch — see docs/architecture/DECISIONS.md D1. The
  // controls that actually bound outbound volume and domain reputation are
  // separate ADMIN+ capabilities (mailboxes.connect, mailboxes.limits_edit,
  // domains.manage, warmup.manage), so a MEMBER can only start sending within
  // limits they cannot change. Withholding launch from the person doing the
  // outreach produces shared ADMIN credentials, which is worse.
  'campaigns.view': ALL,
  'campaigns.create': ALL,
  'campaigns.edit': ALL,
  'campaigns.delete': STAFF,
  'campaigns.launch': ALL,
  'campaigns.pause': ALL, // stopping sends is always allowed — safety over hierarchy
  'sequences.edit': ALL,

  // Mailboxes. Connecting grants us an OAuth scope over someone's real email.
  'mailboxes.view': ALL,
  'mailboxes.connect': STAFF,
  'mailboxes.edit': STAFF,
  'mailboxes.disconnect': STAFF,
  'mailboxes.limits_edit': STAFF,
  'warmup.manage': STAFF,
  'domains.manage': STAFF,

  // Inbox: the day-to-day surface, open to all members.
  'inbox.view': ALL,
  'inbox.reply': ALL,
  'inbox.archive': ALL,
  'suppressions.manage': ALL, // suppressing is protective; never gate it

  'crm.view': ALL,
  'crm.edit': ALL,
  'crm.delete': STAFF,

  'analytics.view': ALL,
  'ai.use': ALL,
  'ai.configure': STAFF, // sets spend

  // Members. Role changes carry extra guards the matrix cannot express; see
  // assertRoleChangeAllowed below.
  'members.view': ALL,
  'members.invite': STAFF,
  'members.remove': STAFF,
  'members.change_role': STAFF,

  'workspace.edit': STAFF,
  'workspace.delete': OWNER_ONLY,
  'workspace.transfer_ownership': OWNER_ONLY,
  'billing.view': STAFF,
  'billing.manage': OWNER_ONLY,

  'audit.view': STAFF,
  'apikeys.manage': OWNER_ONLY,
  'jobs.view': STAFF,
  'jobs.replay': STAFF,
}

/** Non-throwing check. Use in the UI to hide what a user cannot do. */
export function can(ctx: Ctx, cap: Capability): boolean {
  return MATRIX[cap].includes(ctx.role)
}

/**
 * Throwing check. Called at the TOP of every mutating service function — the UI
 * hiding a control is a courtesy, this is the enforcement.
 */
export function requireCan(ctx: Ctx, cap: Capability): void {
  if (!can(ctx, cap)) {
    logger.warn('authz.denied', {
      required: cap,
      actual: ctx.role,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    })
    throw new ForbiddenError(cap)
  }
}

/**
 * The three role-change rules the matrix cannot express. Call after
 * requireCan(ctx, 'members.change_role'); the last-OWNER invariant is enforced
 * separately inside the transaction that performs the change.
 */
export function assertRoleChangeAllowed(ctx: Ctx, target: { role: Role }, nextRole: Role): void {
  // Nobody may grant a role above their own, or an ADMIN self-escalates by
  // promoting a puppet account to OWNER.
  if (nextRole === 'OWNER' && ctx.role !== 'OWNER') {
    logger.warn('authz.denied', {
      required: 'members.change_role',
      reason: 'grant_above_own_role',
      actual: ctx.role,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    })
    throw new ForbiddenError('members.change_role')
  }

  // Nobody may change an OWNER's role unless they are themselves an OWNER.
  if (target.role === 'OWNER' && ctx.role !== 'OWNER') {
    logger.warn('authz.denied', {
      required: 'members.change_role',
      reason: 'demote_owner',
      actual: ctx.role,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    })
    throw new ForbiddenError('members.change_role')
  }
}

/** Every capability a role holds. Sent to the client to drive UI affordances. */
export function capabilitiesFor(role: Role): Capability[] {
  return (Object.keys(MATRIX) as Capability[]).filter((c) => MATRIX[c].includes(role))
}
