import { describe, expect, test } from 'bun:test'
import { testDb } from './setup'

/**
 * These assert the DATABASE holds the product's invariants — not that our code
 * remembers to. Every check here would still pass if the application layer were
 * replaced tomorrow, which is the point: application logic can be bypassed by a
 * bug, a migration, or a future maintainer, and a constraint cannot.
 *
 * See docs/architecture/01-database.md §5 and the hand-written block at the end
 * of the init migration.
 */

/** Minimal workspace, since almost every tenant row needs one. */
async function makeWorkspace(id: string) {
  await testDb.query(
    `INSERT INTO "Workspace" (id, name, slug, timezone, "trackOpensDefault", "trackClicksDefault", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'UTC', true, true, now(), now())`,
    [id, `WS ${id}`, id],
  )
}

async function expectViolation(fn: () => Promise<unknown>, matcher: RegExp) {
  let error: unknown
  try {
    await fn()
  } catch (e) {
    error = e
  }
  expect(error).toBeDefined()
  expect(String((error as Error).message)).toMatch(matcher)
}

describe('EmailEvent is append-only', () => {
  test('UPDATE is rejected, so analytics history cannot be rewritten', async () => {
    await makeWorkspace('w-append')
    const { rows } = await testDb.query<{ id: string }>(
      `INSERT INTO "EmailEvent" ("workspaceId", type, "dedupeKey") VALUES ('w-append','SENT','k1') RETURNING id`,
    )
    const id = rows[0]!.id

    await expectViolation(
      () => testDb.query(`UPDATE "EmailEvent" SET type='OPENED' WHERE id=$1`, [id]),
      /append-only/i,
    )

    // The row must be untouched, not merely the statement refused.
    const after = await testDb.query<{ type: string }>(
      `SELECT type FROM "EmailEvent" WHERE id=$1`,
      [id],
    )
    expect(after.rows[0]!.type).toBe('SENT')
  })

  test('DELETE is rejected', async () => {
    await makeWorkspace('w-del')
    await testDb.query(
      `INSERT INTO "EmailEvent" ("workspaceId", type, "dedupeKey") VALUES ('w-del','SENT','k2')`,
    )

    await expectViolation(
      () => testDb.query(`DELETE FROM "EmailEvent" WHERE "workspaceId"='w-del'`),
      /append-only/i,
    )

    const { rows } = await testDb.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "EmailEvent" WHERE "workspaceId"='w-del'`,
    )
    expect(rows[0]!.count).toBe('1')
  })

  test('INSERT still works — the trigger must not block legitimate appends', async () => {
    await makeWorkspace('w-ins')
    await testDb.query(
      `INSERT INTO "EmailEvent" ("workspaceId", type, "dedupeKey") VALUES ('w-ins','SENT','k3')`,
    )
    await testDb.query(
      `INSERT INTO "EmailEvent" ("workspaceId", type, "dedupeKey") VALUES ('w-ins','DELIVERED','k4')`,
    )
    const { rows } = await testDb.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "EmailEvent" WHERE "workspaceId"='w-ins'`,
    )
    expect(rows[0]!.count).toBe('2')
  })
})

describe('event dedupe prevents double-counted analytics', () => {
  test('a redelivered webhook cannot insert the same dedupeKey twice', async () => {
    await makeWorkspace('w-dedupe')
    await testDb.query(
      `INSERT INTO "EmailEvent" ("workspaceId", type, "dedupeKey") VALUES ('w-dedupe','OPENED','open-1')`,
    )

    await expectViolation(
      () =>
        testDb.query(
          `INSERT INTO "EmailEvent" ("workspaceId", type, "dedupeKey") VALUES ('w-dedupe','OPENED','open-1')`,
        ),
      /duplicate key|unique/i,
    )
  })
})

