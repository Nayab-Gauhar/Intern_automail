import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { hashToken, mintToken } from '@/lib/tokens'
import * as repo from '@/modules/auth/repo'
import type { SessionMeta, SessionRecord } from '@/modules/auth/types'

/**
 * Session cookie mechanics and the request-path validation. This module is the
 * only place the plaintext session token is ever handled.
 *
 * `server-only`, so any client-component import path is a build error rather than
 * a leak.
 */

/**
 * The `__Host-` prefix is browser-ENFORCED: a cookie carrying it is rejected
 * unless it is `Secure`, `Path=/`, and has no `Domain`, which is what stops a
 * subdomain-injected cookie from overwriting the session. Dev runs on plain
 * `http://localhost`, where `Secure` cannot be set, so the prefix must be dropped
 * there or local login silently fails with no error anywhere.
 */
export const SESSION_COOKIE = env.NODE_ENV === 'production' ? '__Host-im_session' : 'im_session'

/** 14 days of inactivity ends a session. */
export const IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000
/** 90 days from creation ends it regardless of activity. Never extended. */
export const ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** A slide writes at most once per session per this interval. */
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * True when `value` contains a C0 control character or DEL — CR, LF, NUL and
 * friends, the header-splitting and path-smuggling bytes.
 *
 * Written as a code-point scan rather than `/[\x00-\x1f\x7f]/` because eslint's
 * `no-control-regex` flags a control character in a literal, and suppressing a rule
 * on a security check is worse than expressing the check plainly. Same semantics,
 * no directive to review.
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

type CookieJar = Awaited<ReturnType<typeof cookies>>

function setSessionCookie(jar: CookieJar, token: string, expiresAt: Date): void {
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, // XSS cannot read it
    sameSite: 'lax', // blocks cross-site form POSTs, survives the OAuth GET redirect back
    secure: env.NODE_ENV === 'production', // forced by __Host- anyway; explicit beats implied
    path: '/', // required by __Host-
    expires: expiresAt,
    // `domain` is deliberately never set: required by __Host-, and it keeps the
    // cookie off any future marketing subdomain.
  })
}

/**
 * Mints the token, stores only its hash, sets the cookie.
 *
 * Returns the session id and nothing else — in particular NOT the token, which
 * must not escape this function. A caller that could read it could log it.
 */
export async function createSession(userId: string, meta: SessionMeta = {}): Promise<string> {
  const token = mintToken()
  const now = Date.now()
  const absoluteExpiresAt = new Date(now + ABSOLUTE_TTL_MS)
  const expiresAt = new Date(now + IDLE_TTL_MS)

  const session = await repo.insertSession({
    tokenHash: hashToken(token),
    userId,
    expiresAt,
    absoluteExpiresAt,
    meta,
  })

  const jar = await cookies()
  setSessionCookie(jar, token, expiresAt)

  logger.info('auth.session.created', { userId, sessionId: session.id })
  return session.id
}

/**
 * Reads the cookie, validates it against the database, slides expiry. Returns
 * null when the cookie is absent, malformed, expired, revoked, or belongs to a
 * soft-deleted user.
 *
 * Wrapped in React `cache()`: a page with eight server components each calling
 * this performs ONE query, not eight. The cache is per-render by construction, so
 * it cannot serve one request's session to another.
 */
export const getSession: () => Promise<SessionRecord | null> = cache(
  async (): Promise<SessionRecord | null> => {
    const jar = await cookies()
    const token = jar.get(SESSION_COOKIE)?.value
    if (!token) return null

    const row = await repo.findLiveSessionByTokenHash(hashToken(token))

    if (!row) {
      // Delete the cookie as well as returning null. Otherwise a user whose
      // session expired carries a dead cookie that re-triggers this database
      // probe on every request, forever.
      jar.delete(SESSION_COOKIE)
      return null
    }

    await slideExpiry(jar, token, row)
    return row
  },
)

/**
 * Extends `expiresAt`, clamped to `absoluteExpiresAt`, at most once per 24h.
 *
 * Both properties are load-bearing. Without the clamp, sliding eventually pushes
 * idle expiry past the hard ceiling and the ceiling becomes decorative. Without
 * the 24h floor, a read-only page render becomes a write and `Session` turns into
 * the hottest table in the database.
 *
 * The token itself does not rotate. Rotating per request makes two concurrent
 * requests race, and the loser gets logged out — a real bug in real apps with
 * link prefetching.
 */
async function slideExpiry(jar: CookieJar, token: string, row: SessionRecord): Promise<void> {
  const slid = new Date(Math.min(Date.now() + IDLE_TTL_MS, row.absoluteExpiresAt.getTime()))
  if (slid.getTime() - row.expiresAt.getTime() <= REFRESH_AFTER_MS) return

  await repo.touchSession(row.id, slid)
  setSessionCookie(jar, token, slid)
  row.expiresAt = slid
}

/**
 * `getSession()` or a redirect to `/login`. Redirects rather than throwing
 * because every caller is a layout, page, or action that wants exactly that.
 *
 * `cache()`d for the same reason as `getSession`.
 */
export const requireSession: () => Promise<SessionRecord> = cache(
  async (): Promise<SessionRecord> => {
    const session = await getSession()
    if (!session) redirect('/login')
    return session
  },
)

/** Revokes the current session and clears the cookie. A POST/action, never a GET. */
export async function destroyCurrentSession(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  // `revokedAt`, not DELETE: the row stays useful for "was this session active
  // when that mailbox was disconnected?" until MAINTENANCE prunes it.
  if (token) await repo.revokeByTokenHash(hashToken(token))
  jar.delete(SESSION_COOKIE)
}

/** Revokes one of the caller's OWN sessions. Scoped by userId in the query. */
export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const count = await repo.revokeSessionForUser(userId, sessionId)
  if (count > 0) logger.info('auth.session.revoked', { userId, sessionId })
  return count > 0
}

/** "Sign out everywhere". `except` spares the caller's current tab. */
export async function revokeAllSessions(
  userId: string,
  opts?: { except?: string },
): Promise<number> {
  const count = await repo.revokeAllSessionsForUser(userId, {
    ...(opts?.except != null ? { exceptSessionId: opts.except } : {}),
  })
  logger.info('auth.session.revoked_all', { userId, count })
  return count
}

/**
 * Validates a `?next=` target. An unvalidated `next` is an open redirect and a
 * phishing primitive.
 *
 * Allowlisted by SHAPE, never by a blocklist of hostnames: a blocklist is a game
 * of catch-up against `//evil.com`, `/\evil.com`, `https:evil.com`, and every
 * encoding trick after those.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next) return '/dashboard'
  if (!next.startsWith('/')) return '/dashboard' // absolute or scheme-relative
  if (next.startsWith('//')) return '/dashboard' // protocol-relative, resolves off-origin
  if (next.includes('\\')) return '/dashboard' // browsers normalise backslash to slash
  if (hasControlChars(next)) return '/dashboard' // CR/LF header splitting
  return next
}

/** Builds the `/login?next=…` target for a guard that needs to bounce a caller. */
export function loginUrlFor(pathAndQuery: string): string {
  return `/login?next=${encodeURIComponent(safeNext(pathAndQuery))}`
}
