/**
 * The worker process.
 *
 * Campaigns must run with no browser open (product invariant 1), so sending is
 * driven by this standalone process rather than any client-side timer. It is
 * deployed as its own service: `bun run worker`.
 *
 * SCOPE TODAY: the process lifecycle only — heartbeat registration, the poll
 * loop, and graceful shutdown. **No job handlers are registered yet.** The queue
 * itself (SKIP LOCKED leasing, per-mailbox pacing, the send path, reconciliation)
 * is Phase 6, specified in docs/architecture/06-jobs-and-sending-engine.md.
 *
 * This file exists now rather than later because `package.json` already exposes
 * `bun run worker`, and a script that silently does nothing is worse than one
 * that says what it does not yet do. It leases nothing, so it cannot send
 * anything or mutate a job.
 */
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { Client } from 'pg'

// Signals to lib/db.ts that this process wants worker-shaped pool sizing.
process.env.INSTANT_MAIL_PROCESS = 'worker'

const POLL_INTERVAL_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 15_000

/** "<hostname>:<pid>:<random>" — the same shape written to Job.lockedBy, so a stuck job traces to a process. */
const workerId = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`

const log = (event: string, extra: Record<string, unknown> = {}) => {
  // Structured, one JSON object per line, matching src/lib/logger.ts's shape.
  console.warn(
    JSON.stringify({ level: 'info', event, at: new Date().toISOString(), workerId, ...extra }),
  )
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'worker.start_failed',
      reason: 'DATABASE_URL is not set',
    }),
  )
  process.exit(2)
}

const db = new Client({ connectionString: url })

let running = true
// A holder object rather than a `let`: shutdown() closes over it, and this keeps
// the binding const without a temporal-dead-zone hazard.
const timers: { heartbeat?: ReturnType<typeof setInterval> } = {}

async function registerHeartbeat() {
  await db.query(
    `INSERT INTO "WorkerHeartbeat" (id, hostname, pid, version, "leasedCount", "startedAt", "lastSeenAt")
     VALUES ($1, $2, $3, $4, 0, now(), now())
     ON CONFLICT (id) DO UPDATE SET "lastSeenAt" = now(), "stoppedAt" = NULL`,
    [workerId, hostname(), process.pid, process.env.GIT_SHA ?? null],
  )
}

async function touchHeartbeat(leasedCount: number) {
  // A row whose lastSeenAt goes stale with no stoppedAt died hard — which is
  // exactly the case lease reclamation exists for.
  await db.query(
    `UPDATE "WorkerHeartbeat" SET "lastSeenAt" = now(), "leasedCount" = $2 WHERE id = $1`,
    [workerId, leasedCount],
  )
}

async function markStopped() {
  await db.query(
    `UPDATE "WorkerHeartbeat" SET "stoppedAt" = now(), "leasedCount" = 0 WHERE id = $1`,
    [workerId],
  )
}

/**
 * One poll tick. Deliberately does not lease: with no handlers registered,
 * leasing a job would flip it to RUNNING and then abandon it until the lease
 * expired — worse than not polling at all.
 */
async function tick(): Promise<number> {
  const { rows } = await db.query<{ pending: string; oldest: string | null }>(
    `SELECT count(*)::text AS pending,
            to_char(min("runAt"), 'YYYY-MM-DD"T"HH24:MI:SSZ') AS oldest
       FROM "Job"
      WHERE state IN ('PENDING', 'RETRYING') AND "runAt" <= now()`,
  )
  const pending = Number(rows[0]?.pending ?? 0)

  if (pending > 0) {
    log('worker.jobs_pending_no_handlers', {
      pending,
      oldestRunAt: rows[0]?.oldest ?? null,
      note: 'no job handlers registered yet (phase 6) — these jobs are untouched, not lost',
    })
  }
  return pending
}

async function shutdown(signal: string) {
  if (!running) return
  running = false
  log('worker.shutdown_started', { signal })

  if (timers.heartbeat) clearInterval(timers.heartbeat)
  try {
    await markStopped()
  } catch {
    // A failed heartbeat update must not stop us closing the pool.
  }
  await db.end().catch(() => {})
  log('worker.shutdown_complete', { signal })
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await db.connect()
await registerHeartbeat()
log('worker.started', {
  pollIntervalMs: POLL_INTERVAL_MS,
  handlersRegistered: 0,
  note: 'lifecycle only; the queue lands in phase 6',
})

timers.heartbeat = setInterval(() => {
  void touchHeartbeat(0).catch((e: unknown) => {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'worker.heartbeat_failed',
        workerId,
        error: String(e),
      }),
    )
  })
}, HEARTBEAT_INTERVAL_MS)

while (running) {
  try {
    await tick()
  } catch (e) {
    console.error(
      JSON.stringify({ level: 'error', event: 'worker.tick_failed', workerId, error: String(e) }),
    )
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
}
