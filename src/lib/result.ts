/**
 * A typed result for expected failures.
 *
 * Used where a caller must branch on the outcome — a login attempt, a CSV row,
 * a provider send. Unexpected conditions throw an AppError instead; see
 * errors.ts. The discriminant is `ok`, so TypeScript narrows both arms.
 */

export type Result<T, E = string> = { ok: true; data: T } | { ok: false; error: E }

export function ok<T>(data: T): Result<T, never> {
  return { ok: true, data }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; data: T } {
  return r.ok
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok
}

/** Unwrap or throw. Only for call sites where a failure is genuinely a bug. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.data
  throw new Error(`unwrap() on an error result: ${JSON.stringify(r.error)}`)
}
