/**
 * The application error hierarchy.
 *
 * Rule: expected failures a caller should handle are returned as a Result (see
 * result.ts); genuinely exceptional conditions throw one of these. Every error
 * carries an HTTP status and a stable `code` so route handlers and UI states can
 * branch without string-matching messages.
 */

export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHORIZED'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'UNAVAILABLE'
  | 'INTERNAL'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  /** Safe to show a user. Never embed internal detail or secrets here. */
  readonly publicMessage: string

  constructor(
    code: ErrorCode,
    status: number,
    publicMessage: string,
    options?: { cause?: unknown; internalMessage?: string },
  ) {
    super(options?.internalMessage ?? publicMessage, { cause: options?.cause })
    this.name = new.target.name
    this.code = code
    this.status = status
    this.publicMessage = publicMessage
  }
}

/**
 * Also used when a resource exists but belongs to another workspace: we return
 * 404 rather than 403 so we never confirm the existence of another tenant's
 * data.
 */
export class NotFoundError extends AppError {
  constructor(resource = 'Resource', options?: { cause?: unknown }) {
    super('NOT_FOUND', 404, `${resource} not found.`, options)
  }
}

export class UnauthorizedError extends AppError {
  constructor(options?: { cause?: unknown }) {
    super('UNAUTHORIZED', 401, 'You must sign in to continue.', options)
  }
}

export class ForbiddenError extends AppError {
  constructor(action = 'perform this action', options?: { cause?: unknown }) {
    super('FORBIDDEN', 403, `You do not have permission to ${action}.`, options)
  }
}

export class ValidationError extends AppError {
  /** Field-level messages, keyed by dotted path, for form display. */
  readonly fieldErrors: Record<string, string[]>

  constructor(
    publicMessage = 'Please correct the highlighted fields.',
    fieldErrors: Record<string, string[]> = {},
    options?: { cause?: unknown },
  ) {
    super('VALIDATION', 422, publicMessage, options)
    this.fieldErrors = fieldErrors
  }
}

export class ConflictError extends AppError {
  constructor(
    publicMessage = 'That conflicts with something that already exists.',
    options?: { cause?: unknown },
  ) {
    super('CONFLICT', 409, publicMessage, options)
  }
}

export class RateLimitedError extends AppError {
  /** Seconds until the caller may retry; sent as the Retry-After header. */
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number, options?: { cause?: unknown }) {
    super('RATE_LIMITED', 429, 'Too many attempts. Please wait and try again.', options)
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** An upstream email provider failed. `retryable` drives the queue's decision. */
export class ProviderError extends AppError {
  readonly retryable: boolean
  readonly provider: string

  constructor(
    provider: string,
    publicMessage: string,
    opts: { retryable: boolean; cause?: unknown; internalMessage?: string },
  ) {
    super('PROVIDER_ERROR', 502, publicMessage, opts)
    this.provider = provider
    this.retryable = opts.retryable
  }
}

export class UnavailableError extends AppError {
  constructor(
    publicMessage = 'This feature is not configured yet.',
    options?: { cause?: unknown },
  ) {
    super('UNAVAILABLE', 503, publicMessage, options)
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}

/**
 * Convert any thrown value into a user-safe shape. Unknown errors deliberately
 * collapse to a generic message so internal detail never leaks to a client.
 */
export function toPublicError(e: unknown): { code: ErrorCode; status: number; message: string } {
  if (isAppError(e)) return { code: e.code, status: e.status, message: e.publicMessage }
  return { code: 'INTERNAL', status: 500, message: 'Something went wrong. Please try again.' }
}
