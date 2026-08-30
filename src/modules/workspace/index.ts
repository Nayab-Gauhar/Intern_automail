/**
 * The workspace module's PUBLIC API. Re-exports only.
 *
 * `./repo` is not re-exported: a caller needing a query goes through `service`, so
 * no page or action can write an unscoped read.
 */

export {
  acceptInvite,
  changeRole,
  describeInvite,
  expireInvitesAcrossWorkspaces,
  get,
  invite,
  listAuditLog,
  listForUser,
  listMembers,
  listPendingInvites,
  removeMember,
  revokeInvite,
  softDelete,
  suspendMember,
  switchWorkspace,
  transferOwnership,
  updateSettings,
  writeAudit,
} from './service'

export {
  acceptInviteSchema,
  assignableRoleSchema,
  changeRoleSchema,
  createWorkspaceSchema,
  inviteMemberSchema,
  inviteTokenSchema,
  listAuditLogSchema,
  memberActionSchema,
  revokeInviteSchema,
  roleSchema,
  switchWorkspaceSchema,
  updateWorkspaceSettingsSchema,
  workspaceNameSchema,
} from './schema'

export type {
  AcceptInviteInput,
  ChangeRoleInput,
  CreateWorkspaceInput,
  InviteMemberInput,
  ListAuditLogInput,
  MemberActionInput,
  RevokeInviteInput,
  SwitchWorkspaceInput,
  UpdateWorkspaceSettingsInput,
} from './schema'

export type {
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
