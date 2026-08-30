/**
 * The auth module's PUBLIC API. Re-exports only — no logic, no Prisma, no
 * `server-only` marker of its own.
 *
 * `./repo` is deliberately NOT re-exported. If a caller needs a query, `service`
 * exposes it; that is what stops `app/` from writing an unscoped read and what
 * makes the persistence layer swappable per module.
 */

export {
  ARGON2,
  changePassword,
  hashPassword,
  listSessions,
  login,
  me,
  needsRehash,
  register,
  requestPasswordReset,
  resetPassword,
  updateProfile,
  verifyPassword,
} from './service'

export {
  changePasswordSchema,
  emailSchema,
  idSchema,
  loginSchema,
  nameSchema,
  passwordSchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  revokeSessionSchema,
  timezoneSchema,
  updateProfileSchema,
} from './schema'

export type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  RevokeSessionInput,
  UpdateProfileInput,
} from './schema'

export type {
  ActiveMembership,
  AuthUser,
  ChangePasswordFailure,
  CredentialFailure,
  ProfileFailure,
  RegisteredIdentity,
  RegisterFailure,
  ResetFailure,
  SessionMeta,
  SessionRecord,
  SessionSummary,
} from './types'
