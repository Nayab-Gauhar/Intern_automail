'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { hashToken } from '@/lib/tokens'
import { logger } from '@/lib/logger'
import { LIMITS, consumeAll, emailIdentity, ipIdentity } from '@/lib/rate-limit'
import { login, loginSchema, register, registerSchema } from '@/modules/auth'
import { createSession, safeNext } from '@/server/session'

/**
 * Login and registration actions.
 *
 * These deliberately do NOT go through `src/server/action.ts`. That wrapper begins with
 * `requireWorkspace()`, which is exactly what a pre-authentication surface cannot have:
 * there is no session yet, so the wrapper would reject every login attempt. The five
 * steps it exists to guarantee are still all here, in the same order — rate limit,
 * validate, act — minus the authorization step, which has no meaning before identity
 * exists.
 *
 * `redirect()` works by throwing a Next control-flow signal, so every one of them is
 * called at the end of the function and never inside a `try`. A `catch` around a
 * redirect swallows it and the navigation silently does not happen.
 */

/** The shape `useActionState` renders. `null` is the untouched initial state. */
export type AuthFormState = {
  /** Form-level message for the aria-live summary. */
  message?: string
  /** Per-field messages, keyed by input name. */
  fieldErrors?: Record<string, string>
} | null

/**
 * Best-effort client IP for rate limiting.
 *
 * `x-forwarded-for` is client-controlled unless a trusted proxy overwrites it, so this
 * is a limiter identity and nothing more — never an authorization input, and never
 * logged as though it were the true source.
 */
async function clientIp(): Promise<string> {
  const h = await headers()
  const forwarded = h.get('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  if (first) return first
  return h.get('x-real-ip')?.trim() ?? 'unknown'
}

async function userAgent(): Promise<string | undefined> {
  const ua = (await headers()).get('user-agent')
  return ua ?? undefined
}

/** Groups zod issues by their first path segment, which is the input's `name`. */
function fieldErrorsFrom(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const out: Record<string, string> = {}
  for (const issue of issues) {
    const key = issue.path[0]
    if (typeof key !== 'string') continue
    // First message per field: a stack of three messages under one input is noise.
    out[key] ??= issue.message
  }
  return out
}

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const raw = {
    email: String(formData.get('email') ?? ''),
    password: String(formData.get('password') ?? ''),
  }
  const next = safeNext(formData.get('next')?.toString())

  // Rate limit BEFORE parsing, so a flood of malformed payloads cannot be used to burn
  // CPU on validation. Both identities are consumed: IP stops the broad sweep, the
  // email hash stops a distributed attack on one account.
  const limited = await consumeAll([
    { rule: LIMITS.loginIp, identity: ipIdentity(await clientIp()) },
    { rule: LIMITS.loginEmail, identity: emailIdentity(hashToken(raw.email.toLowerCase())) },
  ])
  if (!limited.ok) {
    const minutes = Math.ceil(limited.retryAfterSeconds / 60)
    return {
      message: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    }
  }

  const parsed = loginSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      message: 'Check the details below and try again.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    }
  }

  const result = await login(parsed.data)
  if (!result.ok) {
    // ONE message for "no such account" and "wrong password" alike. Distinguishing
    // them turns this form into an account-enumeration oracle, and the service returns
    // a single variant precisely so the UI cannot split them by accident.
    return { message: 'That email and password combination is not correct.' }
  }

  const ua = await userAgent()
  await createSession(result.data.userId, {
    activeWorkspaceId: result.data.activeWorkspaceId,
    ipAddress: await clientIp(),
    ...(ua ? { userAgent: ua } : {}),
  })

  logger.info('auth.login.succeeded', { userId: result.data.userId })

  // Outside any try/catch: redirect() throws a framework signal by design.
  redirect(next)
}

export async function registerAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const workspaceName = formData.get('workspaceName')?.toString().trim()
  const raw = {
    name: String(formData.get('name') ?? ''),
    email: String(formData.get('email') ?? ''),
    password: String(formData.get('password') ?? ''),
    // The schema treats this as optional and defaults it in the service; an empty
    // string would fail `.min(1)` rather than fall back.
    ...(workspaceName ? { workspaceName } : {}),
  }

  const ip = await clientIp()
  const limited = await consumeAll([
    { rule: LIMITS.registerIp, identity: ipIdentity(ip) },
    { rule: LIMITS.registerIpDaily, identity: ipIdentity(ip) },
  ])
  if (!limited.ok) {
    const minutes = Math.ceil(limited.retryAfterSeconds / 60)
    return {
      message: `Too many accounts created from this network. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    }
  }

  const parsed = registerSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      message: 'Check the details below and try again.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    }
  }

  const result = await register(parsed.data)
  if (!result.ok) {
    // Registration is enumerable in v1 by an explicit, documented decision (auth spec
    // §5.1): without a transactional mail provider, hiding the collision leaves the
    // user on a screen that never resolves. The hard per-IP limit above is what stops
    // the disclosure being harvested in bulk. Login and reset do not leak.
    return {
      message: 'An account with that email already exists. Sign in instead.',
      fieldErrors: { email: 'Already registered' },
    }
  }

  const ua = await userAgent()
  await createSession(result.data.userId, {
    activeWorkspaceId: result.data.workspaceId,
    ipAddress: ip,
    ...(ua ? { userAgent: ua } : {}),
  })

  redirect('/dashboard')
}
