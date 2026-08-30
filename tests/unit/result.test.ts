import { describe, expect, test } from 'bun:test'
import { ok, err, isOk, isErr, unwrap, type Result } from '../../src/lib/result'

/**
 * Result tests. Result carries *expected* failures a caller must branch on — a
 * login attempt, a CSV row, a provider send. Unexpected conditions throw an
 * AppError instead.
 */

describe('construction and narrowing', () => {
  test('ok carries data', () => {
    const r = ok({ id: 'lead_1' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.id).toBe('lead_1')
  })

  test('err carries the error', () => {
    const r = err('INVALID_EMAIL')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('INVALID_EMAIL')
  })

  test('the ok discriminant narrows both arms', () => {
    const r: Result<number, string> = ok(1)
    // Compiles only because `ok` is a literal-typed discriminant.
    expect(r.ok ? r.data + 1 : r.error.length).toBe(2)
  })

  test.each([[null], [undefined], [0], [false], ['']])('ok(%p) is still a success', (value) => {
    // A falsy payload must not read as failure — this is why the flag exists
    // rather than returning `T | null`.
    const r = ok(value)
    expect(r.ok).toBe(true)
    expect(isOk(r)).toBe(true)
  })
})

describe('guards', () => {
  test('isOk and isErr agree and are exclusive', () => {
    for (const r of [ok(1), err('bad')] as Result<number, string>[]) {
      expect(isOk(r)).toBe(!isErr(r))
    }
  })
})

describe('unwrap', () => {
  test('returns data on success', () => {
    expect(unwrap(ok('value'))).toBe('value')
  })

  test('throws on failure, and the message names the error', () => {
    // Only for call sites where a failure is genuinely a bug; it must be loud.
    expect(() => unwrap(err('DB_UNREACHABLE'))).toThrow(/DB_UNREACHABLE/)
  })

  test('serialises a structured error into the thrown message', () => {
    expect(() => unwrap(err({ code: 'ROW_INVALID', row: 42 }))).toThrow(/ROW_INVALID/)
  })
})

describe('realistic usage', () => {
  /** CSV import: per-row failures are expected, so they are returned not thrown. */
  function parseRow(raw: string): Result<{ email: string }, { reason: string; raw: string }> {
    const email = raw.trim().toLowerCase()
    if (!email.includes('@')) return err({ reason: 'not_an_email', raw })
    return ok({ email })
  }

  test('partitions a batch into valid rows and per-row errors', () => {
    const rows = [' Dana@Example.test ', 'not-an-email', 'sam@example.test']
    const results = rows.map(parseRow)

    const valid = results.filter(isOk).map((r) => r.data.email)
    const invalid = results.filter(isErr).map((r) => r.error)

    // Normalisation applied, and one bad row does not fail the whole import.
    expect(valid).toEqual(['dana@example.test', 'sam@example.test'])
    expect(invalid).toHaveLength(1)
    expect(invalid[0]!.raw).toBe('not-an-email')
  })
})
