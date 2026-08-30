import 'server-only'
import { unstable_rethrow } from 'next/navigation'
import { z } from 'zod'
import { isAppError, type ErrorCode } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { consume, type RateLimitRule } from '@/lib/rate-limit'
import { requireCan, type Capability } from './authz'
import { requireWorkspace, type Ctx } from './ctx'

/**
 * ONE server-action wrapper: authenticate, rate limit, validate, authorize, run.
 *
 * Genuinely type-safe — there is no `any` in this file. `S extends z.ZodType`
 * carries the input type through to the handler, and `R` carries the return type
 * through to the caller, so a client narrows on `ok` and gets `data` typed with no
 * cast.
 */

/** Field-level messages keyed by dotted path, for rendering next to inputs. */
export type FieldIssues = Record<string, string[]>

export type ActionResult<R> =
  | { ok: true; data: R }
  | { ok: false; error: 'unauthorized'; message: string }
  | { ok: false; error: 'forbidden'; message: string }
  | { ok: false; error: 'not_found'; message: string }
  | { ok: false; error: 'conflict'; message: string }
  | { ok: false; error: 'validation'; message: string; issues: FieldIssues; formErrors: string[] }
  | { ok: false; error: 'rate_limited'; message: string; retryAfterSeconds: number }
  | { ok: false; error: 'unavailable'; message: string }
  | { ok: false; error: 'internal'; message: string }

type RateLimitSpec = {
  rule: RateLimitRule
  /**
   * Composes the limiter identity from `Ctx` only.
   *
   * It cannot reference a validated input field, because limiting runs BEFORE
   * parsing — that ordering is what stops a flood of malformed payloads from
   * burning CPU on zod. Defaults to `user:<id>`.
   */
  identity?: (ctx: Ctx) => string
}

export type ActionOpts<S extends z.ZodType> = {
  /** Stable dotted name, e.g. `workspace.invite`. Used in logs and limiter keys. */
  name: string
  capability: Capability
  /** ALWAYS `.strict()` / `z.strictObject`. See the note on step 3. */
  schema: S
  rateLimit?: RateLimitSpec
}

/** The `error` discriminant of every failure arm. Excludes the success arm, which has none. */
type ActionErrorKind = Extract<ActionResult<unknown>, { ok: false }>['error']

/**
 * Maps an `AppError`'s code onto the matching `ActionResult` variant. Anything not
 * listed collapses to `internal`, so a new error class cannot accidentally leak an
 * internal message to a client.
 */
const CODE_TO_VARIANT = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  VALIDATION: 'validation',
  RATE_LIMITED: 'rate_limited',
  UNAVAILABLE: 'unavailable',
} as const satisfies Partial<Record<ErrorCode, ActionErrorKind>>

/**
 * Wraps a handler into a server action.
 *
 * ORDER OF OPERATIONS, and every step is load-bearing:
 *
 *   1. requireWorkspace()   unauthenticated → 'unauthorized'
 *   2. rate limit           over            → 'rate_limited' + retryAfterSeconds
 *   3. schema.parse(raw)    invalid         → 'validation' + field issues
 *   4. requireCan()         denied          → 'forbidden'
 *   5. handler(ctx, input)  AppError        → typed variant; unknown → logged, generic
 *
 * Rate limiting sits BEFORE parsing so a flood of malformed payloads cannot be
 * used to burn CPU on zod. Authorization sits AFTER parsing so a denial is not a
 * validation oracle — if authz ran first, the difference between "forbidden" and
 * "invalid" would tell an attacker which capabilities they hold.
 *
 * The wrapper deliberately does NOT: add a CSRF token (Next's action POSTs carry
 * an origin check; route handlers call `assertSameOrigin()` instead), write an
 * audit row (`AuditLog.action` is a curated vocabulary, not "everything that
 * ran"), retry (a retried mutation with no idempotency key is a duplicate), or
 * cache anything (actions are mutations).
 */
