import 'server-only'
import { ConflictError, NotFoundError, UnauthorizedError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { err, ok, type Result } from '@/lib/result'
import { hashToken, mintToken } from '@/lib/tokens'
import type { Ctx } from '@/server/ctx'
import * as repo from './repo'
import type {
  AuthUser,
  ChangePasswordFailure,
  CredentialFailure,
  RegisterFailure,
  RegisteredIdentity,
  ResetFailure,
  SessionRecord,
  SessionSummary,
} from './types'
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  UpdateProfileInput,
} from './schema'

/**
 * Identity business logic: registration, login, password lifecycle, sessions.
 *
 * TWO BOUNDARIES THIS FILE DELIBERATELY DOES NOT CROSS.
 *
 * 1. It never touches a cookie. Per 02-backend §3.1 rule 4 a service may not
 *    import `next/headers` or `next/navigation`, because a service that redirects
 *    or reads a cookie jar cannot be called from the worker or a test. So `login`
 *    and `register` return the resolved identity and the CALLER
 *    (`createSession()` in `@/server/session`, from an action or route handler)
 *    mints the token and sets the cookie. The plaintext token therefore exists in
 *    exactly one function in the codebase.
 *
 * 2. It writes no `AuditLog` row. `AuditLog` belongs to the `workspace` module
 *    (L2) and `auth` is L1, so importing it would create the cycle 02-backend §2.4
 *    exists to prevent. 07 §2 specifies `src/server/audit.ts` for exactly this,
 *    and that file is not in this slice — see the note returned to the lead.
 *    Every event below is emitted through the structured logger with its final
 *    audit vocabulary name, so wiring `writeAudit()` later is a mechanical change.
 */

// ═══════════════════════════════════════════════════════ password primitives
//
// 07 §2 places these in `src/lib/password.ts`, which is not part of this slice.
// They live here rather than in a file nobody owns, because a second agent
// creating `lib/password.ts` concurrently would collide on the most
// security-sensitive function in the product. Flagged for the lead; moving them
// is a cut-and-paste with no behaviour change.

/**
 * argon2id parameters. Bumping these is safe — `needsRehash` migrates the user
 * base on natural login traffic.
 *
 * Measured on this machine: `m=19456,t=2` (the OWASP floor) hashes in 32 ms, and
 * `m=65536,t=3` in 159 ms. The latter sits at OWASP's second recommended
 * configuration and lands in the 150-250 ms band that is imperceptible on a login
 * form while making offline cracking expensive.
 *
 * `parallelism` is deliberately absent: Bun ignores it and pins `p=1` regardless
 * (verified — the output PHC reads `m=65536,t=3,p=1`), so passing it would
 * document a defence that does not exist. Memory cost is the whole defence.
 */
export const ARGON2 = {
  algorithm: 'argon2id',
  memoryCost: 65_536, // KiB, so 64 MiB
  timeCost: 3,
} as const satisfies Parameters<typeof Bun.password.hash>[1]

const LOCK_THRESHOLD = 10
const LOCK_DURATION_MS = 15 * 60 * 1000
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000

/**
 * `Bun.password` exists only under the Bun runtime. 09-deployment §7.2 runs the
 * web service as `bun .next/standalone/server.js`, so the global is present. If a
 * future deploy ever runs the server under Node, hashing must fail loudly rather
 * than silently downgrading.
 *
 * Node 24 does expose `crypto.argon2`, so a fallback is possible. We do not write
 * one: an untested code path in the password verifier is worse than a loud failure.
 *
 * Asserted at the CALL SITE, not at module load. `next build` collects page data in
 * **Node** workers, so a module-load throw fails the build for every route that
 * transitively imports this file — which is every authenticated route. Importing
 * the module under Node is harmless; using it is not.
 */
function assertBunRuntime(): void {
  if (typeof Bun === 'undefined') {
    throw new Error('auth requires the Bun runtime: Bun.password is unavailable')
  }
}

/**
 * A counting semaphore around every argon2 call.
 *
 * 64 MiB per in-flight hash means 100 concurrent login attempts would be 6.4 GB of
 * transient allocation — a trivially cheap DoS. Four permits bounds peak argon2
 * memory at 256 MiB regardless of load. Queueing here is the correct behaviour: a
 * slow login under attack beats an OOM-killed process.
 */
class Semaphore {
  private available: number
  private readonly waiting: (() => void)[] = []

  constructor(permits: number) {
    this.available = permits
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available > 0) this.available -= 1
    else await new Promise<void>((resolve) => this.waiting.push(resolve))

    try {
      return await fn()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.available += 1
    }
  }
}

const argonGate = new Semaphore(4)

export async function hashPassword(plaintext: string): Promise<string> {
  assertBunRuntime()
  return argonGate.run(() => Bun.password.hash(plaintext, ARGON2))
}

