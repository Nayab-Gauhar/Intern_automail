import 'server-only'
import { db } from './db'
import { logger } from './logger'

/**
 * Fixed-window rate limiter, in Postgres. There is no Redis (brief §2), so the
 * limiter lives in the same datastore as the queue.
 *
 * IMPORT NOTE. This is the one file outside a module's own `repo.ts` that touches
 * the Prisma client, and 07 §2 puts it here deliberately: the limiter is
 * infrastructure for the request path, not a domain, and it has no `Ctx` because
 * the key may be an IP or an email seen before any workspace exists. It reaches
 * `./db` directly rather than through a module because inventing a `ratelimit`
 * module for one upsert would add a public API, a service, and a types file around
 * a single statement. Flagged for the lead rather than smuggled: if the rule is
 * absolute, the fix is a `modules/ratelimit/` folder, not a different query.
 */

export type RateLimitRule = {
  /** Stable bucket name, e.g. `login`. Appears in the primary key and in logs. */
  bucket: string
  limit: number
  windowMs: number
}

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSeconds: number; limit: number; resetAt: Date }

/**
 * The named limits from 07 §14.3. Every one is paired with a second, non-IP
 * identity: IP limits stop the broad sweep, account limits stop the targeted
 * attack. IP alone is defeated by a botnet; account alone is a DoS lever.
 */
export const LIMITS = {
  loginIp: { bucket: 'login', limit: 10, windowMs: 15 * 60_000 },
  loginEmail: { bucket: 'login_email', limit: 5, windowMs: 15 * 60_000 },
  registerIp: { bucket: 'register', limit: 3, windowMs: 60 * 60_000 },
  registerIpDaily: { bucket: 'register_daily', limit: 10, windowMs: 24 * 60 * 60_000 },
  resetRequestIp: { bucket: 'reset_request', limit: 5, windowMs: 60 * 60_000 },
  resetRequestEmail: { bucket: 'reset_request_email', limit: 3, windowMs: 60 * 60_000 },
  resetSubmitIp: { bucket: 'reset_submit', limit: 10, windowMs: 60 * 60_000 },
  passwordChangeUser: { bucket: 'password_change', limit: 5, windowMs: 60 * 60_000 },
  inviteWorkspace: { bucket: 'invite', limit: 20, windowMs: 60 * 60_000 },
  inviteWorkspaceDaily: { bucket: 'invite_daily', limit: 100, windowMs: 24 * 60 * 60_000 },
  inviteAcceptIp: { bucket: 'invite_accept', limit: 20, windowMs: 60 * 60_000 },
  workspaceSwitchUser: { bucket: 'ws_switch', limit: 60, windowMs: 60 * 60_000 },
} as const satisfies Record<string, RateLimitRule>

/**
 * Consumes one unit of budget.
 *
 * `identity` is already composed by the caller, e.g. `ip:203.0.113.7` or
 * `user:clzq…`, so this function never has to know what kind of subject it is
 * limiting.
 *
 * FIXED window, chosen over sliding. A sliding-log window needs a row per event
 * and a `COUNT(*)` over a time range on every check — for login, that is a write
 * plus a range scan per attempt. Fixed window is one upsert against a primary key.
 * The cost is the classic boundary burst: a caller can land `limit` requests at the
 * end of one window and `limit` more at the start of the next, so the true worst
 * case is 2x the nominal limit over a short span. For login (10/15min, so a
 * 20-attempt burst) that is irrelevant against argon2id at ~158 ms plus the account
 * lock at 10 failures. The limits are set with the 2x in mind rather than building
 * sliding windows.
 */
export async function consume(rule: RateLimitRule, identity: string): Promise<RateLimitResult> {
  const now = Date.now()
  // The window is IN the key. That is what makes the whole limiter one atomic
  // upsert with no read-modify-write: a new window is a new primary key, so it
  // starts at 1 by insert rather than by anyone resetting a counter.
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs
  const resetAt = new Date(windowStart + rule.windowMs)
  const key = `${rule.bucket}:${identity}:${Math.floor(windowStart / 1000)}`

  try {
    // ONE statement. Two concurrent requests cannot both read "under the limit"
    // and both proceed, because the increment happens inside the conflict clause.
    const rows = await db.$queryRaw<{ count: number }[]>`
      INSERT INTO "RateLimit" ("key", "count", "expiresAt")
      VALUES (${key}, 1, ${resetAt})
      ON CONFLICT ("key") DO UPDATE SET "count" = "RateLimit"."count" + 1
      RETURNING "count"`

    const count = Number(rows[0]?.count ?? 1)

    if (count > rule.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000))
      logger.warn('ratelimit.exceeded', {
        bucket: rule.bucket,
        limit: rule.limit,
        count,
        retryAfterSeconds,
      })
      return { ok: false, retryAfterSeconds, limit: rule.limit, resetAt }
    }

    return { ok: true, remaining: rule.limit - count }
  } catch (error) {
    // FAIL OPEN, and loudly. A database hiccup must not take login down. The
    // counter-argument — an attacker who can break the limiter gets unlimited
    // attempts — is covered by the account lock, which is a separate mechanism on
    // separate columns (User.failedLoginCount / lockedUntil).
    logger.error('ratelimit.unavailable', error, { bucket: rule.bucket })
    return { ok: true, remaining: rule.limit }
  }
}

/**
 * Checks every rule in one call, consuming budget from all of them, and returns
 * the first refusal.
 *
 * All rules are consumed even when an earlier one refuses. That is deliberate: if
 * the second identity's budget were skipped on a refusal, an attacker could
 * enumerate by watching which combination produced a 429 (07 §7, "same behaviour
 * under repetition").
 */
export async function consumeAll(
  pairs: readonly { rule: RateLimitRule; identity: string }[],
): Promise<RateLimitResult> {
  const results = await Promise.all(pairs.map((p) => consume(p.rule, p.identity)))
  return results.find((r) => !r.ok) ?? { ok: true, remaining: 0 }
}

/**
 * Deletes closed windows. Called by MAINTENANCE only, takes no `Ctx` because the
 * table holds no tenant data at all.
 */
export async function sweepExpired(): Promise<number> {
  const deleted = await db.rateLimit.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  if (deleted.count > 0) logger.info('ratelimit.swept', { count: deleted.count })
  return deleted.count
}

/** The client IP, normalised for use as a limiter identity. */
export function ipIdentity(ip: string): string {
  return `ip:${ip}`
}

/**
 * An email as a limiter identity, hashed rather than plaintext.
 *
 * The `RateLimit` table would otherwise become a list of every address anyone has
 * tried to log in as, readable by anyone with a database dump. The key only needs
 * to be stable, not reversible.
 */
export function emailIdentity(emailHash: string): string {
  return `email:${emailHash}`
}
