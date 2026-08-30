import { Client } from 'pg'

/**
 * Clears rate-limit counters before an E2E run.
 *
 * The login limiter is real: 10 attempts per IP and 5 per email address in a
 * 15-minute window. The suite deliberately performs both a failed and a
 * successful login, so running it three or four times in a row exhausts those
 * counters and the sign-in test starts failing — the limiter doing its job, but
 * indistinguishable from a broken login unless you check the table.
 *
 * Resetting is safe: RateLimit is ephemeral by design. Rows are keyed by window
 * and a MAINTENANCE job deletes closed ones, so nothing durable is lost. This
 * clears counters ONLY — the limiter itself stays enabled, so a test asserting
 * that the limit engages still can.
 */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set; E2E needs a seeded database')

  const db = new Client({ connectionString: url })
  try {
    await db.connect()
    const { rowCount } = await db.query('DELETE FROM "RateLimit"')

    // Clear the login lock too. Repeated failed-login tests can trip the account
    // lock, which outlives the rate-limit window and would fail the sign-in test
    // for a different reason.
    await db.query(
      'UPDATE "User" SET "failedLoginCount" = 0, "lockedUntil" = NULL WHERE "lockedUntil" IS NOT NULL OR "failedLoginCount" > 0',
    )

    console.warn(`[e2e setup] cleared ${rowCount ?? 0} rate-limit rows and reset login locks`)
  } finally {
    await db.end()
  }
}