export async function verifyPassword(plaintext: string, phc: string): Promise<boolean> {
  assertBunRuntime()
  return argonGate.run(async () => {
    try {
      return await Bun.password.verify(plaintext, phc)
    } catch {
      // A malformed or legacy hash means "wrong password", never a 500.
      return false
    }
  })
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/

/**
 * True when `phc` was written with weaker parameters than `ARGON2`, or is not
 * argon2id at all.
 *
 * `Bun.password.verify` reads the parameters out of the stored string, so a hash
 * written at `m=19456,t=2` still verifies after we raise the cost (verified). That
 * makes an upgrade a one-liner at the only moment we hold the plaintext.
 * `Bun.password.verify` also accepts bcrypt, so returning true for a `$2b$` hash
 * gives us a free import path if we ever absorb another system's users.
 */
export function needsRehash(phc: string): boolean {
  const m = PHC.exec(phc)
  if (!m) return true
  return Number(m[1]) < ARGON2.memoryCost || Number(m[2]) < ARGON2.timeCost
}

/**
 * A real argon2id hash of an unknowable 256-bit string, so `verify` against it
 * always returns false AFTER doing the same ~159 ms of work as a real verify.
 *
 * It MUST be a valid PHC string. `Bun.password.verify(pw, 'placeholder')` throws
 * in 0.21 ms (verified), which would make "no such user" roughly 750x faster than
 * "wrong password" and hand an attacker a perfect enumeration oracle.
 *
 * Started at module load but NOT awaited there: a top-level await would add 159 ms
 * to the boot of every process that imports this module, including the worker,
 * which never logs anyone in. The `catch` keeps a failure from surfacing as an
 * unhandled rejection; it resurfaces at the await site where it can be handled.
 */
let dummyHashPromise: Promise<string> | undefined

/**
 * Lazily created on first login rather than at module load. Computing it eagerly
 * called `Bun.password.hash` at import time, which broke `next build` under Node
 * exactly as the guard above did. Memoised, so the ~159 ms is paid once per
 * process and every later login reuses it.
 */
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(mintToken())
    // Keep a failure from surfacing as an unhandled rejection; it resurfaces at
    // the await site where it can be handled.
    dummyHashPromise.catch(() => undefined)
  }
  return dummyHashPromise
}

// ══════════════════════════════════════════════════════════════ registration

/** `slugify`, without a dependency. Collapses anything unsafe to a single dash. */
function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base.length > 0 ? base : 'workspace'
}

/** Crockford-ish base32, so a suffix contains no vowels to accidentally spell with. */
const SUFFIX_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/**
 * A random 4-character suffix, never a sequential one.
 *
 * `acme-2` tells an attacker that `acme` exists and is a tenant — a
 * tenant-enumeration oracle on a globally unique column. `acme-7k2p` says nothing.
 */
function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return Array.from(bytes, (b) => SUFFIX_ALPHABET[b % SUFFIX_ALPHABET.length] ?? '0').join('')
}

/**
 * Creates User + Workspace + WorkspaceMember(OWNER) in one transaction.
 *
 * The password is hashed BEFORE the uniqueness check, so a taken email and a free
 * one cost the same ~159 ms. Checking first and skipping the hash on a collision
 * would make registration a timing oracle for "is this address registered".
 *
 * Registration is enumerable in v1, deliberately, and this is the one place we
 * accept it: the non-leaking design ("we've sent you an email either way") needs a
 * transactional mail provider we do not have, and without one, hiding the collision
 * leaves the user staring at a screen that will never resolve. Login and password
 * reset — the paths that matter for credential attacks — do not leak. The hard
 * rate limit on `register:ip` is what stops the disclosure being harvested in bulk.
 */
