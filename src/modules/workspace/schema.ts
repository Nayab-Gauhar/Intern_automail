import { z } from 'zod'
import { emailSchema, idSchema, timezoneSchema } from '@/modules/auth/schema'

/**
 * zod schemas for workspace administration.
 *
 * NO SCHEMA IN THIS FILE ACCEPTS A `workspaceId` FIELD, and every object is
 * `z.strictObject`, so a payload carrying one is a loud validation failure rather
 * than a silently stripped key. That is brief §4 rule 2 as a mechanism instead of
 * a convention: tenancy comes from `Ctx`, which is derived server-side from the
 * session, and there is no input path that can override it.
 *
 * A grep for a `workspaceId:` field declaration anywhere under src/modules must
 * return nothing, and it does — the only hits are prose like this paragraph. The
 * workspace SWITCHER is the one input that names a
 * workspace, and it names it by `slug` rather than by id precisely so that grep
 * stays a mechanical check with no documented exception for a reader to weigh. A
 * slug is the handle already in the URL, it is globally unique, and a miss is a
 * 404 — so the switcher cannot be used to probe whether a given id is a tenant.
 */

/** OWNER is excluded where a schema must not be able to express a promotion to it. */
export const assignableRoleSchema = z.enum(['ADMIN', 'MEMBER'])

/** The full role set, for a change-role input an OWNER may legitimately use. */
export const roleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER'])

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a workspace name')
  .max(120, 'Workspace names longer than 120 characters are not accepted')

export const createWorkspaceSchema = z.strictObject({
  name: workspaceNameSchema,
  timezone: timezoneSchema.optional(),
})

export const updateWorkspaceSettingsSchema = z.strictObject({
  name: workspaceNameSchema.optional(),
  timezone: timezoneSchema.optional(),
  /**
   * Null clears the workspace ceiling, leaving only per-mailbox caps. Bounded at
   * 100k because an unbounded integer here is a foot-gun on the sending path, not
   * a feature.
   */
  dailySendLimit: z.number().int().min(0).max(100_000).nullable().optional(),
  trackOpensDefault: z.boolean().optional(),
  trackClicksDefault: z.boolean().optional(),
  unsubscribeFooterHtml: z.string().max(5_000).nullable().optional(),
})

/**
 * Inviting. `role` is `assignableRoleSchema`, so the SCHEMA cannot express an
 * OWNER invite at all — an ADMIN cannot mint an OWNER even by crafting a payload.
 * The service still re-checks against the inviter's own role, because a schema is a
 * boundary control and authorization belongs in the service.
 */
export const inviteMemberSchema = z.strictObject({
  email: emailSchema,
  role: assignableRoleSchema,
})

export const revokeInviteSchema = z.strictObject({
  inviteId: idSchema,
})

/** The plaintext invite token from the URL. base64url, so the charset is tight. */
export const inviteTokenSchema = z
  .string()
  .min(20, 'This invite link is invalid or has expired')
  .max(200)
  .regex(/^[\w-]+$/, 'This invite link is invalid or has expired')

export const acceptInviteSchema = z.strictObject({
  token: inviteTokenSchema,
})

export const changeRoleSchema = z.strictObject({
  userId: idSchema,
  role: roleSchema,
})

export const memberActionSchema = z.strictObject({
  userId: idSchema,
})

/**
 * The workspace switcher — a SELECTOR among the caller's own memberships, not a
 * scope. The slug is resolved against `WorkspaceMember` in the service and a miss
 * is a `NotFoundError`, so this reveals nothing about workspaces the caller is not
 * in. See the header note on why this is a slug rather than an id.
 */
export const switchWorkspaceSchema = z.strictObject({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'Not a valid workspace address'),
})

export const listAuditLogSchema = z.strictObject({
  /** Keyset cursor: the id of the last row on the previous page. */
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().max(80).optional(),
})

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>
export type UpdateWorkspaceSettingsInput = z.infer<typeof updateWorkspaceSettingsSchema>
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>
export type RevokeInviteInput = z.infer<typeof revokeInviteSchema>
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>
export type MemberActionInput = z.infer<typeof memberActionSchema>
export type SwitchWorkspaceInput = z.infer<typeof switchWorkspaceSchema>
export type ListAuditLogInput = z.infer<typeof listAuditLogSchema>
