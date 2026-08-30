import { z } from 'zod'

/**
 * zod schemas for every untrusted byte entering the auth module.
 *
 * Three conventions that are load-bearing rather than stylistic:
 *
 *  1. `z.strictObject` everywhere. Unknown keys are a REJECTION, not silently
 *     stripped. This is what turns brief §4 rule 2 into a mechanism: a payload
 *     carrying `workspaceId` fails validation loudly instead of having the field
 *     quietly dropped, so a smuggling attempt is visible in the logs.
 *  2. Email is trimmed and lowercased BEFORE the format check, then the
 *     normalised form is what the schema returns — so `User.email` is written
 *     canonically at every entrypoint and a lookup by email cannot miss on case.
 *     Note the ordering: `z.email().trim().toLowerCase()` validates the RAW
 *     string and rejects " Foo@Bar.com " (verified), so the transform has to come
 *     first and pipe into the format check.
 *  3. Ids are cuids, never uuids — see docs/architecture/DECISIONS.md D5.
 *     `z.uuid()` rejects every id we mint.
 */

/**
 * The canonical email input. Trim-then-lowercase-then-validate, in that order.
 *
 * `.max(254)` is the RFC 5321 ceiling on a forward path; without it the argon2
 * context checks and the database index both take an unbounded string.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'That email address is too long')
  .pipe(z.email('Enter a valid email address'))

/** A cuid id, as every model in the schema mints. */
export const idSchema = z.cuid('Not a valid id')

/**
 * Password strength: entropy, not composition (07 §4.2).
 *
 * No uppercase/digit/symbol rules — they push users to `Password1!`, which is
 * twelve characters of nothing, and NIST SP 800-63B has recommended against them
 * for years. Length is the highest-signal predictor we can cheaply enforce.
 *
 * The 200-character ceiling is checked here, before hashing, so argon2 is never
 * handed a 10 MB string. argon2's cost is length-independent, but the allocation
 * is not.
 *
 * The breach-list check (`isCommonPassword`) and the contextual rejects that need
 * the email are composed on top in `registerSchema`/`resetPasswordSchema` rather
 * than baked in here, because a bare `passwordSchema` has no email to compare to.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200, 'Passwords longer than 200 characters are not accepted')
  .refine((p) => p.trim().length > 0, 'Cannot be only whitespace')

/**
 * The login password field is deliberately NOT `passwordSchema`.
 *
 * A login attempt must not tell an attacker that the stored password is at least
 * twelve characters, and a user whose password predates a policy change must
 * still be able to sign in. Only the bounds that protect us are applied.
 */
const loginPasswordSchema = z
  .string()
  .min(1, 'Enter your password')
  .max(200, 'Passwords longer than 200 characters are not accepted')

/** A person's display name. Trimmed, because " " is not a name. */
export const nameSchema = z
  .string()
  .trim()
  .min(1, 'Enter your name')
  .max(120, 'Names longer than 120 characters are not accepted')

/**
 * An IANA zone NAME, canonicalised — `Europe/Berlin`, never `+02:00`.
 *
 * Two steps, and the second is the one that matters. `Intl.DateTimeFormat` alone is
 * not a sufficient check: it happily accepts `+02:00`, `-0500`, `+02`, and `GMT`
 * (verified), so a refine that only catches its throw would let a FIXED OFFSET into
 * `User.timezone`. An offset is wrong twice a year — the brief stores a zone string
 * precisely so daily caps and sending windows survive a DST transition, and a
 * spring-forward day is 23 hours of wall clock but still one calendar date.
 *
 * So: resolve through `Intl` to reject nonsense and to canonicalise case
 * (`europe/berlin` becomes `Europe/Berlin`), then require the result to be a real
 * zone name from the runtime's own tz database. The transform means downstream code
 * and the database see one spelling per zone.
 */
export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((tz, ctx) => {
    let resolved: string
    try {
      resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Not a recognised IANA timezone' })
      return z.NEVER
    }

    if (!Intl.supportedValuesOf('timeZone').includes(resolved)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Use a zone name such as Europe/Berlin, not a fixed UTC offset',
      })
      return z.NEVER
    }

    return resolved
  })

/**
 * The local part of an email, lowercased — the first thing an attacker guesses.
 * Returns null below three characters, where the substring check produces noise
 * rather than signal ("al@x.com" would reject every password containing "al").
 */
function contextTokenFor(email: string): string | null {
  const local = email.split('@')[0]?.toLowerCase() ?? ''
  return local.length >= 3 ? local : null
}

/** Adds the context-specific rejects that need a sibling field to compare against. */
function rejectContextualPasswords(
  { email, password }: { email: string; password: string },
  ctx: z.RefinementCtx,
): void {
  const lower = password.toLowerCase()
  const local = contextTokenFor(email)

  if (local && lower.includes(local)) {
    ctx.addIssue({
      code: 'custom',
      path: ['password'],
      message: 'Do not include your email address',
    })
  }

  if (lower.includes('instantmail') || lower.includes('instant mail')) {
    ctx.addIssue({
      code: 'custom',
      path: ['password'],
      message: 'Do not include the product name',
    })
  }
}

export const registerSchema = z
  .strictObject({
    email: emailSchema,
    password: passwordSchema,
    name: nameSchema,
    /** Optional workspace name; defaults to "<name>'s workspace" in the service. */
    workspaceName: z.string().trim().min(1).max(120).optional(),
  })
  .superRefine(rejectContextualPasswords)

export const loginSchema = z.strictObject({
  email: emailSchema,
  password: loginPasswordSchema,
})

export const requestPasswordResetSchema = z.strictObject({
  email: emailSchema,
})

export const resetPasswordSchema = z
  .strictObject({
    /** The plaintext token from the emailed URL. base64url, 43 chars for 256 bits. */
    token: z
      .string()
      .min(20, 'This link is invalid or has expired')
      .max(200)
      .regex(/^[\w-]+$/, 'This link is invalid or has expired'),
    email: emailSchema,
    password: passwordSchema,
  })
  .superRefine(rejectContextualPasswords)

export const changePasswordSchema = z
  .strictObject({
    currentPassword: loginPasswordSchema,
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'Choose a password you have not used here before',
  })

export const updateProfileSchema = z.strictObject({
  name: nameSchema.optional(),
  timezone: timezoneSchema.optional(),
})

export const revokeSessionSchema = z.strictObject({
  sessionId: idSchema,
})

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
export type RevokeSessionInput = z.infer<typeof revokeSessionSchema>