export async function register(
  input: RegisterInput,
): Promise<Result<RegisteredIdentity, RegisterFailure>> {
  const passwordHash = await hashPassword(input.password)

  const workspaceName = input.workspaceName ?? `${input.name}'s workspace`
  const baseSlug = slugify(workspaceName)

  // Retry only the slug collision. Five attempts against a 32^4 suffix space is
  // ample; exhausting it means something other than collision is wrong.
  for (let attempt = 0; attempt < 5; attempt++) {
    const workspaceSlug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSuffix()}`

    try {
      const created = await repo.createUserWithOwnedWorkspace({
        email: input.email,
        passwordHash,
        name: input.name,
        timezone: 'UTC',
        workspaceName,
        workspaceSlug,
      })

      logger.info('auth.register.succeeded', {
        userId: created.userId,
        workspaceId: created.workspaceId,
      })
      return ok(created)
    } catch (error) {
      // The email unique is terminal: a different slug will not help.
      if (repo.isUniqueViolationOn(error, 'email')) {
        logger.info('auth.register.email_taken')
        return err({ kind: 'email_taken' })
      }
      if (repo.isUniqueViolationOn(error, 'slug')) continue
      throw error
    }
  }

  throw new ConflictError('Could not allocate a workspace address. Please try again.')
}

// ════════════════════════════════════════════════════════════════════ login

/**
 * Verifies credentials and resolves which workspace the new session points at.
 *
 * Returns the identity; it does NOT create the session — see the header note.
 *
 * USER-ENUMERATION RESISTANCE. Three things leak and all three are closed here:
 *
 *   Timing        an unknown email would skip the hash entirely. We verify against
 *                 DUMMY_HASH instead, so there is always exactly one real argon2id
 *                 verify whether the user exists or not. Also covers a user row
 *                 with a null passwordHash (invited, not yet accepted).
 *   Response body "no such account" vs "wrong password" becomes one
 *                 `invalid_credentials` variant with one message.
 *   Response shape a 404 vs a 401 becomes one code path and one Result variant.
 *
 * The same discipline covers lockout: a locked account returns
 * `invalid_credentials`, not "account locked". Telling an attacker they
 * successfully locked someone out confirms the account exists AND invites them to
 * keep doing it.
 */
export async function login(
  input: LoginInput,
): Promise<Result<{ userId: string; activeWorkspaceId: string | null }, CredentialFailure>> {
  const user = await repo.findLoginCandidateByEmail(input.email)
  const dummyHash = await getDummyHash()

  const isLocked = user?.lockedUntil != null && user.lockedUntil.getTime() > Date.now()

  // Always exactly one real verify. A locked account still pays for it, so the
  // lock is not observable in the timing either.
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? dummyHash)

  if (!user || !passwordOk || isLocked) {
    if (user && !passwordOk) {
      await repo.bumpFailedLogin(user.id, LOCK_THRESHOLD, new Date(Date.now() + LOCK_DURATION_MS))
    }
    // The address is hashed, never stored plaintext, so the log is not a list of
    // addresses someone tried.
    logger.warn('auth.login.failed', {
      emailHash: hashToken(input.email),
      ...(user ? { userId: user.id } : {}),
      ...(isLocked ? { locked: true } : {}),
    })
    return err({ kind: 'invalid_credentials' })
  }

  // Only on a SUCCESSFUL verify, and nowhere else in the codebase — this is the
  // only moment we legitimately hold a plaintext password.
  if (user.passwordHash && needsRehash(user.passwordHash)) {
    await repo.updatePasswordHash(user.id, await hashPassword(input.password))
    logger.info('auth.password.rehashed', { userId: user.id })
  }

  await repo.markLoginSucceeded(user.id)
  const activeWorkspaceId = await resolveActiveWorkspace(user.id)

  logger.info('auth.login.succeeded', {
    userId: user.id,
    ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
  })
  return ok({ userId: user.id, activeWorkspaceId })
}

/**
 * The most recently used workspace if that membership is still ACTIVE, else the
 * oldest ACTIVE membership, else null — which sends the user to `/onboarding`.
 * `Session.activeWorkspaceId` is nullable in the schema precisely for the third
 * case.
 */
async function resolveActiveWorkspace(userId: string): Promise<string | null> {
  const recent = await repo.findMostRecentActiveWorkspaceId(userId)
  if (recent) {
    const stillLive = await repo.findActiveMembership(userId, recent)
    if (stillLive) return stillLive.workspaceId
  }
  const fallback = await repo.findFirstActiveMembership(userId)
  return fallback?.workspaceId ?? null
}

// ══════════════════════════════════════════════════════════════ reset flow

/**
 * Mints a reset token when the address exists, and does nothing when it does not —
 * but returns identically either way.
 *
 * "Do not leak account existence" means three things must match on both branches,
 * not just the status code:
 *
 *   Same body      the caller renders "If an account exists for that address, we
 *                  have sent a reset link" regardless of the return value, which
 *                  is why this returns `void` rather than a found/not-found flag.
 *   Same latency   the found branch does one indexed lookup plus two small writes;
 *                  the not-found branch does the lookup. Mail delivery is NOT
 *                  awaited inline on either branch, so the difference stays inside
 *                  request noise.
 *   Same repetition both branches consume rate-limit budget, which is the caller's
 *                  job. If only the found branch did, an attacker would enumerate
 *                  by watching for the 429.
 *
 * Returns the plaintext token for the found branch so the caller can hand it to a
 * `Mailer`. It must never reach an HTTP response body — not in JSON, not in a
 * header, not in dev. The moment a token is in a response, someone builds a client
 * that reads it and the reset flow is bypassable in production.
 */
export async function requestPasswordReset(email: string): Promise<{ token: string } | null> {
  const user = await repo.findLoginCandidateByEmail(email)
  if (!user) {
    logger.info('auth.password.reset_requested', { emailHash: hashToken(email), found: false })
    return null
  }

  // Requesting a new link retires every previous one, so a forwarded older email
  // stops working the moment the user asks again.
  await repo.invalidateLivePasswordResetTokens(user.id)

  const token = mintToken()
  await repo.insertPasswordResetToken({
    tokenHash: hashToken(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  })

  logger.info('auth.password.reset_requested', { userId: user.id, found: true })
  return { token }
}

/**
 * Consumes the token and sets the new password.
 *
 * The consume is one atomic conditional UPDATE in the repo, so two concurrent
 * requests bearing the same token cannot both succeed.
 *
 * Reset does NOT auto-login, and the caller redirects to `/login?reset=1`.
 * Auto-login turns a leaked reset link straight into a session and gives the
 * attacker no password to have known.
 */
export async function resetPassword(
  input: ResetPasswordInput,
): Promise<Result<{ userId: string }, ResetFailure>> {
  const userId = await repo.consumePasswordResetToken(hashToken(input.token))
  if (!userId) {
    logger.warn('auth.password.reset_rejected')
    return err({ kind: 'invalid_or_expired_token' })
  }

  await repo.applyPasswordReset({ userId, passwordHash: await hashPassword(input.password) })
  logger.info('auth.password.reset', { userId })
  return ok({ userId })
}

/**
 * Changes the password for an authenticated caller.
 *
 * The current password is required even though the caller already holds a valid
 * session: this is the control that stops a STOLEN session from locking the owner
 * out of their own account.
 *
 * Revokes every other session but spares `ctx.sessionId` — the point of a change
 * is evicting whoever knew the old password, and logging the user out of the tab
 * they are in adds nothing. A password RESET revokes all sessions with no
 * exception, because there the person holding them may not be the user.
 */
export async function changePassword(
  ctx: Ctx,
  input: ChangePasswordInput,
): Promise<Result<{ revokedSessions: number }, ChangePasswordFailure>> {
  const currentHash = await repo.findPasswordHashById(ctx.userId)
  // A live Ctx whose user has no password means an invited row that never chose
  // one; there is nothing to verify against, so this is not a Result failure.
  if (!currentHash) throw new UnauthorizedError()

  if (!(await verifyPassword(input.currentPassword, currentHash))) {
    logger.warn('auth.password.change_rejected', { userId: ctx.userId })
    return err({ kind: 'invalid_credentials' })
  }

  // Compared against the STORED hash rather than the submitted strings, so
  // "reuse the same password" is caught even when the schema's own inequality
  // check passes because the two inputs differ only in a way argon2 ignores.
  if (await verifyPassword(input.newPassword, currentHash)) {
    return err({ kind: 'same_password' })
  }

  const revokedSessions = await repo.applyPasswordChange({
    userId: ctx.userId,
    passwordHash: await hashPassword(input.newPassword),
    exceptSessionId: ctx.sessionId,
  })

  logger.info('auth.password.changed', {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    revokedSessions,
  })
  return ok({ revokedSessions })
}

// ═══════════════════════════════════════════════════════════ reads & profile

export async function me(session: SessionRecord): Promise<AuthUser> {
  const user = await repo.findUserById(session.userId)
  if (!user) throw new NotFoundError('User')
  return user
}

/** Coarse UA parse for the session list. Not a fingerprint, and not stored. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device'
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : /Firefox\//.test(userAgent)
            ? 'Firefox'
            : 'Unknown browser'

  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /(iPhone|iPad|iOS)/.test(userAgent)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'Unknown OS'

  return `${browser} on ${os}`
}

/**
 * Masks an IP for display.
 *
 * A full-precision IP history is a stalking aid if the account is already
 * compromised, and the last octet adds nothing to the legitimate "was that me?"
 * question. `Session.ipAddress` keeps full precision in the database for incident
 * response.
 */
function maskIp(ip: string | null): string {
  if (!ip) return 'Unknown'
  if (ip.includes(':')) {
    const head = ip.split(':').slice(0, 3).join(':')
    return `${head}::`
  }
  const parts = ip.split('.')
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.x` : 'Unknown'
}

/** The caller's own sessions. `tokenHash` is never selected, so it cannot leak. */
export async function listSessions(session: SessionRecord): Promise<SessionSummary[]> {
  const rows = await repo.listLiveSessionsForUser(session.userId)
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    isCurrent: row.id === session.id,
    device: describeDevice(row.userAgent),
    ipMasked: maskIp(row.ipAddress),
  }))
}

export async function updateProfile(ctx: Ctx, input: UpdateProfileInput): Promise<void> {
  await repo.updateProfile(ctx.userId, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
  })
  logger.info('auth.profile.updated', { userId: ctx.userId, workspaceId: ctx.workspaceId })
}
