import { describe, expect, test, beforeAll } from 'bun:test'

/**
 * Crypto tests. These pin the guarantees that protect mailbox credentials at
 * rest: a tampered ciphertext must fail rather than decrypt to garbage, and a
 * key rotation must not orphan existing records.
 *
 * Env is set before importing the module under test, because src/lib/env.ts
 * validates at module load.
 */

const CURRENT_KEY = Buffer.alloc(32, 1).toString('base64')
const PREVIOUS_KEY = Buffer.alloc(32, 2).toString('base64')

let encrypt: (s: string) => string
let decrypt: (s: string) => string
let needsRotation: (s: string) => boolean
let hashToken: (s: string) => string
let generateToken: (n?: number) => string
let safeEqual: (a: string, b: string) => boolean

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5433/db?schema=public'
  process.env.APP_URL = 'http://localhost:3000'
  process.env.AUTH_SECRET = 'x'.repeat(32)
  process.env.ENCRYPTION_KEY = CURRENT_KEY
  process.env.ENCRYPTION_KEY_PREVIOUS = PREVIOUS_KEY
  process.env.WORKER_AUTH_TOKEN = 'y'.repeat(16)

  const mod = await import('../../src/lib/crypto')
  ;({ encrypt, decrypt, needsRotation, hashToken, generateToken, safeEqual } = mod)
})

describe('encrypt / decrypt round trip', () => {
  test('recovers the original plaintext', () => {
    const secret = '1//0gL9xR-refresh-token-example'
    expect(decrypt(encrypt(secret))).toBe(secret)
  })

  test('handles an empty string', () => {
    expect(decrypt(encrypt(''))).toBe('')
  })

  test('handles multi-byte UTF-8 without corruption', () => {
    // A refresh token is ASCII, but SMTP passwords are user-supplied and may not be.
    const secret = 'pässwörd–日本語–🔐–ñ'
    expect(decrypt(encrypt(secret))).toBe(secret)
  })

  test('handles a long value beyond a single cipher block', () => {
    const secret = 'a'.repeat(10_000)
    expect(decrypt(encrypt(secret))).toBe(secret)
  })

  test('produces a different ciphertext each time for the same input', () => {
    // A fresh random IV per call. Identical ciphertexts would leak that two
    // mailboxes share a credential.
    const secret = 'same-input'
    expect(encrypt(secret)).not.toBe(encrypt(secret))
  })

  test('never leaks the plaintext into the stored payload', () => {
    const secret = 'super-secret-refresh-token'
    expect(encrypt(secret)).not.toContain(secret)
  })
})

describe('payload format', () => {
  test('is four dot-separated parts tagged with the key version', () => {
    const parts = encrypt('x').split('.')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
  })

  test('is url-safe so it survives logs, URLs and headers unescaped', () => {
    // base64url only: no +, /, or = padding.
    expect(encrypt('some value with +/= chars')).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]*$/)
  })
})

describe('tamper detection (this is what GCM buys us)', () => {
  test('rejects a modified ciphertext instead of returning garbage', () => {
    const parts = encrypt('original-secret').split('.')
    const data = parts[3]!
    // Flip one character of the ciphertext.
    const flipped = (data[0] === 'A' ? 'B' : 'A') + data.slice(1)
    expect(() => decrypt(`${parts[0]}.${parts[1]}.${parts[2]}.${flipped}`)).toThrow()
  })

  test('rejects a modified auth tag', () => {
    const p = encrypt('original-secret').split('.')
    const tag = p[2]!
    const flipped = (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1)
    expect(() => decrypt(`${p[0]}.${p[1]}.${flipped}.${p[3]}`)).toThrow()
  })

  test('rejects a swapped IV', () => {
    const a = encrypt('secret-a').split('.')
    const b = encrypt('secret-b').split('.')
    expect(() => decrypt(`${a[0]}.${b[1]}.${a[2]}.${a[3]}`)).toThrow()
  })

  test.each([
    ['empty', ''],
    ['not delimited', 'garbage'],
    ['too few parts', 'v1.aaa.bbb'],
    ['too many parts', 'v1.aaa.bbb.ccc.ddd'],
    ['missing version prefix', '1.aaa.bbb.ccc'],
    ['non-numeric version', 'vX.aaa.bbb.ccc'],
  ])('rejects a malformed payload: %s', (_label, payload) => {
    expect(() => decrypt(payload)).toThrow()
  })

  test('rejects an unknown future key version rather than guessing', () => {
    const p = encrypt('secret').split('.')
    expect(() => decrypt(`v99.${p[1]}.${p[2]}.${p[3]}`)).toThrow()
  })
})

describe('key rotation', () => {
  test('current-key payloads do not need rotation', () => {
    expect(needsRotation(encrypt('x'))).toBe(false)
  })

  test('a previous-key payload is flagged for rotation', () => {
    // v0 denotes ENCRYPTION_KEY_PREVIOUS.
    expect(needsRotation('v0.aaa.bbb.ccc')).toBe(true)
  })

  test('a payload written under the previous key still decrypts', async () => {
    // Simulate a rotation: encrypt while key A is current, then make A the
    // previous key and B current. The old record must remain readable, or
    // rotating the key would lock every mailbox out.
    const dir = await import('node:crypto')
    const iv = dir.randomBytes(12)
    const cipher = dir.createCipheriv(ALGO, Buffer.from(PREVIOUS_KEY, 'base64'), iv)
    const ct = Buffer.concat([cipher.update('legacy-secret', 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const legacy = `v0.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`

    expect(decrypt(legacy)).toBe('legacy-secret')
    expect(needsRotation(legacy)).toBe(true)
  })
})

const ALGO = 'aes-256-gcm'

describe('hashToken', () => {
  test('is deterministic', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
  })

  test('differs for different inputs', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'))
  })

  test('does not contain the input', () => {
    expect(hashToken('session-token-value')).not.toContain('session-token-value')
  })

  test('is url-safe and fixed length', () => {
    const h = hashToken(generateToken())
    expect(h).toMatch(/^[\w-]+$/)
    expect(h).toHaveLength(43) // 32 bytes, base64url, unpadded
  })
})

describe('generateToken', () => {
  test('is url-safe', () => {
    expect(generateToken()).toMatch(/^[\w-]+$/)
  })

  test('yields 256 bits by default', () => {
    expect(Buffer.from(generateToken(), 'base64url')).toHaveLength(32)
  })

  test('respects an explicit byte length', () => {
    expect(Buffer.from(generateToken(16), 'base64url')).toHaveLength(16)
  })

  test('does not repeat across many calls', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateToken()))
    expect(seen.size).toBe(1000)
  })
})

describe('safeEqual', () => {
  test('matches identical strings', () => {
    expect(safeEqual('token-abc', 'token-abc')).toBe(true)
  })

  test('rejects different strings', () => {
    expect(safeEqual('token-abc', 'token-abd')).toBe(false)
  })

  test('rejects strings of differing length without throwing', () => {
    // A raw timingSafeEqual throws on a length mismatch; ours must not, since
    // attacker-controlled input reaches it.
    expect(safeEqual('short', 'much-longer-value')).toBe(false)
  })

  test('handles empty strings', () => {
    expect(safeEqual('', '')).toBe(true)
    expect(safeEqual('', 'x')).toBe(false)
  })
})
