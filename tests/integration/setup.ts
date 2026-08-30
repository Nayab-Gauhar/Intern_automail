import { afterAll, beforeEach } from 'bun:test'
import { Client } from 'pg'

/**
 * Integration-test database lifecycle.
 *
 * Reset strategy is TRUNCATE, not transaction rollback — see
 * docs/architecture/09-deployment-and-testing.md §9.1. Rollback isolation is
 * faster and perfectly isolated, but it cannot test the things that matter most
 * here: the queue's correctness depends on SELECT ... FOR UPDATE SKIP LOCKED
 * across two concurrent connections, and inside one wrapping transaction there
 * is only one connection, so the entire lease mechanism becomes untestable.
 * Nested real transactions also degrade to savepoints, which have different
 * locking and visibility behaviour than the real thing.
 *
 * These tests run against TEST_DATABASE_URL and refuse to touch anything else.
 */

const url = process.env.TEST_DATABASE_URL

if (!url) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests must never run against the dev database.',
  )
}

// A truncating test suite pointed at the wrong database destroys real work, so
// the name is asserted rather than trusted.
if (!/instantmail_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `TEST_DATABASE_URL does not look like a test database: ${url.replace(/:[^:@]*@/, ':***@')}\n` +
      'Refusing to run — this suite truncates every table.',
  )
}

export const testDb = new Client({ connectionString: url })
let connected = false

async function ensureConnected() {
  if (!connected) {
    await testDb.connect()
    connected = true
  }
}

/**
 * Truncate every table, discovered at runtime so a newly added table is covered
 * automatically. A hand-maintained list rots silently and leaves cross-test
 * bleed that looks like a flaky test.
 */
export async function truncateAll() {
  await ensureConnected()

  const { rows } = await testDb.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'`,
  )
  if (rows.length === 0) return

  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ')

  // EmailEvent carries an append-only trigger that rejects DELETE. TRUNCATE is
  // DDL and bypasses row triggers, which is the other reason this is not a
  // DELETE-based reset.
  // RESTART IDENTITY resets sequences so bigserial ids are stable per test;
  // CASCADE removes the need to order 44 tables by dependency.
  await testDb.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
}

beforeEach(truncateAll)

afterAll(async () => {
  if (connected) {
    await testDb.end()
    connected = false
  }
})
