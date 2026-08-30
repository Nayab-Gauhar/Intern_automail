/**
 * Verifies that the hand-written database objects still exist.
 *
 * prisma/migrations/20260830212002_init/migration.sql ends with eight objects
 * Prisma's schema language cannot express. Because Prisma diffs against
 * schema.prisma alone, it cannot see them and every `prisma migrate diff`
 * proposes DROPping them — see docs/architecture/INTEGRATION-NOTES.md §11.
 *
 * Losing one of these produces no error. It produces a sequential scan on the
 * inbox, an unenforced business rule, or silently rewritable analytics history.
 * So we assert them in CI rather than trusting a reviewer to catch the DROP.
 *
 * Usage: bun run scripts/verify-db-objects.ts
 */
import { Client } from 'pg'

type Expected = { name: string; why: string; check: 'index' | 'trigger'; predicate?: string }

const EXPECTED: Expected[] = [
  {
    name: 'ScheduledEmail_due_idx',
    check: 'index',
    predicate: "state = 'SCHEDULED'",
    why: "the scheduler's due-scan; SENT rows dominate the table forever",
  },
  {
    name: 'Job_leasable_idx',
    check: 'index',
    predicate: 'state = ANY',
    why: 'the queue lease path; SUCCEEDED rows accumulate between sweeps',
  },
  {
    name: 'WorkspaceInvite_pending_unique',
    check: 'index',
    predicate: "status = 'PENDING'",
    why: 'sole enforcement of one live invite per email per workspace',
  },
  {
    name: 'Experiment_live_per_step_unique',
    check: 'index',
    predicate: 'endedAt IS NULL',
    why: 'sole enforcement of one live experiment per sequence step',
  },
  {
    name: 'WarmupPoolMember_emailAccount_unique',
    check: 'index',
    why: 'sole enforcement of one warmup pool per mailbox',
  },
  {
    name: 'EmailMessage_references_gin',
    check: 'index',
    predicate: 'gin',
    why: 'reply attribution by RFC822 References without a sequential scan',
  },
  {
    name: 'EmailThread_participants_gin',
    check: 'index',
    predicate: 'gin',
    why: 'inbox participant filter without joining EmailMessage',
  },
  {
    name: 'EmailEvent_no_update',
    check: 'trigger',
    why: 'EmailEvent UPDATE is never permitted — a recorded fact must not be edited',
  },
  {
    name: 'EmailEvent_no_delete',
    check: 'trigger',
    why: 'EmailEvent DELETE is blocked except in a transaction that opts into the purge',
  },
]

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(2)
}

const client = new Client({ connectionString: url })
const failures: string[] = []

try {
  await client.connect()

  for (const obj of EXPECTED) {
    if (obj.check === 'trigger') {
      const { rows } = await client.query('select tgname from pg_trigger where tgname = $1', [
        obj.name,
      ])
      if (rows.length === 0) failures.push(`MISSING trigger ${obj.name} — ${obj.why}`)
      continue
    }

    const { rows } = await client.query<{ indexdef: string }>(
      'select indexdef from pg_indexes where indexname = $1',
      [obj.name],
    )

    if (rows.length === 0) {
      failures.push(`MISSING index ${obj.name} — ${obj.why}`)
      continue
    }

    // Presence is not enough: an index recreated without its WHERE clause or as
    // a btree instead of GIN would pass a name check while losing the property
    // we wanted.
    // Postgres renders identifiers quoted -- WHERE ("endedAt" IS NULL) -- so
    // strip quotes and collapse whitespace before matching.
    const def = rows[0]!.indexdef
    const normalise = (v: string) => v.toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ')
    if (obj.predicate && !normalise(def).includes(normalise(obj.predicate))) {
      failures.push(`DEGRADED index ${obj.name}: expected ${obj.predicate} in\n    ${def}`)
    }
  }

  // The append-only trigger must actually fire, not merely exist.
  const { rows: fn } = await client.query(
    "select proname from pg_proc where proname = 'emailevent_append_only'",
  )
  if (fn.length === 0)
    failures.push('MISSING function emailevent_append_only — the trigger cannot fire')
} finally {
  await client.end()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} hand-written database object(s) missing or degraded:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  console.error(
    '\nThese live in the init migration and cannot be expressed in schema.prisma, so\n' +
      '`prisma migrate diff` proposes dropping them on every run. Check whether a recent\n' +
      'migration contains a DROP it should not. See docs/architecture/INTEGRATION-NOTES.md §11.\n',
  )
  process.exit(1)
}

console.log(`✓ all ${EXPECTED.length} hand-written database objects present and intact`)
