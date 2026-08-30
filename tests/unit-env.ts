/**
 * Shared environment preamble for the unit suite.
 *
 * Loaded via `bun test --preload`, so it runs BEFORE any test file. This exists
 * because `src/lib/env.ts` parses once at first import and caches the result: the
 * first test file to import it fixed configuration for the entire run, and three
 * files were each setting their own values and hoping to win that race.
 *
 * They disagreed. ENCRYPTION_KEY was set to `alloc(32,1)`, `alloc(32,3)`, and a
 * third constant by different files, so whichever imported env first decided
 * whether crypto's key-rotation test could pass. That is the shape of a suite
 * that goes green or red depending on file ordering.
 *
 * The keys below are the values `tests/unit/crypto.test.ts` needs for its rotation
 * case, so they are load-bearing: v1 payloads use ENCRYPTION_KEY and v0 payloads
 * use ENCRYPTION_KEY_PREVIOUS.
 *
 * `tests/unit/env.test.ts` is unaffected — it deliberately strips process.env and
 * re-imports env with a cache-busting query to test validation itself.
 */

const env = process.env as Record<string, string | undefined>

env.NODE_ENV = 'test'
env.DATABASE_URL =
  'postgresql://instantmail:instantmail@127.0.0.1:5433/instantmail_test?schema=public'
env.APP_URL = 'http://localhost:3000'
env.AUTH_SECRET = 'unit-test-auth-secret-not-a-real-secret'

// 32 bytes each. crypto.test.ts encrypts under the first and expects payloads
// written under the second to still decrypt while being flagged for rotation.
env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64')
env.ENCRYPTION_KEY_PREVIOUS = Buffer.alloc(32, 2).toString('base64')

env.WORKER_AUTH_TOKEN = 'unit-test-worker-token'
env.LOG_LEVEL = 'debug'

// Unit tests must never reach a real provider. 'fake' is asserted rather than
// assumed, since a typo here would mean a test run sends real email.
env.EMAIL_PROVIDER_MODE = 'fake'
