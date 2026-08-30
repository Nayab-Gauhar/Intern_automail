import { describe, expect, test } from 'bun:test'
import { mintToken, hashToken, timingSafeEqualStr } from '../../src/lib/tokens'

/**
 * Token tests. lib/tokens.ts is pure — no key material, no server-only marker —
 * so it imports directly with no env setup.
 *
 * What these pin: session tokens must be unguessable, must never be stored in
 * plaintext, and comparison against a stored secret must not leak via timing.
 */

describe('mintToken', () => {
  test('is url-safe, so it survives cookies, URLs and headers unescaped', () => {
    for (let i = 0; i < 50; i++) expect(mintToken()).toMatch(/^[\w-]+$/)
  })

  test('yields 256 bits by default', () => {
    expect(Buffer.from(mintToken(), 'base64url')).toHaveLength(32)
  })

  test('is 43 characters unpadded, which fits a cookie comfortably', () => {
    expect(mintToken()).toHaveLength(43)
    expect(mintToken()).not.toContain('=')
  })

  test('respects an explicit byte length', () => {
    expect(Buffer.from(mintToken(16), 'base64url')).toHaveLength(16)
    expect(Buffer.from(mintToken(64), 'base64url')).toHaveLength(64)
  })

  test('does not repeat across many calls', () => {
    // A collision here would mean one user's cookie authenticates as another.
    const seen = new Set(Array.from({ length: 5000 }, () => mintToken()))
    expect(seen.size).toBe(5000)
  })
})

describe('hashToken', () => {
  test('returns 64 hex characters, matching the Session.tokenHash contract', () => {
    expect(hashToken(mintToken())).toMatch(/^[0-9a-f]{64}$/)
  })

  test('is deterministic, so a cookie can be looked up by hash', () => {
    const t = mintToken()
    expect(hashToken(t)).toBe(hashToken(t))
  })

  test('differs for inputs one character apart', () => {
    expect(hashToken('token-abc')).not.toBe(hashToken('token-abd'))
  })

  test('never contains the token, so a database dump does not yield sessions', () => {
    const t = mintToken()
    expect(hashToken(t)).not.toContain(t)
  })

  test('matches the known SHA-256 vector for the empty string', () => {
    // Pins the algorithm and encoding: a silent switch to base64 or SHA-512
    // would invalidate every stored session hash.
    expect(hashToken('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  test('handles multi-byte UTF-8 deterministically', () => {
    expect(hashToken('日本語-🔐')).toBe(hashToken('日本語-🔐'))
    expect(hashToken('日本語-🔐')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('timingSafeEqualStr', () => {
  test('matches identical strings', () => {
    expect(timingSafeEqualStr('worker-token-abc', 'worker-token-abc')).toBe(true)
  })

  test('rejects strings differing in one character', () => {
    expect(timingSafeEqualStr('worker-token-abc', 'worker-token-abd')).toBe(false)
  })

  test('rejects differing lengths without throwing', () => {
    // node's timingSafeEqual throws on a length mismatch, and this receives
    // attacker-controlled input, so the guard must be present.
    expect(() => timingSafeEqualStr('short', 'much-longer-value')).not.toThrow()
    expect(timingSafeEqualStr('short', 'much-longer-value')).toBe(false)
  })

  test('handles empty strings', () => {
    expect(timingSafeEqualStr('', '')).toBe(true)
    expect(timingSafeEqualStr('', 'x')).toBe(false)
  })

  test('compares full-length hashes correctly', () => {
    const a = hashToken('a')
    expect(timingSafeEqualStr(a, hashToken('a'))).toBe(true)
    expect(timingSafeEqualStr(a, hashToken('b'))).toBe(false)
  })
})