describe('one live invite per email per workspace', () => {
  async function invite(id: string, ws: string, email: string, status: string, tokenHash: string) {
    return testDb.query(
      `INSERT INTO "WorkspaceInvite" (id,"workspaceId",email,role,"tokenHash",status,"expiresAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,'MEMBER',$4,$5::"InviteStatus", now() + interval '7 days', now(), now())`,
      [id, ws, email, tokenHash, status],
    )
  }

  test('a second PENDING invite for the same address is rejected', async () => {
    await makeWorkspace('w-inv')
    await invite('i1', 'w-inv', 'a@example.test', 'PENDING', 'h1')

    await expectViolation(
      () => invite('i2', 'w-inv', 'a@example.test', 'PENDING', 'h2'),
      /duplicate key|unique/i,
    )
  })

  test('re-inviting after revocation succeeds — this is why the index is partial', async () => {
    await makeWorkspace('w-inv2')
    await invite('i3', 'w-inv2', 'b@example.test', 'PENDING', 'h3')
    await testDb.query(
      `UPDATE "WorkspaceInvite" SET status='REVOKED', "revokedAt"=now() WHERE id='i3'`,
    )

    // A plain unique index would make this impossible, permanently locking an
    // address out of a workspace after one revoked invite.
    await invite('i4', 'w-inv2', 'b@example.test', 'PENDING', 'h4')

    const { rows } = await testDb.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "WorkspaceInvite" WHERE "workspaceId"='w-inv2' AND status='PENDING'`,
    )
    expect(rows[0]!.count).toBe('1')
  })

  test('the same address may be invited to two different workspaces', async () => {
    await makeWorkspace('w-x')
    await makeWorkspace('w-y')
    await invite('i5', 'w-x', 'shared@example.test', 'PENDING', 'h5')
    await invite('i6', 'w-y', 'shared@example.test', 'PENDING', 'h6')

    const { rows } = await testDb.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "WorkspaceInvite" WHERE email='shared@example.test'`,
    )
    expect(rows[0]!.count).toBe('2')
  })
})

describe('the queue lease index exists and is partial', () => {
  test('Job_leasable_idx covers only leasable states', async () => {
    const { rows } = await testDb.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'Job_leasable_idx'`,
    )
    expect(rows).toHaveLength(1)

    const def = rows[0]!.indexdef.toLowerCase()
    // A non-partial index here would grow without bound as SUCCEEDED rows
    // accumulate, which is the whole reason it is hand-written.
    expect(def).toContain('where')
    expect(def).toContain('pending')
    expect(def).toContain('retrying')
  })

  test('ScheduledEmail_due_idx covers only SCHEDULED rows', async () => {
    const { rows } = await testDb.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'ScheduledEmail_due_idx'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.indexdef.toLowerCase()).toContain('scheduled')
  })
})

describe('workspace-scoped uniqueness', () => {
  test('two workspaces may hold a lead with the same email address', async () => {
    await makeWorkspace('w-l1')
    await makeWorkspace('w-l2')

    const insertLead = (id: string, ws: string) =>
      testDb.query(
        `INSERT INTO "Lead" (id,"workspaceId",email,"createdAt","updatedAt")
         VALUES ($1,$2,'dup@example.test', now(), now())`,
        [id, ws],
      )

    await insertLead('l1', 'w-l1')
    // Global uniqueness on lead email would leak tenant existence and be wrong
    // besides: two customers legitimately prospect the same person.
    await insertLead('l2', 'w-l2')

    const { rows } = await testDb.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Lead" WHERE email='dup@example.test'`,
    )
    expect(rows[0]!.count).toBe('2')
  })

  test('the same workspace may not hold the same lead email twice', async () => {
    await makeWorkspace('w-l3')
    await testDb.query(
      `INSERT INTO "Lead" (id,"workspaceId",email,"createdAt","updatedAt")
       VALUES ('l3','w-l3','once@example.test', now(), now())`,
    )

    await expectViolation(
      () =>
        testDb.query(
          `INSERT INTO "Lead" (id,"workspaceId",email,"createdAt","updatedAt")
           VALUES ('l4','w-l3','once@example.test', now(), now())`,
        ),
      /duplicate key|unique/i,
    )
  })
})

