import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Opaque token minting, hashing, and comparison.
 *
 * Deliberately NOT marked `server-only`, unlike crypto.ts: this module reads no
 * secrets and holds no key material, so tests can import it directly without
 * resolving the react-server export condition. Everything here is pure.
 *
 * Used for session cookies, password-reset tokens, invite tokens, and OAuth
 * state — anywhere we need an unguessable value that is stored only as a hash.
 */

/** 256 bits of CSPRNG entropy, base64url: 43 chars, no padding, cookie-safe. */
export function mintToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * The ONLY form of a token that ever touches the database. Returns 64 hex
 * characters, matching the `Session.tokenHash` column contract.
 *
 * Plain SHA-256 rather than argon2: the input is 256 bits of uniform CSPRNG
 * output, so there is no dictionary to attack and a slow KDF would add latency
 * to every authenticated request for no gain. Not HMAC either — keying this to
 * AUTH_SECRET would tie session validity to a rotatable secret, and rotating it
 * must not log everyone out.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Constant-time string comparison.
 *
 * For comparing against a *stored* secret — WORKER_AUTH_TOKEN, the Pub/Sub
 * verification token. Session lookup does not need this: it is a unique-index
 * probe on a hash derived from the attacker's own input, so there is no stored
 * secret to time against.
 *
 * Length mismatch returns false rather than throwing, because the inputs are
 * attacker-controlled and a raw timingSafeEqual throws on unequal lengths. The
 * length of a token is not the secret.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
