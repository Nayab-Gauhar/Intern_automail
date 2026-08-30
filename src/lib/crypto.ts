import 'server-only'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHash,
} from 'node:crypto'
import { env } from './env'

/**
 * Symmetric encryption for credentials at rest — OAuth refresh tokens and SMTP
 * passwords. AES-256-GCM gives confidentiality and integrity, so a tampered
 * ciphertext fails to decrypt rather than yielding garbage.
 *
 * Stored format (a single string, so it fits one column):
 *
 *   v<keyVersion>.<iv-b64url>.<authTag-b64url>.<ciphertext-b64url>
 *
 * The key version is carried in the payload so rotation is possible without a
 * migration: new writes use the current key, and reads fall back to
 * ENCRYPTION_KEY_PREVIOUS for records not yet re-encrypted.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // 96 bits, the GCM standard
const CURRENT_VERSION = 1
const PREVIOUS_VERSION = 0

function keyFor(version: number): Buffer {
  if (version === CURRENT_VERSION) return Buffer.from(env.ENCRYPTION_KEY, 'base64')
  if (version === PREVIOUS_VERSION && env.ENCRYPTION_KEY_PREVIOUS) {
    return Buffer.from(env.ENCRYPTION_KEY_PREVIOUS, 'base64')
  }
  throw new Error(`No encryption key available for version ${version}`)
}

const b64u = (b: Buffer) => b.toString('base64url')
const fromB64u = (s: string) => Buffer.from(s, 'base64url')

/** Encrypt a UTF-8 secret. A fresh random IV is generated per call — never reused. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keyFor(CURRENT_VERSION), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return `v${CURRENT_VERSION}.${b64u(iv)}.${b64u(authTag)}.${b64u(ciphertext)}`
}

/**
 * Decrypt a payload produced by encrypt(). Throws on tampering, a wrong key, or
 * a malformed payload — callers must treat a failure as "credential unusable"
 * and mark the mailbox disconnected rather than retrying.
 */
export function decrypt(payload: string): string {
  const parts = payload.split('.')
  if (parts.length !== 4) throw new Error('Malformed encrypted payload')

  const [versionTag, ivB64, tagB64, dataB64] = parts as [string, string, string, string]
  if (!versionTag.startsWith('v')) throw new Error('Malformed encrypted payload: missing version')

  const version = Number.parseInt(versionTag.slice(1), 10)
  if (!Number.isInteger(version)) throw new Error('Malformed encrypted payload: bad version')

  const decipher = createDecipheriv(ALGORITHM, keyFor(version), fromB64u(ivB64))
  decipher.setAuthTag(fromB64u(tagB64))

  return Buffer.concat([decipher.update(fromB64u(dataB64)), decipher.final()]).toString('utf8')
}

/** True when a payload was written with a superseded key and should be re-encrypted. */
export function needsRotation(payload: string): boolean {
  return !payload.startsWith(`v${CURRENT_VERSION}.`)
}

/**
 * Hash a session or single-use token for storage. Session tokens are already
 * 256 bits of entropy, so a fast hash is correct here — SHA-256 protects a
 * leaked database dump without adding per-request cost. Passwords are different
 * and use argon2id via Bun.password.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/** A cryptographically random, URL-safe token. 32 bytes = 256 bits. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * Constant-time comparison, safe for secrets. Length is compared first via a
 * fixed-size digest so differing lengths do not leak through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}
