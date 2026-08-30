import { describe, expect, test } from 'bun:test'
import {
  AppError,
  type ErrorCode,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  RateLimitedError,
  ProviderError,
  UnavailableError,
  isAppError,
  toPublicError,
} from '../../src/lib/errors'

/**
 * Error-model tests.
 *
 * Two properties matter beyond the obvious: an unknown error must never leak its
 * internals to a client, and cross-workspace access must surface as 404 rather
 * than 403 — a 403 confirms that another tenant's resource exists.
 */

describe('status and code mapping', () => {
  // Typed explicitly: test.each widens a literal tuple to string, which no longer
  // satisfies toBe(expected: ErrorCode).
  const CASES: [string, AppError, number, ErrorCode][] = [
    ['NotFoundError', new NotFoundError(), 404, 'NOT_FOUND'],
    ['UnauthorizedError', new UnauthorizedError(), 401, 'UNAUTHORIZED'],
    ['ForbiddenError', new ForbiddenError(), 403, 'FORBIDDEN'],
    ['ValidationError', new ValidationError(), 422, 'VALIDATION'],
    ['ConflictError', new ConflictError(), 409, 'CONFLICT'],
    ['RateLimitedError', new RateLimitedError(30), 429, 'RATE_LIMITED'],
    ['UnavailableError', new UnavailableError(), 503, 'UNAVAILABLE'],
  ]

  test.each(CASES)('%s maps to %i / %s', (_n, err, status, code) => {
    expect(err.status).toBe(status)
    expect(err.code).toBe(code)
  })

  test('ProviderError is a 502 and carries its retryability', () => {
    const retryable = new ProviderError('gmail', 'Temporarily unavailable.', { retryable: true })
    const terminal = new ProviderError('gmail', 'Invalid grant.', { retryable: false })

    expect(retryable.status).toBe(502)
    // The queue branches on this: retrying a terminal error wedges a job forever,
    // and giving up on a transient one drops mail.
    expect(retryable.retryable).toBe(true)
    expect(terminal.retryable).toBe(false)
    expect(terminal.provider).toBe('gmail')
  })
})

describe('the 404-not-403 rule', () => {
  test('NotFoundError does not reveal which resource was requested by id', () => {
    const e = new NotFoundError('Campaign')
    expect(e.status).toBe(404)
    // Naming the type is fine; echoing the id would confirm it exists somewhere.
    expect(e.publicMessage).toBe('Campaign not found.')
  })

  test('a cross-workspace hit is representable as 404, never 403', () => {
    // The rule is enforced at the repo layer, but the error type has to make the
    // correct choice expressible and obvious.
    const e = new NotFoundError('Lead')
    expect(e.status).toBe(404)
    expect(e.code).toBe('NOT_FOUND')
  })
})

describe('public messages never leak internals', () => {
  test('an internal message stays out of publicMessage', () => {
    const e = new AppError('INTERNAL', 500, 'Something went wrong.', {
      internalMessage: 'pg: duplicate key value violates constraint "Lead_workspaceId_email_key"',
    })
    expect(e.publicMessage).toBe('Something went wrong.')
    // The detail is retained on .message for logs, just not for the client.
    expect(e.message).toContain('duplicate key')
  })

  test('toPublicError collapses an unknown throwable to a generic 500', () => {
    const out = toPublicError(new Error('DATABASE_URL=postgres://user:hunter2@host/db'))
    expect(out.status).toBe(500)
    expect(out.code).toBe('INTERNAL')
    // The whole point: a stray error must not put a connection string on screen.
    expect(out.message).not.toContain('hunter2')
    expect(out.message).toBe('Something went wrong. Please try again.')
  })

  test.each([['a bare string'], [42], [null], [undefined], [{ odd: 'shape' }]])(
    'toPublicError handles a non-Error throwable: %p',
    (thrown) => {
      const out = toPublicError(thrown)
      expect(out.status).toBe(500)
      expect(out.code).toBe('INTERNAL')
    },
  )

  test('toPublicError passes an AppError through unchanged', () => {
    const out = toPublicError(new ConflictError('A lead with that email already exists.'))
    expect(out.status).toBe(409)
    expect(out.message).toBe('A lead with that email already exists.')
  })
})

describe('ValidationError field errors', () => {
  test('carries per-field messages for form display', () => {
    const e = new ValidationError('Please correct the highlighted fields.', {
      email: ['Enter a valid email address.'],
      'sequence.steps.0.subject': ['Subject is required.'],
    })
    expect(e.fieldErrors.email).toEqual(['Enter a valid email address.'])
    // Dotted paths must survive so a nested field can be highlighted.
    expect(e.fieldErrors['sequence.steps.0.subject']).toHaveLength(1)
  })

  test('defaults to an empty record rather than undefined', () => {
    // Callers iterate this; undefined would force a guard at every call site.
    expect(new ValidationError().fieldErrors).toEqual({})
  })
})

describe('RateLimitedError', () => {
  test('carries retryAfterSeconds for the Retry-After header', () => {
    const e = new RateLimitedError(120)
    expect(e.retryAfterSeconds).toBe(120)
    expect(e.status).toBe(429)
  })

  test('does not disclose the limit or the identity in its public message', () => {
    const e = new RateLimitedError(90)
    expect(e.publicMessage).not.toMatch(/\d/)
  })
})

describe('type guards and inheritance', () => {
  test('isAppError narrows our errors and rejects foreign ones', () => {
    expect(isAppError(new NotFoundError())).toBe(true)
    expect(isAppError(new Error('plain'))).toBe(false)
    expect(isAppError('not an error')).toBe(false)
    expect(isAppError(null)).toBe(false)
  })

  test('every subclass is an AppError and an Error', () => {
    for (const e of [
      new NotFoundError(),
      new UnauthorizedError(),
      new ForbiddenError(),
      new ValidationError(),
      new ConflictError(),
      new RateLimitedError(1),
      new ProviderError('gmail', 'x', { retryable: false }),
      new UnavailableError(),
    ]) {
      expect(e).toBeInstanceOf(AppError)
      expect(e).toBeInstanceOf(Error)
      // name is set from the constructor, so logs identify the subclass.
      expect(e.name).toBe(e.constructor.name)
    }
  })

  test('preserves the cause for log chaining', () => {
    const root = new Error('connection reset')
    expect(new ProviderError('gmail', 'Send failed.', { retryable: true, cause: root }).cause).toBe(
      root,
    )
  })
})