export function action<S extends z.ZodType, R>(
  opts: ActionOpts<S>,
  handler: (ctx: Ctx, input: z.output<S>) => Promise<R>,
): (raw: unknown) => Promise<ActionResult<R>> {
  return async function runAction(raw: unknown): Promise<ActionResult<R>> {
    try {
      // 1. Authenticate and resolve tenancy. Redirects when there is no session or
      //    no membership, which is why the catch below rethrows framework signals.
      const ctx = await requireWorkspace()

      // 2. Rate limit, before any parsing work.
      if (opts.rateLimit) {
        const identity = opts.rateLimit.identity?.(ctx) ?? `user:${ctx.userId}`
        const verdict = await consume(opts.rateLimit.rule, identity)
        if (!verdict.ok) {
          return {
            ok: false,
            error: 'rate_limited',
            retryAfterSeconds: verdict.retryAfterSeconds,
            message: describeRetry(verdict.retryAfterSeconds),
          }
        }
      }

      // 3. Validate. The schema is `.strict()`, so an unknown key — notably a
      //    smuggled `workspaceId` — is a REJECTION rather than a silently stripped
      //    field. That is what turns brief §4 rule 2 into a mechanism: the attempt
      //    shows up as a validation failure in the logs instead of vanishing.
      const parsed = opts.schema.safeParse(raw)
      if (!parsed.success) {
        const flat = z.flattenError(parsed.error)
        logger.warn('action.validation_failed', {
          action: opts.name,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          // Field NAMES only. The values are user input and may be a password.
          fields: Object.keys(flat.fieldErrors),
          formErrors: flat.formErrors,
        })
        return {
          ok: false,
          error: 'validation',
          message: 'Please correct the highlighted fields.',
          issues: flat.fieldErrors as FieldIssues,
          formErrors: flat.formErrors,
        }
      }

      // 4. Authorize. The service checks this again — a service is also reachable
      //    from a route handler and a job handler, and only the inner check covers
      //    every entry point.
      requireCan(ctx, opts.capability)

      // 5. Run.
      const data = await handler(ctx, parsed.data as z.output<S>)
      return { ok: true, data }
    } catch (error) {
      // `redirect()` and `notFound()` work by THROWING a Next control-flow signal.
      // Without this line the catch below swallows it, the redirect silently stops
      // happening, and the user sees `{ ok: false, error: 'internal' }` instead of
      // moving to the next page. This is the single most likely bug in a wrapper
      // like this one, and it is silent — hence the explicit first statement.
      unstable_rethrow(error)

      if (isAppError(error)) {
        const variant = CODE_TO_VARIANT[error.code as keyof typeof CODE_TO_VARIANT]

        if (variant === 'rate_limited') {
          const retryAfterSeconds =
            'retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number'
              ? error.retryAfterSeconds
              : 60
          return {
            ok: false,
            error: 'rate_limited',
            retryAfterSeconds,
            message: error.publicMessage,
          }
        }

        if (variant === 'validation') {
          const fieldErrors =
            'fieldErrors' in error && error.fieldErrors ? (error.fieldErrors as FieldIssues) : {}
          return {
            ok: false,
            error: 'validation',
            message: error.publicMessage,
            issues: fieldErrors,
            formErrors: [],
          }
        }

        if (variant) return { ok: false, error: variant, message: error.publicMessage }
      }

      // An unexpected throw is logged with its stack and returned as a generic
      // message. Internal detail never reaches a client.
      logger.error('action.failed', error, { action: opts.name })
      return {
        ok: false,
        error: 'internal',
        message: 'Something went wrong. Please try again.',
      }
    }
  }
}

/** A real reset time, never a bare "try again later". */
function describeRetry(seconds: number): string {
  if (seconds < 60) return `Too many attempts. Try again in ${seconds} seconds.`
  const minutes = Math.ceil(seconds / 60)
  return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
}

/**
 * The same wrapper for actions that need a SESSION but no workspace — register,
 * login, the workspace switcher, accepting an invite. There is no `Ctx` and
 * therefore no capability to check, so the capability parameter is absent by
 * construction rather than by convention.
 *
 * Kept separate rather than making `capability` optional on `action()`: an
 * optional capability is a footgun, because forgetting it silently produces an
 * unauthorized action that still compiles.
 */
export function publicAction<S extends z.ZodType, R>(
  opts: { name: string; schema: S; rateLimit?: { rule: RateLimitRule; identity: string } },
  handler: (input: z.output<S>) => Promise<R>,
): (raw: unknown) => Promise<ActionResult<R>> {
  return async function runPublicAction(raw: unknown): Promise<ActionResult<R>> {
    try {
      if (opts.rateLimit) {
        const verdict = await consume(opts.rateLimit.rule, opts.rateLimit.identity)
        if (!verdict.ok) {
          return {
            ok: false,
            error: 'rate_limited',
            retryAfterSeconds: verdict.retryAfterSeconds,
            message: describeRetry(verdict.retryAfterSeconds),
          }
        }
      }

      const parsed = opts.schema.safeParse(raw)
      if (!parsed.success) {
        const flat = z.flattenError(parsed.error)
        logger.warn('action.validation_failed', {
          action: opts.name,
          fields: Object.keys(flat.fieldErrors),
        })
        return {
          ok: false,
          error: 'validation',
          message: 'Please correct the highlighted fields.',
          issues: flat.fieldErrors as FieldIssues,
          formErrors: flat.formErrors,
        }
      }

      return { ok: true, data: await handler(parsed.data as z.output<S>) }
    } catch (error) {
      unstable_rethrow(error)

      if (isAppError(error)) {
        const variant = CODE_TO_VARIANT[error.code as keyof typeof CODE_TO_VARIANT]
        if (variant === 'rate_limited') {
          const retryAfterSeconds =
            'retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number'
              ? error.retryAfterSeconds
              : 60
          return {
            ok: false,
            error: 'rate_limited',
            retryAfterSeconds,
            message: error.publicMessage,
          }
        }
        if (variant === 'validation') {
          return {
            ok: false,
            error: 'validation',
            message: error.publicMessage,
            issues: {},
            formErrors: [],
          }
        }
        if (variant) return { ok: false, error: variant, message: error.publicMessage }
      }

      logger.error('action.failed', error, { action: opts.name })
      return { ok: false, error: 'internal', message: 'Something went wrong. Please try again.' }
    }
  }
}