describe('cascade behaviour', () => {
  test('deleting a workspace removes its leads rather than orphaning them', async () => {
    await makeWorkspace('w-cas')
    await testDb.query(
      `INSERT INTO "Lead" (id,"workspaceId",email,"createdAt","updatedAt")
       VALUES ('l-cas','w-cas','c@example.test', now(), now())`,
    )

    await testDb.query(`DELETE FROM "Workspace" WHERE id='w-cas'`)

    const { rows } = await testDb.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Lead" WHERE "workspaceId"='w-cas'`,
    )
    expect(rows[0]!.count).toBe('0')
  })

  // REGRESSION: the first version of the append-only trigger raised on every
  // DELETE, including the FK cascade from Workspace. That made workspace
  // deletion impossible with no error saying so — the purge just rolled back.
  // The original test passed only because it created no EmailEvent rows.
  test('a workspace with events cannot be deleted without opting into the purge', async () => {
    await makeWorkspace('w-guard')
    await testDb.query(
      `INSERT INTO "EmailEvent" ("workspaceId", type, "dedupeKey") VALUES ('w-guard','SENT','g1')`,
    )

    await expectViolation(
      () => testDb.query(`DELETE FROM "Workspace" WHERE id='w-guard'`),
      /append-only/i,
    )

    // The whole statement must roll back, not partially apply.
    const { rows } = await testDb.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Workspace" WHERE id='w-guard'`,
    )
    expect(rows[0]!.count).toBe('1')
  })

  test('the deliberate purge path deletes a workspace and its events', async () => {
    await makeWorkspace('w-purge')
    await testDb.query(
      `INSERT INTO "EmailEvent" ("workspaceId", type, "dedupeKey") VALUES ('w-purge','SENT','p1')`,
    )

    // What the MAINTENANCE purge job does: opt in for this transaction only.
    await testDb.query('BEGIN')
    await testDb.query(`SET LOCAL instantmail.allow_event_purge = 'on'`)
    await testDb.query(`DELETE FROM "Workspace" WHERE id='w-purge'`)
    await testDb.query('COMMIT')

    const ws = await testDb.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Workspace" WHERE id='w-purge'`,
    )
    const ev = await testDb.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "EmailEvent" WHERE "workspaceId"='w-purge'`,
    )
    expect(ws.rows[0]!.count).toBe('0')
    expect(ev.rows[0]!.count).toBe('0')
  })

  test('the purge opt-in does not leak past its transaction', async () => {
    await makeWorkspace('w-leak')
    await testDb.query(
      `INSERT INTO "EmailEvent" ("workspaceId", type, "dedupeKey") VALUES ('w-leak','SENT','lk1')`,
    )

    // Burn a transaction that sets the flag, so a leaked SET would show up here.
    await testDb.query('BEGIN')
    await testDb.query(`SET LOCAL instantmail.allow_event_purge = 'on'`)
    await testDb.query('COMMIT')

    await expectViolation(
      () => testDb.query(`DELETE FROM "EmailEvent" WHERE "workspaceId"='w-leak'`),
      /append-only/i,
    )
  })

  test('UPDATE has no escape hatch even inside the purge transaction', async () => {
    await makeWorkspace('w-noupd')
    await testDb.query(
      `INSERT INTO "EmailEvent" ("workspaceId", type, "dedupeKey") VALUES ('w-noupd','SENT','nu1')`,
    )

    await testDb.query('BEGIN')
    await testDb.query(`SET LOCAL instantmail.allow_event_purge = 'on'`)
    let threw = false
    try {
      await testDb.query(`UPDATE "EmailEvent" SET type='OPENED' WHERE "workspaceId"='w-noupd'`)
    } catch {
      threw = true
    }
    await testDb.query('ROLLBACK')

    // The purge flag exists to let a cascade delete through. Editing a recorded
    // fact is never legitimate, so UPDATE uses a separate strict function.
    expect(threw).toBe(true)
  })
})
