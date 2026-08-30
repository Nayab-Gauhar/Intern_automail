# 09 — Deployment, Environments, Observability & Testing

> **Status:** design. Subordinate to `00-product-brief.md`; where this document
> and the brief disagree, the brief wins and this document is wrong.
>
> **Owns:** deployment topology, the environment matrix, typed env validation,
> database operations, secrets handling, logging/metrics/health, incident
> runbooks, `package.json` scripts, the test pyramid, and CI.
>
> **Depends on (and must stay consistent with):** `02-data-model` (table and
> column names), `05-mailboxes-and-providers` (the `MailProvider` interface),
> `06-sending-engine-and-jobs` (the `Job` table, lease semantics), `07-replies`.
> Where this document names a column that a sibling doc renames, the *metric or
> check definition* is the contract and the SQL is adapted. Open items are
> collected in §13.

---

## 1. The shape of the deployed system

Three long-lived things, and nothing else:

```
                       ┌───────────────────────────────────────┐
   browser ── HTTPS ──▶│  WEB  (Next.js, App Router)           │
                       │  pages · server actions · route        │
                       │  handlers · /api/oauth · /api/webhooks │
                       └──────────────┬────────────────────────┘
                                      │ Prisma (pool A)
                                      ▼
                       ┌───────────────────────────────────────┐
                       │  POSTGRES 16                          │
                       │  domain tables + Job queue +          │
                       │  EmailEvent fact log                  │
                       └──────────────▲────────────────────────┘
                                      │ Prisma (pool B)
                       ┌──────────────┴────────────────────────┐
   Gmail API ◀─────────│  WORKER  (bun run worker)             │
   Anthropic API ◀─────│  scheduler tick · lease · send · sync  │
                       │  lease-expiry sweep · heartbeat        │
                       └───────────────────────────────────────┘
```

The web process is stateless and horizontally scalable. Postgres is the only
stateful component and the only source of truth — including for the queue
(brief §5). The worker holds no state either; everything it is doing is visible
in `Job` rows, so killing it mid-flight loses nothing but time.

### 1.1 Why the worker cannot be a serverless function on a normal plan

This is worth being blunt about, because "just put it on Vercel" is the default
assumption and it breaks four requirements at once.

1. **Execution ceiling.** Serverless invocations are capped (commonly 10s on
   hobby tiers, 60–300s on paid, hard-stopped after). Draining a queue,
   refreshing an OAuth token, sending, then writing `EmailEvent` is fine inside
   that budget for *one* job — but the worker's job is to keep doing that,
   forever, while respecting per-mailbox pacing. A process that is killed every
   60 seconds cannot hold a pacing timer.
2. **Leases need a live holder.** `SELECT … FOR UPDATE SKIP LOCKED` hands a job
   to a worker with a `leaseExpiresAt`. The worker renews the lease while it
   works. A function that is frozen or terminated mid-send leaves a lease that
   expires and the job is retried — which is *safe* (idempotency keys, brief
   §5) but wasteful, and the retry may hit a Gmail send that already succeeded
   but whose `EmailEvent` write never committed. Every extra unplanned kill is
   another chance to walk that window.
3. **No background work after the response.** Serverless runtimes freeze the
   sandbox once the HTTP response is returned. Anything the worker wants to do
   "after replying to the cron" does not happen.
4. **Cron granularity and concurrency.** Platform crons are typically
   minute-granularity with a small per-plan quota (Vercel Hobby: one cron, once
   a day). Our scheduler wants a tick every 15–60 seconds, and Gmail sync wants
   one per connected mailbox.

None of this makes serverless *impossible* — it makes it a degraded mode. Which
is exactly topology B.

### 1.2 Topology A — container platform running web **and** worker (recommended)

Railway / Fly.io / Render / Hetzner+systemd / any PaaS that runs a long-lived
process. Two services from one repo and one image, plus managed Postgres.

```
┌──────────────── platform project ────────────────┐
│                                                   │
│  service: web        start: bun run start         │
│    replicas 1–N      health: GET /api/health      │
│    port 3000         public domain                │
│                                                   │
│  service: worker     start: bun run worker        │
│    replicas 1        health: heartbeat row        │
│    no public port    restart: always              │
│                                                   │
│  release step (runs once, before both):           │
│    bunx prisma migrate deploy                     │
│                                                   │
│  attached: Postgres 16  (managed, backed up)      │
└───────────────────────────────────────────────────┘
```

- **One image, two commands.** `Dockerfile` (or platform buildpack) produces a
  single artifact; the two services differ only by start command. This keeps
  web and worker on the same code and the same Prisma client, which matters
  because they share the schema.
- **Worker replicas: 1 to start.** The queue is correct with N workers
  (SKIP LOCKED + idempotency keys), but per-mailbox pacing is simplest to
  reason about with one. Scale to 2 only after the concurrent-lease integration
  test (§9.4) is green in CI and per-mailbox rate limiting is enforced in the
  database rather than in process memory.
- **Web replicas: as needed.** Web is stateless.

### 1.3 Topology B — serverless web + external cron driving `/api/worker/tick`

```
Vercel/Netlify (web, serverless)        external scheduler
┌──────────────────────────────┐        ┌────────────────────────┐
│ pages, actions, route        │        │ GitHub Actions cron /   │
│ handlers                     │        │ cron-job.org / EasyCron │
│                              │        │ every 1 min             │
│ POST /api/worker/tick   ◀────┼────────┤ Authorization: Bearer   │
│   Bearer WORKER_AUTH_TOKEN   │        │   WORKER_AUTH_TOKEN     │
│   drains ≤ N jobs, ≤ 50s     │        └────────────────────────┘
└──────────────┬───────────────┘
               │ Prisma via pooler (pgbouncer=true)
               ▼
        Managed Postgres  ◀── DIRECT_DATABASE_URL for migrate deploy
```

`/api/worker/tick` is the same drain loop as the worker, bounded by a deadline:

```ts
// src/app/api/worker/tick/route.ts  (contract only; owned by 06)
export async function POST(req: Request) {
  if (!timingSafeBearerEqual(req.headers.get('authorization'), env.WORKER_AUTH_TOKEN)) {
    return new Response(null, { status: 401 });
  }
  const budgetMs = 50_000;                   // stay under the 60s platform cap
  const result = await drainQueue({ budgetMs, maxJobs: 25 });
  return Response.json(result);              // { leased, succeeded, failed, deferred, ranForMs }
}
```

Constraints that come with topology B, stated plainly:

- **Minute-granularity floor.** Nothing sends sooner than the next tick. Fine
  for cold outreach (units of work are minutes-to-days apart, brief §5),
  fatal for anything wanting sub-minute reaction.
- **Overlapping ticks.** A slow tick still running when the next fires means
  two concurrent drains. Correct (SKIP LOCKED) but it doubles connection use.
  Guard with a Postgres advisory lock at the top of the drain:
  `SELECT pg_try_advisory_xact_lock(hashtext('worker-tick'))` — if false, return
  `202 {"skipped":"already running"}`.
- **Connection pressure.** Every concurrent serverless invocation wants a DB
  connection. A transaction-mode pooler (PgBouncer, Supabase pooler, Neon
  pooler) is **mandatory**, with `?pgbouncer=true` on `DATABASE_URL` and a
  separate `DIRECT_DATABASE_URL` for `prisma migrate deploy` (migrations need a
  session, and DDL through a transaction pooler is a bad time).
- **The cron is now a dependency you do not own.** If the external cron service
  silently stops, campaigns silently stop. The `oldest_pending_job_age` alert
  (§5.5) is not optional in this topology — it is the *only* thing that notices.
- **Gmail `users.watch` renewal.** The Gmail push subscription expires after 7
  days and must be re-armed. In topology B that renewal is just another job, so
  a dead cron eventually kills inbound push too, degrading reply detection to
  whatever polling interval survives.

### 1.4 Recommendation

**Ship topology A.** One long-lived worker on a container platform, one image,
one release step. It costs roughly the same as a serverless plan at our scale,
removes the pooler from the critical path, removes the third-party cron from
the critical path, and lets the worker keep in-process pacing state — which is
the difference between "respects per-mailbox limits" and "hopes the next tick
lands at the right moment."

Keep `/api/worker/tick` implemented and tested anyway. It costs almost nothing
(it calls the same `drainQueue`), it gives operators a manual "drain now" lever
during an incident, and it is the escape hatch if we ever have to deploy
somewhere that only does serverless.

| | A: container web + worker | B: serverless web + cron tick |
|---|---|---|
| Latency floor | seconds (poll interval) | 1 minute (cron granularity) |
| Pacing state | in process, exact | must be re-derived from DB each tick |
| Lease renewal | yes, long-lived holder | no; leases expire on freeze |
| Pooler required | no | yes (PgBouncer/transaction mode) |
| External deps | platform only | platform + cron provider |
| Scale-to-zero cost saving | no | yes |
| Ops surface | 2 services, 1 image | 1 service + a cron URL to babysit |
| Failure mode if scheduler dies | worker restarts itself | campaigns stop, silently |
| Gmail watch renewal | reliable | dies with the cron |

---

## 2. Environments

Three, and no more. A fourth ("staging") is deliberately deferred: with
forward-only migrations, expand/contract discipline, and a restore-tested
backup, a staging tier buys less than it costs to keep honest. Revisit when
there is a paying customer to protect.

| | **local** | **test** | **production** |
|---|---|---|---|
| Who runs it | the developer | `bun test` + CI | the platform |
| Postgres | user-space cluster, port **5433**, `scripts/db.sh` | database `instantmail_test` on the same cluster; in CI, a `postgres:16` service | managed Postgres 16 |
| Schema origin | `prisma migrate dev` | `prisma migrate reset --force` — **from scratch, every run** | `prisma migrate deploy` |
| Data | hand-seeded via `prisma/seed.ts` | factories per test; truncated between tests | real |
| Worker | `bun run worker` in a second terminal | not running; tests call `drainQueue()` directly | its own service |
| Providers | Gmail sandbox OAuth app **or** the fake provider | **always** the fake provider (§10.1) | real Gmail |
| AI | real key optional; falls back to a stub classifier | stub only — no network in tests | real Anthropic key |
| Secrets from | `.env` (gitignored) | `.env.test` (committed — contains only non-secret dev values) | platform secret store |
| Cookies | `Secure=false` (http://localhost) | n/a | `Secure=true`, `SameSite=Lax` |
| Log format | pretty, human-readable | silent unless a test asserts on logs | JSON lines to stdout |

`scripts/db.sh init` already creates both `instantmail` and `instantmail_test`
(verified in the script) — so the test database exists from day one with no
extra step.

### 2.1 The env var matrix

`R` = required (boot fails without it) · `O` = optional · `—` = must be unset.

| Variable | local | test | prod | Notes |
|---|---|---|---|---|
| `NODE_ENV` | R `development` | R `test` | R `production` | Set by the runtime; validated anyway. |
| `DATABASE_URL` | R | R (`…/instantmail_test`) | R | Topology B: append `?pgbouncer=true&connection_limit=1`. |
| `DIRECT_DATABASE_URL` | O | O | **R in topology B**, O in A | Unpooled; used only by `migrate deploy`. |
| `APP_URL` | R `http://localhost:3000` | R | R `https://…` | Absolute base for OAuth redirects, links, and origin checks. Must be https in prod. |
| `AUTH_SECRET` | R | R (fixed dev value) | R | ≥32 bytes base64. Signs OAuth `state`; not used to *store* sessions (those are hashed random tokens). |
| `ENCRYPTION_KEY` | R | R (fixed dev value) | R | Exactly 32 bytes when base64-decoded. AES-256-GCM. |
| `ENCRYPTION_KEY_PREVIOUS` | O | O | O — set only during a rotation | Decrypt-only. See §4.2. |
| `GOOGLE_CLIENT_ID` | R | O | R | |
| `GOOGLE_CLIENT_SECRET` | R | O | R | |
| `GOOGLE_REDIRECT_URI` | R | O | R | Must equal `${APP_URL}/api/oauth/google/callback` — asserted by a refinement. |
| `GMAIL_PUBSUB_VERIFICATION_TOKEN` | O | O | R | Webhook rejects every payload without it. |
| `GMAIL_PUBSUB_TOPIC` | O | O | R | `projects/<p>/topics/<t>`. |
| `WORKER_AUTH_TOKEN` | R | R | R | Bearer for `/api/worker/tick`. ≥32 chars. |
| `WORKER_CONCURRENCY` | O `4` | O `1` | O `4` | Integer 1–32. |
| `WORKER_POLL_INTERVAL_MS` | O `5000` | O | O `5000` | Integer 500–60000. |
| `ANTHROPIC_API_KEY` | O | — | R from phase 10 | Absent ⇒ AI features render an honest disabled state (brief §8). |
| `AI_MODEL` | O | O | O | Default `claude-sonnet-5`. |
| `LOG_LEVEL` | O `debug` | O `silent` | O `info` | `debug\|info\|warn\|error\|silent`. |
| `LOG_FORMAT` | O `pretty` | O `silent` | O `json` | Prod is always `json`. |
| `MICROSOFT_*` | — until phase 11 | — | — until phase 11 | |
| `NEXT_PUBLIC_APP_URL` | R | R | R | The **only** `NEXT_PUBLIC_*` variable we permit. See §4.1. |

Two variables were considered and rejected: `PORT` (the platform injects it;
Next.js reads it directly) and `SENTRY_DSN` (§5 explains why we start with
stdout JSON and no vendor).

### 2.2 Fail-fast typed env validation

One module, imported for side effects at the top of both entrypoints, so a
missing secret is a boot crash with a readable list — not a `TypeError:
Cannot read properties of undefined` at 3am inside a send.

We implement it in zod directly rather than adding `@t3-oss/env-nextjs`
(the brief permits either); ~90 lines is cheaper than a dependency and lets us
express the cross-field refinements below.

`src/lib/env.ts`:

```ts
import 'server-only';
import { z } from 'zod';

/** 32-byte key, supplied base64. Decoded length is what matters, not string length. */
const base64Key32 = z.string().refine(
  (v) => {
    try { return Buffer.from(v, 'base64').length === 32; } catch { return false; }
  },
  'must be 32 bytes when base64-decoded (generate: openssl rand -base64 32)',
);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),

    DATABASE_URL: z.string().url().startsWith('postgres'),
    DIRECT_DATABASE_URL: z.string().url().startsWith('postgres').optional(),

    APP_URL: z.string().url(),
    NEXT_PUBLIC_APP_URL: z.string().url(),

    AUTH_SECRET: z.string().min(32),
    ENCRYPTION_KEY: base64Key32,
    ENCRYPTION_KEY_PREVIOUS: base64Key32.optional(),

    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),
    GMAIL_PUBSUB_VERIFICATION_TOKEN: z.string().min(16).optional(),
    GMAIL_PUBSUB_TOPIC: z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/).optional(),

    WORKER_AUTH_TOKEN: z.string().min(32),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),

    ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-').optional(),
    AI_MODEL: z.string().default('claude-sonnet-5'),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    LOG_FORMAT: z.enum(['json', 'pretty', 'silent']).default('json'),
  })
  // Prod must not be reachable over http: cookies are Secure-only there.
  .refine((e) => e.NODE_ENV !== 'production' || e.APP_URL.startsWith('https://'), {
    path: ['APP_URL'],
    message: 'must be https in production (session cookies are Secure)',
  })
  // A redirect URI pointing at the wrong host fails at OAuth time, in a user's
  // face, with an opaque Google error. Catch it at boot instead.
  .refine((e) => !e.GOOGLE_REDIRECT_URI ||
                 e.GOOGLE_REDIRECT_URI === `${e.APP_URL}/api/oauth/google/callback`, {
    path: ['GOOGLE_REDIRECT_URI'],
    message: 'must equal `${APP_URL}/api/oauth/google/callback`',
  })
  // Gmail is the only provider in v1; prod without it is a broken deploy.
  .refine((e) => e.NODE_ENV !== 'production' ||
                 (!!e.GOOGLE_CLIENT_ID && !!e.GOOGLE_CLIENT_SECRET &&
                  !!e.GOOGLE_REDIRECT_URI && !!e.GMAIL_PUBSUB_VERIFICATION_TOKEN), {
    message: 'production requires GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI and GMAIL_PUBSUB_VERIFICATION_TOKEN',
  })
  .refine((e) => e.NODE_ENV !== 'production' || e.LOG_FORMAT === 'json', {
    path: ['LOG_FORMAT'],
    message: 'production logs must be json (they are parsed by the platform)',
  })
  // Rotation guard: a stale PREVIOUS key equal to the current one hides bugs.
  .refine((e) => e.ENCRYPTION_KEY_PREVIOUS !== e.ENCRYPTION_KEY, {
    path: ['ENCRYPTION_KEY_PREVIOUS'],
    message: 'must differ from ENCRYPTION_KEY (remove it when rotation is complete)',
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Names and reasons only. Never echo values — this output lands in platform logs.
  const lines = parsed.error.issues.map(
    (i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`,
  );
  console.error(`Invalid environment:\n${lines.join('\n')}`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export type Env = typeof env;

/** Feature gates derived once, so UI/services branch on intent not on key presence. */
export const features = Object.freeze({
  ai: !!parsed.data.ANTHROPIC_API_KEY,
  gmailPush: !!parsed.data.GMAIL_PUBSUB_VERIFICATION_TOKEN,
});
```

Rules around it:

- `process.env` is read **only** in `src/lib/env.ts`. A lint rule
  (`no-restricted-properties` / `no-process-env`) enforces it everywhere else,
  with `next.config.ts`, `prisma/seed.ts`, and `worker/index.ts` exempted.
- `import 'server-only'` means an accidental client import is a build error, not
  a leaked secret (brief §3 rule 5).
- `worker/index.ts` and `next.config.ts` both `import '@/lib/env'` on their
  first line so validation runs before anything else. Next.js additionally
  evaluates it during `next build`, which means **a bad prod env fails the build,
  not the deploy.**
- Client code that needs the app URL imports `NEXT_PUBLIC_APP_URL` from a
  separate 6-line `src/lib/public-env.ts` that contains nothing else. Keeping
  the two files apart is what makes "no secret in the bundle" reviewable at a
  glance.
- `.env.test` is committed and contains only fixed non-secret values (a
  throwaway `ENCRYPTION_KEY`, a literal `AUTH_SECRET`, the test DB URL). It is
  the one exception to "nothing secret is committed", and it is only an
  exception because none of it is secret. `.gitignore` needs
  `!.env.test` alongside the existing `!.env.example`.

---

## 3. Database operations

### 3.1 Migration strategy

**Prisma Migrate, forward-only, committed** (brief §9). No exceptions.

- Every schema change is a migration file under `prisma/migrations/`, generated
  by `prisma migrate dev --name <verb_noun>`, reviewed as code, and committed in
  the same PR as the code that needs it.
- **Never `migrate reset` outside local/test.** Never hand-edit an applied
  migration. Never delete one. To undo a migration, write a new migration that
  reverses it — the history is an append-only log, exactly like `EmailEvent`.
- The generated SQL is reviewed for locks (brief §9). Specifically flagged in
  review: `ALTER TABLE … ADD COLUMN … NOT NULL` without a default, any `ALTER
  COLUMN TYPE`, and `CREATE INDEX` without `CONCURRENTLY` on a table expected to
  exceed ~100k rows (`EmailEvent`, `Message`, `Lead`, `Job`).
- Prisma wraps each migration in a transaction, so `CREATE INDEX CONCURRENTLY`
  is illegal inside one. When we need a concurrent index, the migration file
  contains only that statement and is marked so Prisma runs it outside a
  transaction:

```sql
-- prisma/migrations/20260901120000_email_event_ws_created_idx/migration.sql
-- Concurrent: this table is large and a plain CREATE INDEX takes an ACCESS
-- EXCLUSIVE lock for the duration of the build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "EmailEvent_workspaceId_createdAt_idx"
  ON "EmailEvent" ("workspaceId", "createdAt" DESC);
```

Prisma has no per-migration "no transaction" flag, so concurrent-index
migrations are applied by a small guarded script rather than by `migrate deploy`
alone. The boring alternative — and our default until a table actually hurts —
is a plain `CREATE INDEX` during a low-traffic window. Cold-email tables get
large slowly; do not pre-optimise this.

### 3.2 How migrations run on deploy

```
git push → CI green → platform build → RELEASE STEP → start web + worker
                                            │
                                  bunx prisma migrate deploy
                                  (DIRECT_DATABASE_URL if set, else DATABASE_URL)
```

- The release step runs **once per deploy**, before any new process serves
  traffic, and **fails the deploy** on error (no `|| true`).
- It runs *exactly once* even with N web replicas. Prisma's advisory lock on
  `_prisma_migrations` makes a concurrent second attempt wait rather than
  double-apply, but relying on that is not a design — the platform's release
  hook is.
- Topology A: platform release command. Topology B: a `postbuild`-adjacent step
  or a one-shot job; on Vercel, `"build": "prisma migrate deploy && next build"`
  is the pragmatic option, with the caveat that a build without DB reachability
  then fails. We accept that — a deploy that cannot reach the DB should fail.
- **Migrations never run from the worker.** The worker asserts on boot that the
  schema is current and exits if not:

```ts
// worker/index.ts (boot assertion)
const pending = await pendingMigrationCount();          // reads _prisma_migrations
if (pending > 0) {
  log.error({ event: 'worker.boot.schema_stale', pending });
  process.exit(1);   // let the platform restart us after the release step lands
}
```

### 3.3 Expand/contract for destructive changes

Any change that could break a running old process is split across **at least
two deploys**. Web and worker restart at slightly different moments, and a
rollback puts old code in front of a new schema, so "the code and schema change
together" is never true in practice.

```
        deploy N            deploy N+1           deploy N+2
        ────────            ──────────           ──────────
EXPAND: add nullable      MIGRATE: backfill    CONTRACT: drop old
        new column,       + code reads new,      column / add NOT NULL
        code writes BOTH    stops writing old    / drop old index
        old and new
```

Concrete rules:

| Change | Wrong (one deploy) | Right |
|---|---|---|
| Rename `Lead.first_name` → `firstName` | `ALTER … RENAME` | add `firstName` nullable → dual-write → backfill → switch reads → drop `first_name` |
| Add a required column | `ADD COLUMN x text NOT NULL` | `ADD COLUMN x text` (nullable) → backfill in batches → `SET NOT NULL` next deploy |
| Narrow a type / add a CHECK | in place | add constraint `NOT VALID`, backfill offenders, `VALIDATE CONSTRAINT` later |
| Drop a column | drop immediately | stop reading it (deploy), *then* drop it (next deploy) |
| Add an enum value | fine, additive | fine — but a **removed** enum value is an expand/contract |
| Add a unique constraint | `ADD CONSTRAINT … UNIQUE` | build `CREATE UNIQUE INDEX CONCURRENTLY` first, then attach it |

Backfills of more than ~50k rows are a **job**, not a migration: batch by
primary key, 1000 rows per statement, committed per batch, so a long
`UPDATE` never holds a lock across the deploy. This also means the backfill is
observable and resumable like everything else in the system.

One more rule, specific to us: **never destructively change the `Job` table
while jobs are pending.** Drain or pause the queue first (`campaign` status
`PAUSED`, worker stopped), because in-flight rows are the one piece of state we
cannot reconstruct.

### 3.4 Connection pooling — web vs worker

Two different access patterns, so two different budgets. Prisma opens a pool
per `PrismaClient` instance, sized `num_physical_cpus * 2 + 1` by default,
which is wrong for both of ours.

| | web | worker |
|---|---|---|
| Pattern | many short queries, bursty | few long-ish transactions, steady |
| `connection_limit` | `10` per replica | `WORKER_CONCURRENCY + 4` (≈8) |
| `pool_timeout` | `10` s | `30` s (a job can afford to wait) |
| Client lifetime | one global singleton per process | one global singleton |
| Statement timeout | `10s` | `60s` — sends and syncs are slower |

```
Budget check (managed Postgres, typical max_connections = 100):
  web:    3 replicas × 10               = 30
  worker: 1 replica × 8                 =  8
  migrate deploy (transient)            =  1
  operator psql / platform dashboard    =  5
  reserved superuser                    =  3
  ────────────────────────────────────────────
  peak                                  = 47   ✓ ~50% headroom
```

`src/lib/db.ts` holds the singleton with the standard dev-HMR guard; the worker
imports the same module. The connection string differs per process via the
env var, not via code:

```
# web
DATABASE_URL="postgresql://…/instantmail?schema=public&connection_limit=10&pool_timeout=10"
# worker (same DB, different budget)
DATABASE_URL="postgresql://…/instantmail?schema=public&connection_limit=8&pool_timeout=30"
```

In **topology B** add `&pgbouncer=true` and drop `connection_limit` to `1`:
each serverless invocation is its own process and the pooler does the pooling.
Prisma then disables prepared statements, which is required for transaction-mode
PgBouncer. `DIRECT_DATABASE_URL` must be set, or `migrate deploy` will fail on
DDL through the pooler.

Note for `06`: `SELECT … FOR UPDATE SKIP LOCKED` requires a real transaction
held for the duration of the lease acquisition. In topology B through a
transaction pooler this still works — the lease is acquired and committed
quickly, and the *work* happens outside that transaction with `leaseExpiresAt`
as the guard. Do not hold a transaction open across a Gmail API call.

### 3.5 Backups and restore testing

- **Managed Postgres, managed backups.** Daily full snapshot, 7-day retention
  minimum, plus PITR/WAL if the plan offers it (it usually does). We do not
  hand-roll `pg_dump` cron on a box we also have to babysit.
- **A second, independent copy**, because "the provider has backups" and "we
  can restore" are different claims: a weekly `pg_dump --format=custom` from a
  scheduled job to object storage (different vendor from the DB), 4-week
  retention, encrypted at rest.
- **Restore rehearsal, monthly, written down.** Restore the latest dump into a
  scratch database and run the verification script. An untested backup is a
  rumour.

```bash
# scripts/restore-test.sh  (design; owned by whoever builds ops scripts)
set -euo pipefail
DUMP="$1"
createdb instantmail_restore_check
pg_restore --dbname=instantmail_restore_check --no-owner --clean --if-exists "$DUMP"
psql -d instantmail_restore_check -v ON_ERROR_STOP=1 <<'SQL'
  -- 1. schema is current: no pending migrations, none failed
  SELECT count(*) = 0 AS ok_migrations
    FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
  -- 2. the invariant that matters most: no tenant-owned row without a workspace
  SELECT count(*) = 0 AS ok_tenancy FROM "Lead"     WHERE "workspaceId" IS NULL;
  SELECT count(*) = 0 AS ok_tenancy FROM "Campaign" WHERE "workspaceId" IS NULL;
  -- 3. the fact log survived
  SELECT count(*) > 0 AS ok_events FROM "EmailEvent";
  -- 4. encrypted credentials decode structurally (key version present)
  SELECT count(*) = 0 AS ok_creds FROM "MailboxCredential" WHERE "keyVersion" IS NULL;
SQL
dropdb instantmail_restore_check
```

**RPO / RTO, stated so nobody has to guess:** RPO ≈ 24h on snapshots alone
(minutes with PITR); RTO ≈ 1 hour, dominated by restore time and DNS. For a
cold-email tool this is acceptable. What is *not* acceptable is losing
`EmailEvent` history, because analytics derive from it and it cannot be
rebuilt — so if we ever pick a plan without PITR, that is the reason to
reconsider.

---

## 4. Secrets management

### 4.1 Where secrets live

| Environment | Store | Injected as | Notes |
|---|---|---|---|
| local | `.env`, gitignored | `process.env` via Bun's automatic `.env` load | Real Google credentials belong to a **dev OAuth app** with test users, never the production app. |
| test | `.env.test`, committed | same | Contains no real secret. Fixed throwaway keys so crypto tests are deterministic. |
| CI | GitHub Actions repo/environment secrets | workflow `env:` | Only what CI actually needs: nothing, in fact — CI uses the `.env.test` values. This is a feature. |
| production | platform secret store (Railway/Fly/Render/Vercel env vars, encrypted at rest, write-only in the UI) | process env at boot | Set once, by a human, out of band. Not in any file, not in CI, not in a chat message. |

The rules, absolute:

1. **Nothing secret is committed.** `.gitignore` already blocks `.env`,
   `*.pem`, `*.key`, `credentials.json`, `service-account*.json`, `token*.json`.
   A `gitleaks` (or equivalent) scan runs in CI on every PR and fails it.
2. **Nothing secret reaches the client bundle.** Enforced structurally, not by
   vigilance: `src/lib/env.ts` imports `server-only`, so any client component
   in its import graph is a *build error*. The only client-readable value is
   `NEXT_PUBLIC_APP_URL`, in its own file, and any new `NEXT_PUBLIC_*` variable
   requires lead approval in review.
3. **Nothing secret is logged.** The logger (§5.1) runs a redaction pass over
   every payload before serialisation. Refresh tokens, access tokens, passwords,
   session tokens, and full email bodies never appear (brief §6, §9).
4. **Plaintext refresh tokens exist only in memory**, for the duration of one
   token refresh. They are decrypted, used, and dropped — never returned from a
   module's public API, never put on a domain type that a server component
   might pass to a client component.
5. **Rotate on any suspicion.** There is no "probably fine."

CI needing zero secrets to run the full suite (because providers are faked and
AI is stubbed) is not an accident — it is what makes fork PRs safe and removes
the biggest source of "why did CI leak that."

### 4.2 Rotating `ENCRYPTION_KEY`

The brief mandates a key-version column precisely so this is a routine
operation rather than an outage. Envelope-free, versioned-key design:

```prisma
// shape assumed by this procedure; owned by 02-data-model
model MailboxCredential {
  id             String   @id @default(cuid())
  workspaceId    String
  mailboxId      String
  kind           CredentialKind      // GOOGLE_REFRESH_TOKEN | SMTP_PASSWORD
  ciphertext     Bytes               // AES-256-GCM: iv(12) || tag(16) || ct
  keyVersion     Int                 // which ENCRYPTION_KEY encrypted this
  rotatedAt      DateTime?
  @@index([workspaceId, mailboxId])
}
```

`src/lib/crypto.ts` exposes exactly:

```ts
export function encryptSecret(plaintext: string): { ciphertext: Buffer; keyVersion: number };
export function decryptSecret(ciphertext: Buffer, keyVersion: number): string;
```

`encryptSecret` always uses the **current** key and stamps its version.
`decryptSecret` selects the key by version from a keyring assembled at boot:
`{ [currentVersion]: ENCRYPTION_KEY, [currentVersion - 1]: ENCRYPTION_KEY_PREVIOUS }`.
An unknown version throws `CredentialKeyMissingError` — loudly, because silently
returning garbage would look like a Gmail auth failure and send us chasing the
wrong problem.

The current version is `ENCRYPTION_KEY_VERSION` (integer, defaults to `1`); add
it to the env schema when the first rotation is scheduled, not before.

**Procedure — zero downtime, four deploys, reversible until step 4:**

```
1. GENERATE      openssl rand -base64 32        → the new key
2. DUAL-READ     set  ENCRYPTION_KEY_PREVIOUS = <old>
   deploy             ENCRYPTION_KEY          = <new>
                      ENCRYPTION_KEY_VERSION  = 2
   → new writes use v2; existing v1 rows still decrypt via PREVIOUS.
   → ROLLBACK: swap the two vars back. Any v2 row written in the meantime
     becomes unreadable, so roll back within minutes, or re-encrypt first.
3. RE-ENCRYPT    enqueue one `credential.reencrypt` job per credential row:
                   BEGIN;
                     SELECT … FOR UPDATE where id = $1 and keyVersion = 1;
                     plaintext := decryptSecret(ct, 1);
                     UPDATE set ciphertext = encryptSecret(plaintext).ciphertext,
                                keyVersion = 2, rotatedAt = now();
                   COMMIT;
                 Batched, retryable, idempotent (the `keyVersion = 1` guard makes
                 a re-run a no-op). Watch until:
                   SELECT keyVersion, count(*) FROM "MailboxCredential" GROUP BY 1;
                 shows zero v1 rows.
4. CONTRACT      unset ENCRYPTION_KEY_PREVIOUS, deploy.
                 The env refinement in §2.2 then guarantees nobody left a stale
                 PREVIOUS lying around equal to the current key.
5. VERIFY        one real Gmail token refresh per connected mailbox succeeds
                 (the `mailbox.token.refreshed` log event, count == mailbox count).
                 Record the rotation in the audit log.
```

Why re-encrypt at all rather than lazily on next use: a mailbox that goes 60
days without a send would still hold a v1 row when we want to retire the old
key. Explicit is cheaper than clever.

### 4.3 Rotating `AUTH_SECRET`

Simpler, because sessions do **not** depend on it. Per brief §6, a session is an
opaque 256-bit random token whose SHA-256 hash is stored; no signing key is
involved. `AUTH_SECRET` signs only short-TTL artifacts: the OAuth `state`
parameter, invite tokens, and any signed URL.

```
1. Rotate the value in the platform secret store. Deploy.
2. Blast radius: OAuth flows and invite links issued in the last few minutes
   fail signature verification. Users see "this link expired, please try again."
3. Sessions are unaffected — nobody is logged out.
4. If a rotation must be seamless, add AUTH_SECRET_PREVIOUS as verify-only for
   one deploy and follow the same expand/contract shape as §4.2. For a
   5-minute-TTL artifact this is over-engineering; do the simple thing.
```

Separately, and unrelated to the secret: **revoking sessions** is a DB
operation (`DELETE FROM "Session" WHERE …`), which is exactly why the brief
chose hashed random tokens over JWTs. Mass logout after a security event is one
statement, and it works instantly.

### 4.4 Rotating Google OAuth client credentials

Worth writing down because it is the one rotation with a nasty edge: rotating
`GOOGLE_CLIENT_SECRET` in Google Cloud **invalidates existing refresh tokens
issued to the old client**. Every connected mailbox needs re-consent. Treat it
as an incident-only action, notify users in advance, and expect
`MailboxStatus = DISCONNECTED` across the board (which the mass-disconnect
runbook, §6.3, already handles).

---

## 5. Observability

We start with **structured JSON on stdout** and nothing else. Every platform we
would deploy to ingests, retains, and searches stdout for free. No Sentry, no
OTel collector, no metrics vendor in v1 — those are added when a specific
question cannot be answered from logs, and not before. The metrics in §5.4 are
computed by SQL against tables we already have, which is why this works.

### 5.1 Structured logging with a correlation id

`src/lib/logger.ts`:

```ts
type Level = 'debug' | 'info' | 'warn' | 'error';

/** Fields present on every line. `event` is a dotted name from the taxonomy (§5.2). */
type LogBase = {
  ts: string;            // ISO-8601 UTC
  level: Level;
  event: string;
  msg?: string;
  /** Correlation: exactly one of these two is always set. */
  requestId?: string;    // web: one per HTTP request / server action
  jobId?: string;        // worker: one per job attempt
  /** Tenancy — present whenever a workspace is known. Never a customer email. */
  workspaceId?: string;
  userId?: string;
  /** Domain keys, as applicable. */
  campaignId?: string; mailboxId?: string; leadId?: string;
  scheduledEmailId?: string; threadId?: string;
  durationMs?: number;
  /** Errors: class name + message + stack. Never the offending payload verbatim. */
  err?: { name: string; message: string; stack?: string };
};

export type Logger = {
  debug(f: Omit<LogBase, 'ts' | 'level'> & Record<string, unknown>): void;
  info(f: …): void; warn(f: …): void; error(f: …): void;
  /** Returns a logger with these fields merged into every subsequent line. */
  child(fields: Record<string, unknown>): Logger;
};

export const log: Logger;
```

Mechanics:

- **Correlation id propagation.** Web: `src/server/request-context.ts` wraps each
  request/action in `AsyncLocalStorage` holding `{ requestId, workspaceId, userId }`;
  `requestId` comes from the platform's inbound header if present
  (`x-request-id`), else `crypto.randomUUID()`, and is echoed back on the
  response so a user-reported problem is greppable. Worker: `drainQueue` creates
  `log.child({ jobId, attempt, jobType })` per attempt and passes that logger
  down. A job enqueued by a request carries `enqueuedByRequestId` on the `Job`
  row, so a send is traceable back to the click that caused it. That single
  column is the whole distributed-tracing story, and it is enough.
- **Redaction before serialisation.** A deny-list of key names —
  `refreshToken`, `accessToken`, `password`, `passwordHash`, `token`,
  `sessionToken`, `authorization`, `cookie`, `ciphertext`, `ENCRYPTION_KEY`,
  `AUTH_SECRET`, `WORKER_AUTH_TOKEN`, `apiKey` — replaced with `'[redacted]'` at
  any depth. Additionally: `body`/`html`/`text` fields are replaced with
  `{ length: n }` because we never log email bodies (brief §9), and email
  addresses are logged as `sha256(addr).slice(0,12)` unless the line is
  explicitly an audit record. There is a unit test asserting each of these.
- `LOG_FORMAT=pretty` in local dev only. Production is JSON lines, one object
  per line, no multi-line pretty printing — a wrapped stack trace across lines
  is unparseable.
- `console.log` is banned by lint (brief §9). The logger is the only path.

### 5.2 Event taxonomy

Dotted `domain.subject.verb`, past tense for facts, and **stable** — dashboards
and alerts key on these strings, so renaming one is a breaking change.

```
auth.login.succeeded            auth.login.failed{reason}       auth.logout
auth.session.revoked            auth.register.succeeded         auth.invite.accepted
authz.denied{required,actual}    authz.cross_workspace_attempt{requestedId}   ← always warn

http.request.completed{method,path,status,durationMs}
action.invoked{name}            action.rejected{name,reason:'validation'|'authz'|'rate_limit'}

mailbox.oauth.started           mailbox.oauth.callback_failed{reason}
mailbox.connected               mailbox.disconnected{reason}
mailbox.token.refreshed         mailbox.token.refresh_failed{status}   ← the disconnect precursor
mailbox.sync.started            mailbox.sync.completed{messages,durationMs}
mailbox.sync.failed{reason}     mailbox.watch.renewed                  mailbox.watch.expired

lead.imported{rows,accepted,rejected}       lead.import.rejected_row{rowNumber,reason}
lead.unsubscribed{source}

campaign.launched               campaign.paused{by}             campaign.completed
scheduler.tick.completed{campaigns,materialised,durationMs}
scheduler.step.skipped{reason:'window'|'daily_cap'|'replied'|'unsubscribed'|'paused'}

job.enqueued{type,runAt,dedupeKey}          job.leased{type,attempt}
job.succeeded{type,durationMs}              job.failed{type,attempt,willRetryAt}
job.dead_lettered{type,attempt}             ← always error
job.lease_expired{type}                     job.duplicate_suppressed{dedupeKey}

send.attempted                  send.succeeded{providerMessageId}
send.failed{providerStatus,classification:'transient'|'permanent'}
send.suppressed{reason:'replied'|'unsubscribed'|'bounced'|'duplicate'|'cap'}
provider.rate_limited{provider,retryAfterMs}   provider.quota_exhausted{provider}

reply.detected{kind:'human'|'auto'|'bounce'}   reply.sequence_stopped{stepsCancelled}
reply.classified{label,confidence,model}       bounce.recorded{kind:'hard'|'soft'}

ai.request{model,purpose}       ai.response{model,tokensIn,tokensOut,durationMs}
ai.failed{model,reason}         ai.output_invalid{model,purpose}   ← zod rejected it

worker.boot                     worker.heartbeat{leased,pending}
worker.shutdown{reason,inflight}                worker.boot.schema_stale{pending}
```

Levels: `debug` for per-item detail, `info` for facts, `warn` for
handled-but-notable (`send.failed` transient, `provider.rate_limited`,
`authz.cross_workspace_attempt`), `error` for
things-a-human-should-see (`job.dead_lettered`, `mailbox.sync.failed`,
`ai.output_invalid`, unhandled exceptions).

### 5.3 Health checks

`GET /api/health` — unauthenticated, returns a small JSON body, no tenant data.
Two levels so a load balancer and a human can use the same endpoint:

```ts
// src/app/api/health/route.ts
type HealthReport = {
  status: 'ok' | 'degraded' | 'down';
  version: string;                       // git sha, injected at build
  checks: {
    db:     { status: 'ok' | 'down'; latencyMs: number };
    schema: { status: 'ok' | 'stale'; pendingMigrations: number };
    worker: { status: 'ok' | 'stale' | 'never_seen'; lastHeartbeatAgoSec: number | null };
    queue:  { status: 'ok' | 'backing_up'; pending: number; oldestPendingAgeSec: number | null };
  };
};
```

- `db`: `SELECT 1`, 2s timeout. Failure ⇒ `status: 'down'`, **HTTP 503**.
- `schema`: count of unfinished rows in `_prisma_migrations`. Stale ⇒ `degraded`.
- `worker`: the worker `UPDATE`s a single-row `WorkerHeartbeat` table every 15s
  (`{ id, lastSeenAt, hostname, pid, version, leasedCount }`). No heartbeat in
  90s ⇒ `stale`, `degraded`. This is the check that catches "campaigns silently
  stopped," which is the failure this product cannot tolerate.
- `queue`: pending count and oldest pending job age. Oldest > 15 min ⇒
  `backing_up`, `degraded`.
- **HTTP status: 200 for `ok` and `degraded`, 503 only for `down`.** A backing-up
  queue must not make the platform kill and restart healthy web replicas — that
  makes an incident worse. Degradation is for humans and alerts, not for the
  load balancer.
- `GET /api/health?deep=1` additionally reports disconnected-mailbox count and
  24h send success rate. Kept off the default path because it is heavier and the
  LB polls the default every few seconds.
- The worker exposes no HTTP server. Its liveness *is* the heartbeat row. Adding
  a port to the worker just to answer a health check would be infrastructure for
  its own sake.

### 5.4 The metrics that actually matter

Six. Each is one SQL query, each maps to a decision, and each is on the
dashboard. Anything not on this list is a log search, not a metric.

```sql
-- 1. QUEUE DEPTH — is the worker keeping up?
SELECT status, count(*)
FROM "Job"
WHERE state IN ('PENDING','RUNNING','RETRYING','DEAD')
GROUP BY status;

-- 2. OLDEST PENDING JOB AGE — the single best "is the worker alive" signal.
--    Counts only jobs that are actually due; a delayed job is not late.
SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min("runAt"))), 0) AS oldest_due_age_sec
FROM "Job"
WHERE status = 'PENDING' AND "runAt" <= now();

-- 3. SEND SUCCESS RATE (rolling 1h) — deliverability and provider health.
SELECT count(*) FILTER (WHERE type = 'SENT')::float
         / NULLIF(count(*) FILTER (WHERE type IN ('SENT','FAILED')), 0) AS success_rate,
       count(*) FILTER (WHERE type = 'SENT')   AS sent,
       count(*) FILTER (WHERE type = 'FAILED') AS failed
FROM "EmailEvent"
WHERE "createdAt" > now() - interval '1 hour';

-- 4. SYNC LAG per mailbox — how stale is reply detection?
--    This is the invariant "a reply stops the sequence" expressed as a number.
SELECT id, email_hash, EXTRACT(EPOCH FROM (now() - "lastSyncedAt")) AS lag_sec
FROM "EmailAccount"
WHERE status = 'CONNECTED'
ORDER BY lag_sec DESC NULLS FIRST
LIMIT 20;

-- 5. BOUNCE RATE (rolling 24h) — the number that gets a domain blacklisted.
SELECT count(*) FILTER (WHERE type = 'BOUNCED')::float
         / NULLIF(count(*) FILTER (WHERE type = 'SENT'), 0) AS bounce_rate_24h,
       count(*) FILTER (WHERE type = 'BOUNCED') AS bounces,
       count(*) FILTER (WHERE type = 'SENT')    AS sent
FROM "EmailEvent"
WHERE "createdAt" > now() - interval '24 hours';

-- 6. DISCONNECTED MAILBOXES — every one is a campaign that has stopped.
SELECT count(*) AS disconnected,
       count(*) FILTER (WHERE "disconnectedAt" > now() - interval '15 minutes') AS recent
FROM "EmailAccount"
WHERE status IN ('DISCONNECTED','AUTH_FAILED');
```

Deliberately **not** metrics: open rate and click rate. They are product
analytics, not operational signals, and per brief §10 open tracking is
pixel-based and blocked by a large and unknowable share of clients — alerting on
a number we cannot trust would train us to ignore alerts.

### 5.5 Alert conditions worth paging on

Five page-worthy conditions. The bar: *a human must act within the hour, and
there is something they can do.* Everything else is a daily digest.

| Alert | Condition | Why it pages | First action |
|---|---|---|---|
| **Worker down** | no `WorkerHeartbeat` update for **3 min** | every campaign is stopped and no user can tell | §6.1 |
| **Queue backing up** | `oldest_due_age_sec > 900` for 10 min *(and worker is alive)* | sends are drifting outside their windows; recipients get 2am email | §6.2 |
| **Send failure spike** | 1h success rate `< 0.80` with `sent+failed >= 20` | provider outage, expired credentials, or we are being throttled | §6.4 |
| **Bounce rate spike** | 24h bounce rate `> 0.05` with `sent >= 100` | reputation damage compounds and is slow to undo | §6.5 |
| **Mailbox mass-disconnect** | `>= 3` mailboxes, or `> 25%` of connected mailboxes, disconnect within 15 min | usually a credential/consent/quota event, not user behaviour | §6.3 |

Sample gates (`>= 20`, `>= 100`) exist because a 0/1 send window is 0% success
and means nothing — the same "no conclusions from tiny samples" rule the brief
applies to product analytics (brief §10) applies to our own alerting.

Warn-not-page, reviewed daily: any `job.dead_lettered`, `ai.output_invalid`,
sync lag > 30 min on a single mailbox, `authz.cross_workspace_attempt` (any
occurrence — investigate, it is either a bug or an attack).

**Delivery:** a scheduled `ops.health_probe` job runs the six queries every
minute, compares against thresholds, and posts to a webhook (email or Slack)
with a per-condition cooldown of 30 min so one incident is one page. Alerting
from inside the system we are monitoring is a known weakness: **the worker-down
alert must not be evaluated by the worker.** It is evaluated by an external
uptime monitor hitting `/api/health` and asserting
`checks.worker.status == "ok"` — a free external HTTP check is the correct tool
and the only piece of third-party monitoring we take on.

---

## 6. Runbooks

Format for each: **symptom → confirm → act → verify → follow-up.** Kept short
enough to be read at 3am. Every diagnostic here is a query against tables we
already have; no special tooling required.

### 6.1 Worker stopped

```
SYMPTOM   /api/health → checks.worker.status = "stale" | "never_seen".
          Campaigns show as active but nothing is sending.

CONFIRM   platform: is the worker service running? crashed? OOM-killed?
          logs: last lines before silence — look for
            worker.shutdown{reason}  · worker.boot.schema_stale  · an unhandled throw
          SELECT * FROM "WorkerHeartbeat";              -- lastSeenAt, version, pid
          SELECT state, count(*) FROM "Job" GROUP BY 1; -- RUNNING rows are the orphans

ACT       1. Restart the worker service.
          2. If it boots then exits: read the exit reason.
             · schema_stale → the release step did not run. Run
               `bunx prisma migrate deploy` and redeploy.
             · env validation failure → a secret is missing/mistyped; §2.2 printed
               the field name. Fix it in the platform store.
             · OOM → lower WORKER_CONCURRENCY, redeploy, then investigate the leak.
          3. Orphaned RUNNING jobs need no action: leases expire and the sweep
             re-queues them. If you are impatient and certain the old process is
             dead:
               UPDATE "Job" SET status='PENDING', "leaseExpiresAt"=NULL,
                                "leasedBy"=NULL
                WHERE state='RUNNING' AND "leaseExpiresAt" < now();
             Never widen that WHERE clause. Resetting a job still held by a live
             worker is how you send an email twice.
          4. If the worker cannot be restarted at all, drain manually:
               curl -X POST -H "Authorization: Bearer $WORKER_AUTH_TOKEN" \
                    https://<app>/api/worker/tick
             Repeat, or point a cron at it — this is topology B as a fallback.

VERIFY    heartbeat advancing; oldest_due_age_sec falling; send.succeeded events
          appearing.

FOLLOW-UP Were sends missed outside their window? Scheduled emails whose window
          has passed are re-scheduled to the next window by the scheduler, not
          sent late — confirm no send landed at 3am local for the recipient.
          If the worker has crashed twice for the same reason, that is a bug
          fix, not a restart.
```

### 6.2 Queue backing up (worker alive)

```
SYMPTOM   oldest_due_age_sec climbing past 15 min; heartbeat healthy.

CONFIRM   Which job type is stuck?
            SELECT type, status, count(*), min("runAt") AS oldest
              FROM "Job" WHERE state IN ('PENDING','RUNNING','RETRYING') GROUP BY 1,2
              ORDER BY oldest;
          Are jobs failing and retrying in a loop?
            SELECT type, attempt, count(*) FROM "Job"
             WHERE status='FAILED' GROUP BY 1,2 ORDER BY 2 DESC;
          Is one job type slow?  grep job.succeeded → durationMs percentiles.
          Are we rate-limited?   grep provider.rate_limited.

ACT       · Provider rate limiting → do NOT raise concurrency; that makes it
            worse. Let backoff work. If sustained, this is §6.4.
          · A single poisonous job spinning (same jobId retrying forever) →
            dead-letter it by hand:
              UPDATE "Job" SET status='DEAD' WHERE id = $1;
            then fix the cause.
          · Genuinely more work than capacity → raise WORKER_CONCURRENCY
            (≤ per-mailbox limits allow) or add a second worker replica. Only
            after checking per-mailbox pacing is DB-enforced, not in-memory.
          · A slow query starving the pool →
              SELECT pid, state, wait_event_type, now()-query_start AS dur, query
                FROM pg_stat_activity WHERE state <> 'idle' ORDER BY dur DESC;
            and check the pool budget in §3.4.

VERIFY    oldest_due_age_sec trending down for 10 consecutive minutes.

FOLLOW-UP If capacity was the cause, this is the signal to enforce pacing in the
          DB and to size the worker for the real send volume rather than the
          demo volume.
```

### 6.3 Mailbox mass-disconnect

```
SYMPTOM   Several mailboxes → DISCONNECTED / AUTH_FAILED within minutes.

CONFIRM   SELECT status, "disconnectReason", count(*) FROM "EmailAccount"
            WHERE "disconnectedAt" > now() - interval '1 hour' GROUP BY 1,2;
          grep mailbox.token.refresh_failed → the HTTP status is the diagnosis:
            401 invalid_grant  → refresh tokens are dead (user revoked, password
                                 changed, token unused 6 months, OR our OAuth
                                 client secret was rotated → §4.4)
            403 accessNotConfigured / insufficient scopes → API disabled or the
                                 consent screen/scopes changed
            429 / quota        → not a disconnect, it is §6.4 misclassified.
                                 If our code disconnects on 429, that is a bug.
          Google Cloud console: is the OAuth app still in good standing? Was it
          moved back to "testing"? Is the Gmail API enabled? Is there a pending
          verification deadline?

ACT       · invalid_grant across the board → re-consent is unavoidable.
            1. Pause affected campaigns so nothing retries in a loop:
               UPDATE "Campaign" SET status='PAUSED'
                WHERE "mailboxId" IN (…) AND status='ACTIVE';
            2. Notify the affected users with a reconnect link.
            3. Do NOT delete the credential rows — keep them for forensics until
               reconnect succeeds.
          · Our own secret rotation caused it → §4.4; same re-consent path, but
            we own the apology.
          · Scope/consent-screen change → revert the change in Google Cloud
            first; some mailboxes may recover on next refresh without re-consent.

VERIFY    mailbox.token.refreshed events resuming; disconnected count falling;
          campaigns resumed deliberately, one at a time, not in bulk.

FOLLOW-UP A disconnected mailbox must be loud in the UI (brief §8 "disconnected"
          state). If users found out from us rather than from the app, that is
          the real bug.
```

### 6.4 Gmail quota exhausted / rate limited

```
SYMPTOM   provider.rate_limited or provider.quota_exhausted; sends failing 429
          or 403 rateLimitExceeded / userRateLimitExceeded.

REALITY   Gmail's limits are real, tiered, and partly undocumented in the exact
          numbers that matter to us:
            · a per-user daily send cap (order of ~500/day for consumer,
              ~2,000/day for Workspace) enforced by GMAIL, not by our counters
            · per-user per-second API rate limits and a per-project quota
            · a 429 may be per-user OR per-project — the payload distinguishes
              them, and the response is different
          A daily send cap that resets on Google's clock in Google's timezone is
          NOT something we can compute exactly. Our per-mailbox daily limit must
          therefore be set CONSERVATIVELY BELOW the provider cap (deliverability
          practice puts a healthy cold-outreach mailbox well under 100/day
          anyway), and a 429 is treated as authoritative regardless of what our
          own counter says.

CONFIRM   Per-project or per-user?
            grep provider.rate_limited → reason/domain field
          Today's volume per mailbox:
            SELECT "mailboxId", count(*) FROM "EmailEvent"
             WHERE type='SENT' AND "createdAt" > date_trunc('day', now())
             GROUP BY 1 ORDER BY 2 DESC;
          Google Cloud console → APIs & Services → Quotas for the real numbers.

ACT       · Per-user (one mailbox) → that mailbox is done for the day. Mark it
            rate-limited, defer its jobs to tomorrow's window start. Do not
            retry inside the same day; retrying a hard daily cap is just noise.
          · Per-project (all mailboxes) → we are the problem. Reduce global
            concurrency now, request a quota increase, and consider that we are
            over-scheduling.
          · Respect Retry-After when present; otherwise exponential backoff with
            jitter, capped, and never faster than the pacing config.

VERIFY    Sends resume at the next window; today's per-mailbox counts sit under
          the configured limit.

FOLLOW-UP Lower the configured per-mailbox daily limit. Hitting a provider cap
          means our limit was set from optimism rather than from deliverability
          practice. Surface "capped for today" honestly in the UI instead of
          silently stalling.
```

### 6.5 Bounce-rate spike

```
SYMPTOM   24h bounce rate > 5% with sent >= 100.

WHY IT     Bounce rate is the one metric where inaction compounds: sustained
MATTERS    hard bounces damage domain and IP reputation, and recovery takes
           weeks. Unlike open rate, this number is trustworthy — a bounce is an
           SMTP-level fact, not an inference.

CONFIRM   Concentrated or general?
            SELECT c.id, c.name, count(*) FILTER (WHERE e.type='BOUNCED') AS b,
                   count(*) FILTER (WHERE e.type='SENT')                  AS s
              FROM "EmailEvent" e JOIN "Campaign" c ON c.id = e."campaignId"
             WHERE e."createdAt" > now() - interval '24 hours'
             GROUP BY 1,2 HAVING count(*) FILTER (WHERE e.type='SENT') > 20
             ORDER BY b::float / count(*) FILTER (WHERE e.type='SENT') DESC;
          Hard vs soft:
            SELECT "bounceKind", count(*) FROM "EmailEvent"
             WHERE type='BOUNCED' AND "createdAt" > now()-interval '24 hours'
             GROUP BY 1;
          Recently imported list? A single bad CSV is the usual culprit.
            Correlate bounced leads with lead."leadImportId".

ACT       1. PAUSE the worst campaign(s) immediately. A pause is cheap;
             reputation is not.
               UPDATE "Campaign" SET status='PAUSED' WHERE id IN (…);
          2. Hard bounces → mark those leads SUPPRESSED so no future step or
             campaign ever emails them again. This must be workspace-wide, not
             campaign-scoped.
          3. If it traces to one import batch, suppress the batch and tell the
             user their list needs verification. Do not quietly keep sending.
          4. Soft-bounce-dominated → often a throttle or a full mailbox; back
             off and retry later rather than suppress.
          5. Check SPF/DKIM/DMARC for the sending domain (the deliverability
             module surfaces this). A DNS regression looks exactly like a bad
             list.

VERIFY    Rate falling on the next 24h window; suppression list grew by the
          expected count; no suppressed lead appears in any pending
          ScheduledEmail.

FOLLOW-UP Enforce a bounce-rate circuit breaker in the sending engine: auto-pause
          a campaign that exceeds a threshold with adequate sample, rather than
          waiting for a human to read an alert. That belongs in `06`; this
          runbook is the interim manual version.
```

### 6.6 Migration failure on deploy

```
SYMPTOM   Release step fails. `prisma migrate deploy` non-zero. New processes
          did not start (correct — the release step gates them).

CONFIRM   SELECT migration_name, started_at, finished_at, rolled_back_at,
                 logs
            FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 5;
          Three distinct cases, and they need different handling:
            A. FAILED CLEANLY   started_at set, finished_at NULL, and the SQL was
                                wrapped in a transaction that rolled back.
                                Schema is unchanged. Old code still running.
            B. PARTIALLY APPLIED  a multi-statement migration outside a
                                transaction (e.g. concurrent index) failed
                                halfway. Schema is in between.
            C. LOCK TIMEOUT     the migration could not acquire a lock because
                                a long query or an old connection held it.

ACT       A → the safest incident we have. Old code is serving. Fix the migration
              locally, test `prisma migrate reset` from scratch, redeploy. Do NOT
              mark it applied.
          B → the dangerous one. Determine the exact state by inspecting the
              schema, then write a NEW forward migration that makes the schema
              correct from where it actually is, and use
                bunx prisma migrate resolve --rolled-back <name>
              to clear the failed record. Never --applied on a migration whose
              statements did not all run.
          C → find and kill the blocker, then retry:
                SELECT pid, now()-query_start AS dur, state, query
                  FROM pg_stat_activity
                 WHERE state <> 'idle' ORDER BY dur DESC LIMIT 10;
                SELECT pg_cancel_backend($pid);    -- terminate_backend only if needed
              Prevent the recurrence: add `SET lock_timeout = '5s'` at the top of
              lock-taking migrations so they FAIL FAST instead of queueing behind
              a long query and blocking every subsequent query on that table.

VERIFY    `bunx prisma migrate status` reports no pending, none failed;
          /api/health checks.schema.status = "ok"; worker boots (its schema
          assertion, §3.2, is the second gate).

FOLLOW-UP Was this destructive without expand/contract (§3.3)? Was it reviewed
          for locks? Both are review checklist items — if one was missed, the
          checklist is the fix, not more caution.
```

---

## 7. Bun / Next.js build and run specifics

### 7.1 Build

```bash
bun install --frozen-lockfile      # bun.lock is committed; CI must not resolve fresh
bunx prisma generate               # generates into node_modules/.prisma
bun run build                      # next build   → .next/standalone + .next/static
```

- **`output: 'standalone'` in `next.config.ts`.** It emits a self-contained
  `.next/standalone` directory with only the traced `node_modules`, which is what
  makes the container image small and the worker's dependency set explicit.
- **`prisma generate` must run before `next build`.** Put it in `postinstall`
  so it cannot be forgotten and so it re-runs after every install:
  `"postinstall": "prisma generate"`.
- The build **requires a valid production env** because `src/lib/env.ts` is
  evaluated during `next build`. This is intentional (§2.2): a missing secret is
  a red build, not a red 3am. It does mean CI needs env values to build — CI uses
  `.env.test`, which is why `.env.test` is committed.
- The build does **not** require a reachable database. Nothing in the build path
  queries Postgres; pages that need data are dynamic. If a page ever needs
  build-time data, it gets `export const dynamic = 'force-dynamic'` instead —
  a build that depends on the prod DB being up is a build that fails during
  maintenance.

`next.config.ts` (deployment-relevant parts only; the file itself is owned by
whoever builds phase 1):

```ts
import '@/lib/env';                                   // fail fast, first line

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  eslint:     { ignoreDuringBuilds: false },          // never let a build hide lint
  typescript: { ignoreBuildErrors: false },           // never let a build hide types
  serverExternalPackages: ['@prisma/client'],          // do not bundle the engine
  env: { APP_VERSION: process.env.GIT_SHA ?? 'dev' },  // surfaced by /api/health
};
export default config;
```

### 7.2 Running

```bash
# web — the standalone server, not `next start`
bun .next/standalone/server.js          # honours PORT and HOSTNAME from the platform

# worker — a plain long-lived Bun process
bun run worker                          # → bun worker/index.ts
```

The worker entrypoint's operational contract:

```ts
// worker/index.ts
import '@/lib/env';                    // 1. validate env or exit(1)
// 2. assert schema is current (§3.2) or exit(1)
// 3. write a WorkerHeartbeat row; log worker.boot with version + pid
// 4. loop: scheduler tick → drainQueue → lease-expiry sweep → heartbeat → sleep
// 5. graceful shutdown on SIGTERM/SIGINT:
//      stop leasing new jobs
//      wait up to 25s for in-flight jobs to finish
//      release any still-held leases (set status back to PENDING)
//      log worker.shutdown{reason, inflight}; exit(0)
```

The 25s drain matters: platforms send `SIGTERM` then `SIGKILL` after a grace
period (commonly 30s). Releasing leases on the way out means a deploy does not
leave jobs waiting for a lease to expire. Ignoring `SIGTERM` is the difference
between a 2-second deploy gap and a 5-minute one.

**`bun --watch` for the worker in local dev**, never in production — a watcher
restarting mid-send is exactly the unplanned kill §1.1 warns about.

### 7.3 `package.json` scripts

The full table. `bun run check` is the one command a contributor must remember;
it is also what CI runs, so "green locally" and "green in CI" mean the same
thing.

```jsonc
{
  "scripts": {
    // ── develop ───────────────────────────────────────────────
    "dev":            "next dev",
    "dev:worker":     "bun --watch worker/index.ts",
    "dev:all":        "bun run dev & bun run dev:worker; wait",

    // ── build & run ───────────────────────────────────────────
    "postinstall":    "prisma generate",
    "build":          "prisma generate && next build",
    "start":          "bun .next/standalone/server.js",
    "worker":         "bun worker/index.ts",

    // ── database ──────────────────────────────────────────────
    "db:up":          "./scripts/db.sh start",
    "db:down":        "./scripts/db.sh stop",
    "db:status":      "./scripts/db.sh status",
    "db:psql":        "./scripts/db.sh psql",
    "db:migrate":     "prisma migrate dev",
    "db:deploy":      "prisma migrate deploy",
    "db:status:mig":  "prisma migrate status",
    "db:reset":       "prisma migrate reset --force",
    "db:seed":        "bun prisma/seed.ts",
    "db:studio":      "prisma studio",

    // ── test ──────────────────────────────────────────────────
    "test":           "bun run test:unit",
    "test:unit":      "bun test tests/unit",
    "test:int":       "bun run test:db:reset && bun test tests/integration",
    "test:e2e":       "playwright test",
    "test:e2e:ui":    "playwright test --ui",
    "test:all":       "bun run test:unit && bun run test:int && bun run test:e2e",
    "test:watch":     "bun test --watch tests/unit",
    "test:cov":       "bun test --coverage tests/unit",
    // test DB gets its schema from migrations, from scratch, every run
    "test:db:reset":  "dotenv -e .env.test -- prisma migrate reset --force --skip-seed",

    // ── quality ───────────────────────────────────────────────
    "typecheck":      "tsc --noEmit",
    "lint":           "next lint",
    "lint:fix":       "next lint --fix",
    "format":         "prettier --write .",
    "format:check":   "prettier --check .",
    "check":          "bun run typecheck && bun run lint && bun run format:check && bun run test:unit"
  }
}
```

Notes on choices:

- `test:db:reset` uses `prisma migrate reset` rather than `db push`. `db push`
  would diverge the test schema from the migration history and hide exactly the
  bug integration tests exist to catch: **a migration that does not apply from
  scratch.**
- `dotenv -e .env.test` presumes a tiny CLI. If we would rather not add one,
  `DATABASE_URL=$(grep ^DATABASE_URL .env.test | cut -d= -f2-) prisma migrate
  reset …` works with zero dependencies; implementer's call, note it in the PR.
- `test` aliases `test:unit` because the bare command must be fast enough to run
  on save. Integration and E2E are opt-in locally, required in CI.
- No `clean` script. `rm -rf .next node_modules` is not worth a line of config.

---

## 8. Testing strategy

### 8.1 The pyramid, and where the weight goes

```
                    ┌──────────────┐
                    │  E2E  (~8)   │  Playwright · real browser · stubbed provider
                    │  minutes     │  ONE happy path end-to-end + a11y + 5 states
                  ┌─┴──────────────┴─┐
                  │ INTEGRATION (~90)│  bun test · REAL Postgres · real Prisma
                  │ ~60–90 seconds   │  repos, migrations, isolation sweep, queue
              ┌───┴──────────────────┴───┐
              │      UNIT  (~250)        │  bun test · no I/O · pure functions
              │      < 5 seconds         │  ← THE SENDING ENGINE LIVES HERE
              └──────────────────────────┘
```

**The rule that shapes everything else: the sending engine's invariants are
unit-tested.** Brief §1 lists four non-negotiables — no send outside the window,
no send over the cap, no duplicate send ever, a reply stops the sequence. Those
are the most expensive things in this product to get wrong, because the failure
is *irreversible and visible to a stranger*. You cannot un-send an email at 3am
to a prospect, or un-send the same email twice.

So the arithmetic and the decisions are extracted into **pure functions with no
I/O**, and those functions are tested exhaustively:

```ts
// modules/sending/scheduling.ts — pure, no DB, no clock, no network
export function computeNextSendAt(input: {
  after: Date;                       // never read `new Date()` inside
  window: { startMinute: number; endMinute: number };   // minutes from local midnight
  daysOfWeek: number[];              // 0=Sun … 6=Sat
  timezone: string;                  // IANA, e.g. 'America/New_York'
  holidays?: string[];               // 'YYYY-MM-DD' in the campaign timezone
}): Date;                            // UTC

export function decideSend(input: {
  now: Date;
  scheduled: ScheduledEmailFacts;    // status, sendAfter, attempt count
  lead: LeadFacts;                   // replied? unsubscribed? bounced? suppressed?
  campaign: CampaignFacts;           // status
  mailbox: MailboxFacts;             // status, sentToday, dailyLimit, lastSentAt
  window: WindowFacts;
}): SendDecision;

export type SendDecision =
  | { kind: 'SEND' }
  | { kind: 'DEFER'; until: Date; reason: 'window' | 'pacing' | 'daily_cap' }
  | { kind: 'SUPPRESS'; reason: 'replied' | 'unsubscribed' | 'bounced'
                              | 'campaign_paused' | 'mailbox_disconnected'
                              | 'already_sent' };
```

`decideSend` returning a value instead of performing an action is the whole
trick. Every rule in brief §1 becomes a table-driven unit test, and the DB code
around it only has to route three outcomes. **`now` and `after` are always
parameters, never `new Date()`** — a function that reads the clock cannot be
tested at a DST boundary, and a mocked global clock is a worse tool than an
argument.

What goes where:

| Level | Belongs here | Does not belong here |
|---|---|---|
| **Unit** | scheduling arithmetic, personalisation, condition evaluation, limits/pacing, state machines, reply/bounce classification, crypto, zod schemas, redaction | anything needing Postgres, anything needing HTTP |
| **Integration** | repo functions against real Postgres, workspace isolation, transaction semantics, queue leasing with real concurrency, migrations from scratch, provider adapters vs. the fake | UI, browser, rendering |
| **E2E** | the one full happy path, a11y, the five states, navigation, forms | business-rule permutations (they are 100× cheaper one level down) |

Coverage target: **≥ 90% on `modules/sending/**`, `modules/replies/**`,
`modules/jobs/**`, `lib/crypto.ts`, and `lib/time.ts`.** No global coverage
number — a repo-wide percentage encourages testing getters to hit a target.
These five paths are where a bug costs the most, so they are where the bar is.

### 8.2 Unit tests (`bun test`, `tests/unit/**`)

Concrete table of test name → the exact edge case it pins down. This is the
implementation checklist; a PR touching one of these areas adds to this table.

#### Personalisation and variable substitution — `tests/unit/personalisation.test.ts`

| Test name | Pins down |
|---|---|
| `substitutes a known variable` | `Hi {{firstName}}` + `{firstName:'Ada'}` → `Hi Ada` |
| `uses the fallback when the value is missing` | `{{firstName\|there}}` + `{}` → `there` |
| `uses the fallback when the value is an empty string` | **`firstName: ''` must take the fallback, not render `Hi ,`** — an imported CSV with a blank cell is the single most common real cause of an embarrassing email |
| `uses the fallback when the value is whitespace only` | `firstName: '  '` → fallback; trim before the emptiness test |
| `renders nothing for an unknown variable with no fallback` | `{{nope}}` → `''`, and the render is flagged so the UI can warn — never leaves `{{nope}}` visible to a recipient |
| `does not recurse into substituted values` | value `'{{lastName}}'` renders literally; blocks a template-injection loop via lead data |
| `escapes HTML in values for the html part` | `firstName: '<script>alert(1)</script>'` → escaped in HTML, raw in text |
| `does not double-escape already-escaped entities` | `'Tom &amp; Jerry'` stays `'Tom &amp; Jerry'` |
| `leaves a lone brace alone` | `'100% {of} it'` untouched |
| `handles an unclosed tag without throwing` | `'Hi {{firstName'` → literal, no exception |
| `is case-sensitive and predictable` | `{{FirstName}}` ≠ `{{firstName}}`; documented, not silently coerced |
| `strips a leading formula character from a value` | `firstName: '=cmd|calc'` — the value came from a CSV; it must not be re-exported as a live formula |
| `substitutes in subject and both body parts` | one code path, three targets |
| `reports every missing variable in one pass` | preview UI needs the full list, not the first failure |
| `handles a 500-variable template without quadratic blowup` | a perf floor, so a naive replace-in-a-loop is caught |

#### Scheduling and next-send-time — `tests/unit/scheduling.test.ts`

The nastiest area in the product, because timezones and DST are not negotiable
and the failure is a 3am email.

| Test name | Pins down |
|---|---|
| `returns the same instant when inside the window` | no gratuitous deferral |
| `defers to the window start when before it` | 07:00 local, window 09:00–17:00 → 09:00 local, correct UTC |
| `defers to the NEXT day when after the window` | 18:00 Tue → 09:00 Wed |
| `skips Saturday and Sunday when weekdays only` | Fri 18:00 → Mon 09:00 |
| `skips a configured holiday` | Mon is a holiday → Tue 09:00 |
| `computes the window in the CAMPAIGN timezone, not the server's` | server `UTC`, campaign `America/New_York` — the whole reason we store UTC and render local (brief §9) |
| `handles a mailbox in Asia/Kolkata (UTC+5:30)` | half-hour offsets |
| `handles Asia/Kathmandu (UTC+5:45)` | quarter-hour offsets; catches integer-hour assumptions |
| **`DST spring-forward: 02:30 local does not exist`** | US 2026-03-08, window starting 02:00 — the wall time 02:30 is skipped entirely. Must resolve forward to 03:00 local, never throw and never produce an hour-earlier UTC |
| **`DST spring-forward inside the send window`** | window 01:00–05:00 on the transition day is **3 hours long, not 4**; the pacing spread must not schedule into the missing hour |
| **`DST fall-back: 01:30 local happens twice`** | US 2026-11-01 — must pick the **first** occurrence deterministically, and never send twice by scheduling into both |
| `DST fall-back window is 5 hours, not 4` | daily-cap spreading uses real elapsed time |
| `southern-hemisphere DST (Australia/Sydney) goes the other way` | catches a hard-coded northern assumption |
| `a timezone with no DST (Asia/Kolkata) is unaffected` | control case |
| `window boundary is inclusive at the start` | exactly 09:00:00 → SEND |
| `window boundary is exclusive at the end` | exactly 17:00:00 → DEFER; off-by-one at the edge means a send one minute outside the promised window |
| `a window crossing midnight (22:00–02:00) works` | supported or explicitly rejected — decide and pin it |
| `startMinute == endMinute is rejected` | a zero-length window would spin forever; must be a validation error |
| `an invalid IANA timezone is rejected, not defaulted to UTC` | silently defaulting to UTC is how you send at 3am |
| `respects step delay before applying the window` | step 2 = +3 days → +3 days *then* snap into the window, not the reverse |
| `a delay of 0 days on the same day still respects the window` | |
| `is deterministic — same input, same output, 1000 runs` | no hidden clock read, no `Math.random` in the path |

#### Sequence condition evaluation — `tests/unit/sequence-conditions.test.ts`

| Test name | Pins down |
|---|---|
| `step 2 runs when step 1 was sent and no reply` | the base case |
| `step 2 is suppressed when a reply exists` | brief §1.2 |
| `condition "if not opened" evaluates false when opens are unknown` | open tracking is unreliable (brief §10) — an unknown open must not be treated as "not opened", or every recipient gets the "did you see this?" follow-up |
| `condition "if clicked" requires an actual CLICKED event` | |
| `an unsubscribed lead is suppressed at every step` | |
| `a bounced lead is suppressed at every subsequent step` | hard bounce means stop, permanently |
| `a soft bounce does not permanently suppress` | distinguishes the two |
| `A/B variant assignment is stable for a lead` | same lead → same variant across re-evaluations, so a retry does not flip variant |
| `an unknown condition type throws rather than defaulting to true` | defaulting to "send" is the dangerous default |

#### Daily limits and pacing — `tests/unit/limits.test.ts`

| Test name | Pins down |
|---|---|
| `allows a send when sentToday < dailyLimit` | |
| `denies at exactly dailyLimit` | off-by-one on the cap = one email over the promise |
| `counts SENT only, not QUEUED or FAILED` | retries must not consume the cap twice |
| `resets the count at midnight in the MAILBOX timezone` | not server midnight |
| `the reset boundary on a DST day is still one calendar day` | 23h and 25h days both reset once |
| `spreads N sends across the remaining window` | 40 sends, 8h left → ~12 min apart, not 40 in one burst (deliverability) |
| `respects a minimum gap between sends from one mailbox` | e.g. ≥60s; a burst is a spam signal |
| `enforces the limit per MAILBOX, not per campaign` | two campaigns sharing a mailbox share its cap — the invariant is per-mailbox (brief §1.4) |
| `warmup ramp raises the cap by day-of-life` | day 1 = 5, day 30 = 50; a monotonic non-decreasing series |
| `never exceeds the configured ceiling even mid-ramp` | |
| `a mailbox rate-limited by the provider is capped for the day regardless of our count` | the provider is authoritative (§6.4) |

#### State machines — `tests/unit/state-machines.test.ts`

Every machine gets a **full transition matrix**: for each `(state, event)` pair,
either the legal next state or a thrown `IllegalTransitionError`. Generated as a
table, so the test count is `states × events` and no pair is forgotten.

| Machine | States | Sample legal | Sample illegal (must throw) |
|---|---|---|---|
| `Campaign` | `DRAFT, ACTIVE, PAUSED, COMPLETED, ARCHIVED` | `DRAFT→ACTIVE`, `ACTIVE→PAUSED`, `PAUSED→ACTIVE` | `COMPLETED→ACTIVE`, `ARCHIVED→ACTIVE`, `DRAFT→PAUSED` |
| `ScheduledEmail` | `PENDING, QUEUED, SENDING, SENT, FAILED, CANCELLED, SUPPRESSED` | `PENDING→QUEUED→SENDING→SENT` | **`SENT→QUEUED`** (the duplicate-send door), `SENT→SENDING`, `CANCELLED→SENDING`, `SENT→CANCELLED` |
| `Job` | `PENDING, RUNNING, RETRYING, SUCCEEDED, DEAD, CANCELLED` | `PENDING→RUNNING→SUCCEEDED`, `RUNNING→RETRYING→RUNNING` (retry), `RETRYING→DEAD` (attempts exhausted) | `SUCCEEDED→RUNNING`, `DEAD→PENDING` (only an explicit operator requeue, which is a different, audited transition) |
| `Mailbox` | `CONNECTING, CONNECTED, AUTH_FAILED, DISCONNECTED, RATE_LIMITED` | `CONNECTED→AUTH_FAILED`, `AUTH_FAILED→CONNECTED` (re-consent) | `DISCONNECTED→CONNECTED` without a fresh credential |
| `Lead` (per campaign) | `ACTIVE, REPLIED, UNSUBSCRIBED, BOUNCED, COMPLETED, SUPPRESSED` | `ACTIVE→REPLIED` | **`REPLIED→ACTIVE`** — once stopped, a sequence never resumes itself |
| `Opportunity` | pipeline stages | forward and backward moves | move to a stage from another workspace's pipeline |

Plus, explicitly: **`transition()` is a pure function** `(state, event) → state`,
so the machine is testable without a database, and the repo layer's only job is
to persist the result under a conditional `UPDATE`.

#### Reply / bounce / auto-reply detection and thread association — `tests/unit/reply-detection.test.ts`

| Test name | Pins down |
|---|---|
| `associates a reply by In-Reply-To matching our Message-ID` | the primary, reliable signal |
| `falls back to the References chain` | some clients rewrite `In-Reply-To` |
| `falls back to Gmail threadId when headers are unusable` | provider-specific last resort |
| `does not associate on subject match alone` | `Re: Hello` from an unrelated person must not stop a sequence |
| `classifies an out-of-office as AUTO, not a human reply` | `Auto-Submitted: auto-replied` — **an OOO must NOT stop the sequence**; that is the single most damaging false positive in the product |
| `classifies a vacation reply without Auto-Submitted via heuristics` | `X-Autoreply`, `Precedence: auto_reply`, `Return-Path: <>` |
| `classifies a DSN/bounce as BOUNCE, not a reply` | `Content-Type: multipart/report; report-type=delivery-status` |
| `distinguishes hard (5.x.x) from soft (4.x.x) DSN status` | drives suppress-vs-retry |
| `classifies a Gmail "Delivery Status Notification (Failure)" without a proper DSN part` | Gmail does not always send a clean DSN |
| `treats a reply from a colleague on the thread as a human reply` | forwarded internally still means stop |
| `ignores our own sent message appearing in the sync` | we must not detect ourselves as a reply — an easy and fatal bug |
| `handles a reply to a step-1 email arriving after step 2 was already scheduled` | must cancel step 2 while it is still `PENDING`/`QUEUED` |
| **`a reply arriving between the schedule decision and the send is caught at send time`** | the decision is re-checked immediately before the provider call; `decideSend` must return `SUPPRESS{replied}` given a lead whose `repliedAt` post-dates the schedule. This race is unavoidable — the mitigation is the last-moment re-check, and this test is what proves it exists |
| `an auto-reply followed by a real reply results in a stop` | ordering independence |
| `a reply on campaign A does not stop campaign B` | scope is (lead, campaign) |
| `a reply detected twice is idempotent` | one stop, one `EmailEvent`, no double CRM opportunity |
| `an unparseable MIME message is recorded as unclassified, not dropped` | never silently lose an inbound message |

#### Crypto and key rotation — `tests/unit/crypto.test.ts`

| Test name | Pins down |
|---|---|
| `round-trips a secret` | `decrypt(encrypt(x)) === x` |
| `round-trips unicode and a 4KB value` | refresh tokens are long; emoji break naive byte handling |
| `produces a different ciphertext for the same plaintext twice` | the IV is random — a deterministic ciphertext leaks equality |
| `stamps the current key version` | |
| `decrypts a v1 ciphertext with the previous key while v2 is current` | the §4.2 dual-read window |
| `throws CredentialKeyMissingError for an unknown key version` | loud, not garbage |
| `rejects a tampered ciphertext` | flip one byte → GCM auth failure throws, never returns plaintext |
| `rejects a truncated ciphertext` | shorter than iv+tag |
| `rejects a swapped-payload ciphertext` | valid ct from another record + this record's iv fails |
| `re-encrypt is idempotent under the keyVersion guard` | re-running the rotation job changes nothing |
| `an ENCRYPTION_KEY that is not 32 bytes fails at construction` | matches the env refinement |

#### zod schema edge cases — `tests/unit/schemas.test.ts`

| Test name | Pins down |
|---|---|
| `rejects a workspaceId supplied in a request body` | brief §4.2 — the field must be **absent from the schema entirely**, so `.strict()` rejects it. Test asserts the parse *fails*, not that the value is ignored |
| `strips unknown keys on every input schema` | `.strict()` everywhere at trust boundaries |
| `normalises an email to lowercase and trims it` | dedupe depends on it |
| `rejects an email with a display name` | `"A" <a@b.c>` in a CSV email column |
| `accepts a valid IANA timezone, rejects "EST"` | |
| `caps CSV import rows and file size` | brief §6 |
| `rejects a CSV header row with duplicate columns` | |
| **`a CSV cell beginning with = + - @ tab or CR is neutralised on export`** | formula injection (brief §6). Both directions: stored raw-ish, exported prefixed with `'` |
| `rejects a sequence with zero steps` | |
| `rejects a step delay that is negative or > 365 days` | |
| `rejects a daily limit of 0 or > the provider ceiling` | |
| `rejects HTML with a script tag in a template body` | sanitised before storage |
| `a password below the minimum length is rejected before hashing` | |
| `an unsubscribe token is opaque and single-purpose` | not a session token, not guessable |

#### Logger redaction — `tests/unit/logger.test.ts`

| Test name | Pins down |
|---|---|
| `redacts refreshToken at any nesting depth` | |
| `redacts every key on the deny-list` | table-driven over the list in §5.1 |
| `replaces a body field with a length` | never log email bodies (brief §9) |
| `hashes an email address in a non-audit line` | |
| `emits one line of valid JSON with no newline inside` | a wrapped line is unparseable |
| `includes requestId or jobId on every line` | correlation is not optional |
| `never throws on a circular object` | a logger that crashes the request is worse than no log |

---

## 9. Integration tests (`bun test`, `tests/integration/**`)

Real Postgres, real Prisma, real SQL. **Prisma is never mocked here** — mocking
the thing under test would leave us testing our mock's opinion of `SKIP LOCKED`.

Connection: `DATABASE_URL` from `.env.test` → `instantmail_test` on the
user-space cluster (port 5433), the same database CI creates as a service
container.

### 9.1 Database reset between tests — truncate, not transaction rollback

**Decision: truncate.** Justification, because the alternative is tempting:

Transaction-rollback isolation (open a transaction in `beforeEach`, roll back in
`afterEach`, hand the transaction client to the code under test) is faster and
gives perfect isolation — but it *cannot test the things we most need to test*:

- The queue's correctness depends on **`SELECT … FOR UPDATE SKIP LOCKED` across
  two concurrent connections.** Inside a single wrapping transaction there is
  only one connection, so the entire lease mechanism is untestable.
- Our repos use `prisma.$transaction` internally. Nesting real transactions
  inside a wrapper turns them into savepoints, which have different visibility
  and locking behaviour than the real thing.
- `ON CONFLICT` / unique-violation paths behave differently mid-transaction.

So:

```ts
// tests/integration/setup.ts
import { beforeEach, afterAll } from 'bun:test';
import { prisma } from '@/lib/db';

/** Every table except Prisma's own bookkeeping, discovered at runtime so a new
 *  table is covered automatically — a hand-maintained list rots silently. */
async function truncateAll() {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename NOT LIKE '\_prisma%'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  // One statement: RESTART IDENTITY resets sequences, CASCADE ignores FK order.
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

beforeEach(truncateAll);
afterAll(async () => { await prisma.$disconnect(); });
```

`TRUNCATE … CASCADE` on an empty-ish schema is single-digit milliseconds — the
speed argument for rollback does not survive contact with our table sizes. The
schema itself is created **once per run** by
`prisma migrate reset --force --skip-seed` (the `test:db:reset` script), which
is also the assertion that migrations apply from scratch.

Integration tests run **serially** (`bun test` does not parallelise across files
by default; keep it that way) because they share one database. The one exception
is the concurrent-lease test, which spawns its own connections deliberately.

### 9.2 Fixtures and factories

No shared "seed the world" fixture — a global fixture becomes a hidden
dependency that every test silently relies on and nobody dares change. Instead,
composable factories that create the minimum and return typed rows.

```ts
// tests/integration/factories.ts
export async function makeWorkspace(over?: Partial<Workspace>): Promise<{
  workspace: Workspace; owner: User; ctx: Ctx;      // ctx is ready to pass to services
}>;

export async function makeUser(o?: Partial<User>): Promise<User>;
export async function makeMailbox(ctx: Ctx, o?: Partial<Mailbox>): Promise<Mailbox>;
export async function makeLead(ctx: Ctx, o?: Partial<Lead>): Promise<Lead>;
export async function makeLeads(ctx: Ctx, n: number): Promise<Lead[]>;
export async function makeCampaign(ctx: Ctx, o?: {
  steps?: number; mailboxId?: string; status?: CampaignStatus;
}): Promise<Campaign>;
export async function makeScheduledEmail(ctx: Ctx, o?: Partial<ScheduledEmail>): Promise<ScheduledEmail>;
export async function makeJob(o?: Partial<Job>): Promise<Job>;

/** The isolation workhorse: two fully independent tenants in one call. */
export async function makeTwoWorkspaces(): Promise<{ a: Ctx; b: Ctx }>;
```

Rules: every factory takes `ctx` and derives `workspaceId` from it (so a factory
cannot accidentally create an unscoped row); every default is deterministic
except identity-unique fields, which use a per-run counter rather than random
values (`lead-1@example.test`, not a UUID) so failures are readable; no factory
reaches for `new Date()` when a test cares about time — it takes the date.

### 9.3 Workspace isolation — a systematic sweep, not spot checks

Brief §4 calls this the single most important invariant, so it gets the most
mechanical test in the suite. Spot-checking a few endpoints is how a leak ships.

```ts
// tests/integration/workspace-isolation.test.ts
//
// Every exported repo function is listed here with a call shape. A function
// missing from this list FAILS the suite — the test enumerates the module's
// exports and asserts each one is covered. That is what makes this a sweep
// rather than a sample, and it makes the test the reason to remember.

type IsolationCase = {
  name: string;
  /** Create the row inside workspace A. */
  arrange: (a: Ctx) => Promise<{ id: string }>;
  /** Call the repo/service as workspace B, asking for A's row. */
  act: (b: Ctx, id: string) => Promise<unknown>;
  /** 'notFound' → Result error / null / throws NotFound (never 403, brief §4.5)
   *  'empty'    → list functions return [] and a count of 0
   *  'noop'     → writes affect 0 rows and A's row is byte-identical after */
  expect: 'notFound' | 'empty' | 'noop';
};

const cases: IsolationCase[] = [ /* one per exported repo function */ ];

for (const c of cases) {
  test(`isolation: ${c.name}`, async () => {
    const { a, b } = await makeTwoWorkspaces();
    const row = await c.arrange(a);
    const before = await snapshot(row.id);
    const result = await c.act(b, row.id);
    assertIsolation(c.expect, result);
    expect(await snapshot(row.id)).toEqual(before);   // A's data untouched
  });
}
```

Additional isolation assertions, each its own test:

| Test | Pins down |
|---|---|
| `every tenant-owned table has a NOT NULL workspaceId` | queries `information_schema.columns` against a list of tenant tables — a new table without the column fails CI |
| `every unique constraint on a tenant table includes workspaceId` | queries `pg_index`; catches a bare-global unique (brief §4.6) |
| `a workspaceId in an action payload is rejected by the schema` | pairs with the unit test; here it goes through the real action wrapper |
| `a MEMBER cannot perform an OWNER-only action` | role enforcement is server-side (brief §6) |
| `a user removed from a workspace immediately loses access` | session survives, authorization does not |
| `cross-workspace access logs authz.cross_workspace_attempt` | the alert in §5.5 has something to fire on |
| `a foreign-workspace id in a nested relation (e.g. leadId on a campaign) is rejected` | the sneaky one — the parent is yours, the child is not |

### 9.4 The queue's concurrent-lease behaviour

The single most important integration test in the repo, because "we never send
the same email twice" (brief §1.3) lives or dies here.

```ts
// tests/integration/queue-concurrency.test.ts

test('two concurrent workers never lease the same job', async () => {
  await seedJobs(200, { status: 'PENDING', runAt: past() });

  // Real concurrency: separate PrismaClients = separate connections. Promise.all
  // on one client would serialise through the pool and prove nothing.
  const workers = [newClient(), newClient(), newClient(), newClient()];
  const leased = await Promise.all(workers.map((c) => leaseBatch(c, { limit: 60 })));

  const ids = leased.flat().map((j) => j.id);
  expect(new Set(ids).size).toBe(ids.length);          // no id twice
  expect(ids.length).toBe(200);                        // nothing skipped either
});

test('a job whose lease expired is re-leased exactly once', async () => { … });

test('a crashed worker\'s job is recovered by the sweep', async () => {
  // Lease, then abandon without releasing (simulate SIGKILL by never renewing).
  // Advance leaseExpiresAt into the past, run the sweep, assert PENDING and
  // attempt incremented — not attempt reset, or a poison job runs forever.
});

test('idempotency key prevents a duplicate enqueue', async () => {
  const key = 'send:se_123:attempt';
  await enqueue({ type: 'SEND', dedupeKey: key });
  await enqueue({ type: 'SEND', dedupeKey: key });
  expect(await countJobs({ dedupeKey: key })).toBe(1);
});

test('the same ScheduledEmail cannot be sent twice under concurrent workers', async () => {
  // The real invariant, end to end: two workers, one ScheduledEmail, a fake
  // provider that counts calls. Expect exactly ONE provider send and one SENT
  // event, whichever worker wins.
});

test('enqueue rolls back with its causing row', async () => {
  // Transactional enqueue is the reason we chose Postgres for the queue
  // (brief §5): if the ScheduledEmail insert rolls back, its Job must not exist.
  await expect(prisma.$transaction(async (tx) => {
    await createScheduledEmail(tx, …);
    await enqueue(tx, …);
    throw new Error('boom');
  })).rejects.toThrow();
  expect(await countJobs({})).toBe(0);
  expect(await countScheduledEmails({})).toBe(0);
});

test('backoff schedules the retry with jitter inside the expected band', async () => { … });
test('attempt beyond maxAttempts moves the job to DEAD, not PENDING', async () => { … });
test('per-mailbox rate limiting holds across two workers', async () => {
  // Two workers, one mailbox, limit 5 → exactly 5 sends. If pacing lives only in
  // process memory this test fails, which is precisely why it exists (§1.2).
});
```

### 9.5 Repo behaviour, transactions, and migrations

| Test | Pins down |
|---|---|
| `migrations apply from scratch on an empty database` | `migrate reset` in `test:db:reset` is the assertion; a dedicated test additionally asserts `migrate status` reports zero pending afterwards |
| `the Prisma schema matches the migration history` | `prisma migrate diff --from-migrations --to-schema-datamodel --exit-code` returns 0 — catches a schema edit committed without its migration |
| `a failed transaction leaves no partial write` | multi-table service (campaign + steps + scheduled emails) throwing midway |
| `a unique-violation surfaces as a typed Result, not a raw Prisma error` | `Result<T,E>` at the boundary (brief §9) |
| `pagination is stable under concurrent inserts` | keyset pagination, not `OFFSET`, or page 2 skips rows |
| `soft-deleted rows are excluded from every list query` | if we have soft delete at all |
| `cascade deletes remove children and their EmailEvents are retained` | the fact log is append-only; deleting a lead must not rewrite history |
| `EmailEvent is append-only in practice` | attempt an `UPDATE`/`DELETE` through the repo API — no such function should exist |
| `an EmailEvent insert is idempotent under retry` | unique on `(scheduledEmailId, type)` where applicable |

### 9.6 Provider adapters against a fake Gmail

The `MailProvider` interface (owned by `05`) is implemented twice: `GmailProvider`
and `FakeProvider`. **The same test file runs against both**, so the fake cannot
drift into a fiction.

```ts
// tests/integration/provider-contract.test.ts
const implementations: Array<[string, () => MailProvider]> = [
  ['fake', () => new FakeProvider()],
  // Gmail runs only when a sandbox credential is present; skipped in CI. CI
  // correctness rests on the contract, not on Google being reachable.
  ...(process.env.GMAIL_SANDBOX_REFRESH_TOKEN ? [['gmail', () => new GmailProvider(…)]] : []),
];

for (const [name, make] of implementations) {
  describe(`MailProvider contract: ${name}`, () => {
    test('send returns a stable providerMessageId and a threadId');
    test('sending a reply with inReplyTo keeps the same threadId');
    test('a 429 surfaces as ProviderRateLimited with retryAfterMs');
    test('a 401 surfaces as ProviderAuthFailed and never as a generic error');
    test('a 5xx surfaces as transient, a 400 as permanent');
    test('listMessagesSince is inclusive-exclusive and does not skip a message');
    test('listMessagesSince paginates past one page');
    test('a message with no text/plain part still yields a body');
    test('an attachment does not break parsing');
    test('refreshAccessToken returns a new token without mutating the refresh token');
  });
}
```

The fake's failure injection is what makes error paths testable at all:

```ts
class FakeProvider implements MailProvider {
  // Deterministic queues, not randomness — a flaky fake is worse than no fake.
  failNextSendWith(err: ProviderError): void;
  rateLimitNextSend(retryAfterMs: number): void;
  enqueueInbound(msg: FakeInboundMessage): void;   // simulate a reply / OOO / DSN
  sentMessages: ReadonlyArray<SentRecord>;         // assertions read this
  delayNextSendMs(ms: number): void;               // exercise lease renewal
}
```

---

## 10. E2E tests (Playwright, `tests/e2e/**`)

Few, slow, and about *the product working*, not about business-rule
permutations. Target: one full happy path, one a11y sweep, one five-states
sweep, and a handful of guards. If a rule can be tested at the unit level, it is
tested there — E2E is where we prove the wires are connected.

### 10.1 The provider-stubbing seam (a design requirement, not a test trick)

Determinism in E2E is impossible if the app talks to real Gmail: OAuth needs a
human, sends are slow and rate-limited, and inbound mail arrives whenever it
feels like it. So the provider abstraction must be **swappable by configuration
at process boot**, and this is a constraint on `05-mailboxes-and-providers`, not
something tests can bolt on afterwards:

```ts
// src/modules/mailboxes/provider-registry.ts  (owned by 05; required shape)
export type ProviderKind = 'gmail' | 'fake';

/** The ONLY way any code obtains a provider. No `new GmailProvider()` anywhere else. */
export function getProvider(mailbox: { provider: ProviderKind }): MailProvider;
```

Three requirements this places on `05`:

1. **`MailProvider` is a complete interface.** Every Gmail interaction the app
   performs — OAuth exchange, token refresh, send, list-since, get-message,
   watch/renew — is a method on it. If any code path reaches `googleapis`
   directly, that path is untestable and the seam is broken.
2. **Selection is data-driven.** `Mailbox.provider` is a column. When
   `E2E_FAKE_PROVIDER=1`, the registry returns `FakeProvider` for every mailbox
   regardless of column value. That env var is read **only** in the registry, is
   rejected by the env schema when `NODE_ENV=production`, and is the entire
   stubbing mechanism.
3. **The OAuth flow has the same seam.** `/api/oauth/google/start` and
   `/callback` go through the registry too, so with the fake in place "Connect
   Gmail" completes locally in one redirect with a synthetic code — no Google, no
   consent screen, no human.

The fake's control surface for E2E is an HTTP endpoint, because the test runs in
a browser and the app runs in another process:

```
POST /api/test/fake-provider/inbound     ← only mounted when E2E_FAKE_PROVIDER=1
  { mailboxId, inReplyToMessageId, from, subject, body, kind: 'human'|'ooo'|'bounce' }

POST /api/test/worker/drain              ← runs one deterministic drain, returns counts
GET  /api/test/fake-provider/sent        ← what "Gmail" received
```

These routes live behind the same flag and return **404 when it is unset**, so
they cannot exist in production. Belt and braces: the env schema refines
`E2E_FAKE_PROVIDER !== '1' when NODE_ENV === 'production'`, so a mis-set flag is
a boot failure rather than a test backdoor on the internet.

**Draining the worker from the test, not running it.** E2E starts the web server
only; the test triggers `POST /api/test/worker/drain` at the exact moment it
wants sending to happen. This is what removes the flakiness — no polling for a
background loop, no arbitrary sleeps.

### 10.2 The happy path

```
tests/e2e/happy-path.spec.ts   — one test, the whole loop, ~40s

 1. register  → workspace created, landed on the dashboard
 2. mailboxes → "Connect Gmail" → fake OAuth round-trip → mailbox CONNECTED,
                shown with its email address
 3. leads     → import a 3-row CSV (one row deliberately blank firstName)
                → 3 leads listed, the blank one shows its fallback in preview
 4. campaigns → create, name it, assign the lead list, pick the mailbox
 5. sequence  → step 1 "Hi {{firstName|there}}", add step 2 with a 3-day delay,
                set the send window and timezone, verify the preview renders
 6. launch    → status ACTIVE; ScheduledEmail rows visible as "scheduled"
 7. drain     → POST /api/test/worker/drain
                → step 1 SENT; the fake recorded exactly one message with the
                  substituted body; the timeline shows "Sent"
 8. reply     → POST fake inbound { kind:'human', inReplyTo: <step1 id> }
                → drain again
 9. assert    → lead state REPLIED
                → step 2 is CANCELLED, not pending  ← brief §1.2, the invariant
                → analytics shows 1 sent, 1 replied
10. inbox     → the reply appears in the thread, with our sent message above it
11. reply     → type a reply, send → drain → the fake recorded a second message
                on the SAME threadId, and the thread shows both
```

One test, not eleven. Split into eleven and each one re-does the ten steps
before it, or worse, shares state and becomes order-dependent. A single
narrative test that fails at step 9 tells you exactly as much and runs in a
tenth of the time.

Additional E2E specs, each small:

| Spec | Asserts |
|---|---|
| `auth.spec.ts` | login, logout, wrong password shows an error, a protected route redirects, session survives reload |
| `ooo-does-not-stop.spec.ts` | inbound `kind:'ooo'` → the sequence stays active and step 2 remains scheduled. The nastiest false positive, worth its own E2E |
| `isolation.spec.ts` | user B navigating directly to A's campaign URL gets a 404 page, not a 403 and not data |
| `five-states.spec.ts` | §10.4 |
| `a11y.spec.ts` | §10.3 |

### 10.3 Accessibility assertions

The brief calls a11y a hard gate (brief §7), so it is a failing test rather than a
review opinion.

```ts
// tests/e2e/a11y.spec.ts
import AxeBuilder from '@axe-core/playwright';

const pages = ['/dashboard', '/inbox', '/leads', '/campaigns', '/campaigns/new',
               '/campaigns/:id/sequence', '/mailboxes', '/analytics', '/crm',
               '/settings', '/login'];

for (const path of pages) {
  test(`axe: ${path} has no serious or critical violations`, async ({ page }) => {
    await page.goto(path);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad, JSON.stringify(bad.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2))
      .toEqual([]);
  });
}
```

Plus explicit keyboard-only traversal tests, because axe cannot see focus order
or a keyboard trap:

| Test | Asserts |
|---|---|
| `the app shell is fully keyboard navigable` | Tab from the top reaches every nav item and the primary action; a visible focus ring is present at each stop (`:focus-visible` computed outline ≠ none) |
| `the sequence builder is operable without a mouse` | add a step, reorder it, edit its body, save — all via keyboard. Named in the brief (§7) as a hard requirement, so it is a named test |
| `the inbox is operable without a mouse` | move between threads, open one, reply, archive |
| `a dialog traps focus and restores it on close` | focus enters the dialog, cannot Tab out, Escape closes, focus returns to the trigger |
| `an icon-only button has an accessible name` | sweep every `button:not(:has(text))` on each page and assert `aria-label` or `title` |
| `async results are announced` | an `aria-live` region receives the text after a save/import |
| `no element relies on colour alone for status` | every status pill has a text label or an icon next to the colour |
| `prefers-reduced-motion disables transitions` | emulate the media feature, assert `transition-duration: 0s` on animated elements |
| `tab order follows visual order on the campaign form` | catches a CSS-reordered layout |

### 10.4 The five states

Brief §8: every async surface ships loading, empty, success, error,
unauthorized — plus disconnected and rate-limited where they apply. "A blank
screen is a bug," so it is a *failing* test.

```ts
// tests/e2e/five-states.spec.ts
// Each state is forced deterministically. No sleeps, no luck.
const surfaces = ['/leads', '/campaigns', '/inbox', '/mailboxes', '/analytics', '/crm'];
```

| State | How it is forced | Asserted |
|---|---|---|
| loading | `page.route` delays the data request; assert before it resolves | a **skeleton** matching the eventual layout — not a bare spinner, not blank |
| empty | fresh workspace, no data | explanatory copy **and a next action** (a real link/button that works) |
| success | factory-seeded rows | rows render; counts match |
| error | route intercepted → 500 | an error message **and a retry control**; clicking retry re-requests |
| unauthorized | a MEMBER-role session on an OWNER-only surface | an explanatory state, not a crash, not a silent empty list |
| disconnected | mailbox forced to `DISCONNECTED` | a prominent banner with a reconnect action (`/mailboxes`, campaign pages) |
| rate-limited | mailbox forced to `RATE_LIMITED` | honest "capped until <time>" copy rather than a stalled spinner (§6.4 follow-up) |

Also asserted here: **no fake functionality** (brief §8). Every `button` and
`a[href]` on each page is either enabled and produces a visible effect, or is
disabled with an accessible explanation of why. A control that looks live and
does nothing fails this test.

### 10.5 Playwright configuration

```ts
// playwright.config.ts
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,               // shared database; parallelism would be a lie
  workers: 1,
  retries: process.env.CI ? 1 : 0,    // ONE retry, and any retry that passes is
                                      // triaged as a flake bug, not celebrated
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Production build, not `next dev` — dev-mode compile pauses are the #1
    // source of E2E flake, and we want to test what we ship.
    command: 'bun run build && bun run start',
    url: 'http://127.0.0.1:3000/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { E2E_FAKE_PROVIDER: '1', NODE_ENV: 'production' },
  },
  globalSetup: './tests/e2e/global-setup.ts',   // migrate reset + minimal seed
});
```

One browser (Chromium) in v1. This is a desktop productivity tool (brief §8) and
cross-browser rendering differences are not the risk we are managing; adding
WebKit and Firefox triples the slowest stage to catch bugs we are unlikely to
have. Revisit if a real cross-browser bug ships.

---

## 11. Continuous integration

### 11.1 Stages, in order

Ordered by *cost of feedback*: the cheapest thing that can fail runs first, so a
missing semicolon does not cost eight minutes of Playwright.

```
 1. install        bun install --frozen-lockfile      ~20s   ← lockfile drift fails here
 2. generate       prisma generate                    ~10s
 3. typecheck      tsc --noEmit                       ~30s
 4. lint           next lint + import-rule checks     ~20s
 5. format         prettier --check                    ~5s
 6. secrets        gitleaks detect                    ~10s
 7. unit           bun test tests/unit                 ~5s
 ─── gate: everything above must pass before Postgres is even started ───
 8. migrate        prisma migrate reset --force       ~15s   ← "applies from scratch"
 9. integration    bun test tests/integration         ~90s
10. build          bun run build                      ~60s
11. e2e            playwright test                   ~180s
```

Stages 1–7 run in one job (`quality`), 8–9 in a second (`integration`, needs
Postgres), 10–11 in a third (`e2e`, needs Postgres + a build). `quality` and
`integration` run in parallel — the ordering above is about *within-job* order
and about what blocks `e2e`.

### 11.2 PR vs main

| Stage | PR | push to `main` | nightly |
|---|---|---|---|
| install → unit (1–7) | ✅ | ✅ | ✅ |
| migrate + integration (8–9) | ✅ | ✅ | ✅ |
| build (10) | ✅ | ✅ | ✅ |
| e2e (11) | ✅ | ✅ | ✅ |
| coverage report on the hot paths | ✅ (comment) | ✅ | — |
| deploy | — | ✅ (after all green) | — |
| E2E against real Gmail sandbox | — | — | ✅ |
| restore rehearsal (§3.5) | — | — | monthly |

E2E runs on **every PR**. It is the slowest stage and the temptation is to make
it main-only, but the invariant it guards — a reply stops the sequence — is one
we cannot afford to discover broken after merge. Three minutes is a fair price.

The one concession: E2E is skipped when a PR touches only `docs/**` or `*.md`
(a `paths-ignore` on the e2e job).

### 11.3 Postgres in CI

A GitHub Actions **service container** (`postgres:16-alpine`), not the
user-space cluster — CI has Docker even though this dev machine does not, and a
service container is one line of YAML against ~30 lines of `initdb` scripting.
The connection string is the only difference between CI and local, and it comes
from `.env.test`'s value being overridden by the job's `DATABASE_URL`.

Caching: Bun's global cache keyed on `bun.lock`, and `.next/cache` keyed on
lockfile + source hash for incremental builds. Prisma's generated client is
**not** cached — it is 10 seconds to generate and a stale cached client is a
confusing failure.

### 11.4 The workflow

```yaml
# .github/workflows/ci.yml   — the lead creates this file; this is its content.
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  # A new push supersedes an in-flight run for the same ref. main is never cancelled.
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}

env:
  BUN_VERSION: '1.4.0'

jobs:
  # ── 1–7: everything that needs no database ────────────────────────────────
  quality:
    name: quality (typecheck · lint · unit)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # gitleaks needs history

      - uses: oven-sh/setup-bun@v2
        with: { bun-version: '${{ env.BUN_VERSION }}' }

      - name: Cache bun install
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: bun-${{ runner.os }}-

      - run: bun install --frozen-lockfile
      - run: bunx prisma generate

      # Env values come from the committed .env.test — no repo secrets needed,
      # which is what makes fork PRs safe to run.
      - run: cp .env.test .env

      - name: Typecheck
        run: bun run typecheck

      - name: Lint
        run: bun run lint

      - name: Format check
        run: bun run format:check

      - name: Secret scan
        uses: gitleaks/gitleaks-action@v2
        env: { GITLEAKS_ENABLE_UPLOAD_ARTIFACT: 'false' }

      - name: Unit tests
        run: bun test tests/unit --coverage

      # Fails the job if the hot paths regress below the bar. Not a global %.
      - name: Coverage gate (sending · replies · jobs · crypto · time)
        run: bun run scripts/coverage-gate.ts --min 90 \
               --paths src/modules/sending src/modules/replies src/modules/jobs \
                       src/lib/crypto.ts src/lib/time.ts

  # ── 8–9: real Postgres ───────────────────────────────────────────────────
  integration:
    name: integration (migrations · repos · queue)
    runs-on: ubuntu-latest
    timeout-minutes: 15
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: instantmail
          POSTGRES_PASSWORD: instantmail
          POSTGRES_DB: instantmail_test
        ports: ['5433:5432']            # same port as local, so .env.test is unchanged
        options: >-
          --health-cmd "pg_isready -U instantmail"
          --health-interval 5s --health-timeout 5s --health-retries 20
    env:
      DATABASE_URL: postgresql://instantmail:instantmail@127.0.0.1:5433/instantmail_test?schema=public
      DIRECT_DATABASE_URL: postgresql://instantmail:instantmail@127.0.0.1:5433/instantmail_test?schema=public
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: '${{ env.BUN_VERSION }}' }
      - uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
      - run: bun install --frozen-lockfile
      - run: cp .env.test .env
      - run: bunx prisma generate

      # This IS the "migrations apply from scratch" test.
      - name: Apply migrations from scratch
        run: bunx prisma migrate reset --force --skip-seed

      - name: Assert no pending migrations
        run: bunx prisma migrate status

      # Catches a schema.prisma edit committed without its migration.
      - name: Assert schema matches migration history
        run: |
          bunx prisma migrate diff \
            --from-migrations prisma/migrations \
            --to-schema-datamodel prisma/schema.prisma \
            --shadow-database-url "$DATABASE_URL" \
            --exit-code

      - name: Integration tests
        run: bun test tests/integration

  # ── 10–11: build + browser ───────────────────────────────────────────────
  e2e:
    name: e2e (playwright · a11y)
    runs-on: ubuntu-latest
    timeout-minutes: 25
    needs: [quality]                    # do not burn 4 minutes on a type error
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: instantmail
          POSTGRES_PASSWORD: instantmail
          POSTGRES_DB: instantmail_test
        ports: ['5433:5432']
        options: >-
          --health-cmd "pg_isready -U instantmail"
          --health-interval 5s --health-timeout 5s --health-retries 20
    env:
      DATABASE_URL: postgresql://instantmail:instantmail@127.0.0.1:5433/instantmail_test?schema=public
      E2E_FAKE_PROVIDER: '1'
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: '${{ env.BUN_VERSION }}' }
      - uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
      - run: bun install --frozen-lockfile
      - run: cp .env.test .env
      - run: bunx prisma generate
      - run: bunx prisma migrate reset --force --skip-seed

      - name: Cache Next build
        uses: actions/cache@v4
        with:
          path: .next/cache
          key: next-${{ runner.os }}-${{ hashFiles('bun.lock') }}-${{ hashFiles('src/**','prisma/**') }}
          restore-keys: next-${{ runner.os }}-${{ hashFiles('bun.lock') }}-

      - name: Build
        run: bun run build

      - name: Install Playwright browser
        run: bunx playwright install --with-deps chromium

      - name: E2E
        run: bunx playwright test

      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: |
            playwright-report/
            test-results/
          retention-days: 7
```

A separate `nightly.yml` runs the same suite plus the real-Gmail provider
contract tests (using sandbox credentials from repo secrets) on a schedule. It is
allowed to fail without blocking anyone, and its failures are triaged as "Gmail
changed something" rather than "the build is broken."

### 11.5 Required checks on `main`

Branch protection requires, and nothing else:

- `quality (typecheck · lint · unit)`
- `integration (migrations · repos · queue)`
- `e2e (playwright · a11y)`
- one approving review
- branch up to date with `main` before merge (so integration tests ran against
  the merged state, not a stale base)

Deliberately **not** required: the nightly job, and any external-service check.
A required check that depends on a third party is a self-inflicted outage.

---

## 12. Definition of done

### 12.1 Every phase (from brief §11, made checkable)

- [ ] `bun run check` passes locally (typecheck · lint · format · unit)
- [ ] `bun run test:int` passes against a database reset from scratch
- [ ] `bunx prisma migrate reset --force` succeeds — migrations apply from zero
- [ ] `prisma migrate diff … --exit-code` returns 0 — no schema edit without a migration
- [ ] No secret committed (gitleaks green; `.env.example` updated with any new **name**)
- [ ] Every new async surface has all five states, verified in the browser
- [ ] Every new repo function appears in the isolation sweep (§9.3)
- [ ] Every new `EmailEvent` type is documented in the taxonomy (§5.2) if it logs
- [ ] Reviewed by a second person
- [ ] Committed with a meaningful message and pushed

### 12.2 Phase-specific additions

| Phase | Additional gates |
|---|---|
| **1 — Foundation** | `src/lib/env.ts` fails fast on a missing var (test asserts the exit); `/api/health` returns a valid `HealthReport`; login/logout/session-revocation integration tests; the a11y axe sweep is green on the shell and login; the design tokens exist as CSS variables and **no component contains a raw hex** (a lint rule or a grep test) |
| **2 — Mailboxes** | crypto round-trip and rotation unit tests green; the `MailProvider` interface is complete and `getProvider` is the only construction path (grep test asserts no direct `new GmailProvider` outside the registry); `FakeProvider` passes the same contract suite as `GmailProvider`; a plaintext refresh token appears in no log (assert against captured logger output) |
| **3 — Inbox** | thread association unit tests including the OOO and DSN cases; keyboard-only inbox traversal E2E; a message with no `text/plain` renders |
| **4 — Leads** | CSV import row/size caps enforced; formula-injection escaping on export tested both directions; a blank `firstName` renders its fallback in preview; import is streamed (a 50k-row file does not exhaust memory — asserted with a bounded-memory test) |
| **5 — Campaigns** | personalisation table (§8.2) fully green; the sequence builder is keyboard-operable (E2E); preview lists every missing variable |
| **6 — Sending engine** | **the whole of §8.2 scheduling/limits/state-machines green**; §9.4 concurrent-lease suite green including two-worker per-mailbox rate limiting; `decideSend` has ≥90% coverage; a duplicate send is proven impossible under concurrent workers; DST spring-forward and fall-back tests green |
| **7 — Reply automation** | reply-detection table green; the reply-between-schedule-and-send re-check test green; the OOO-does-not-stop E2E green; the full happy-path E2E green |
| **8 — Analytics** | every metric derives from `EmailEvent` (no counter read as truth); open rate is labelled indicative in the UI; a below-threshold sample suppresses the comparative claim (tested) |
| **9 — CRM** | pipeline stage transitions in the state-machine matrix; cross-workspace pipeline move returns 404 |
| **10 — AI** | AI output is zod-validated and an invalid output is rejected and logged (`ai.output_invalid`); model + version + confidence stored; no AI path sends without human approval (tested); absent `ANTHROPIC_API_KEY` renders an honest disabled state rather than erroring |
| **11 — Advanced** | A/B variant assignment is stable per lead; a second provider passes the shared contract suite unchanged |

### 12.3 Anti-goals

Things we explicitly will not do, with the reason, so nobody re-proposes them in
a review:

- **No snapshot tests of entire pages.** A page snapshot fails on every
  intentional copy change and passes through every real bug that does not alter
  the DOM. It trains people to run `--update-snapshots` reflexively, which is
  worse than having no test. Targeted assertions only. (Small snapshots of a
  *pure function's* output — a rendered email body, a generated MIME message —
  are fine and useful.)
- **No mocking Prisma in integration tests.** The point of that layer is to test
  the SQL Prisma actually emits, the constraints Postgres actually enforces, and
  the locking `SKIP LOCKED` actually performs. A mock tests our beliefs about
  those things, which are exactly what is in doubt.
- **No flaky-by-design waits.** No `page.waitForTimeout`, no `sleep(500)`, no
  "retry until it works" loops. Every wait is on an observable condition: a
  locator's state, a network response, an explicit drain call. A test that needs
  a sleep is a test whose seam is missing — fix the seam.
- **No tests that require real Gmail in the required CI path.** Google's
  availability is not our build status. Real-provider tests are nightly and
  non-blocking.
- **No global coverage percentage target.** It rewards testing trivia. Hot-path
  thresholds only (§8.1).
- **No `any` or `@ts-expect-error` in tests.** Tests are code and get the same
  strictness; a test that only compiles because it lies about a type is not
  testing that type.
- **No shared mutable fixture ("the seeded world").** Factories per test. A
  global fixture makes every test's behaviour depend on every other test's
  assumptions.
- **No asserting on log output as a substitute for asserting on behaviour.** The
  logger tests assert on logs. Everything else asserts on state.
- **No staging environment (yet).** §2 explains why.
- **No metrics vendor, APM, or OTel collector in v1.** §5 explains why. Six SQL
  queries and JSON on stdout answer every operational question we currently
  have; adding a vendor before we have a question it answers is infrastructure
  as decoration.
- **No auto-scaling the worker.** One replica, deliberately. Horizontal worker
  scaling interacts with per-mailbox pacing in ways that need the §9.4 tests
  green first, and the throughput ceiling of one worker is far above cold-email
  volumes.

### 12.4 Things in this document that would be over-engineering if added

Called out so they stay out:

- **Blue/green or canary deploys.** With expand/contract migrations and a fast
  rollback, a rolling restart is enough. Canary requires traffic splitting and
  per-version metrics we do not have.
- **A read replica.** Single primary (brief §2). Our read volume is small and a
  replica adds replication lag as a new class of bug in analytics.
- **A separate scheduler service.** The scheduler is a tick inside the worker
  loop. Splitting it into its own process doubles the deployables to solve a
  problem we do not have.
- **Distributed tracing.** `requestId` on the `Job` row (§5.1) covers the one
  cross-process hop that exists.
- **Contract tests between web and worker.** They share a repository, a type
  system, and a Prisma client. `tsc` is the contract test.
- **Chaos engineering.** The three failure modes that matter (worker dies,
  provider 429s, DB unreachable) are covered by explicit tests and runbooks. A
  chaos harness would rediscover them more slowly.

---

## 13. Open items for the lead engineer

1. ~~**Table and column names.**~~ **RESOLVED by the lead — see
   `DECISIONS.md` D4.** Every name in this document was checked against
   `prisma/schema.prisma` and the stale ones corrected in place, because these
   appeared inside *runnable* SQL (the §5.4 metrics and the §6 runbooks) rather
   than in prose — a copy-pasteable query that errors is worse than no query.

   | This doc said | The schema actually has |
   |---|---|
   | `Job.status` | `Job.state` |
   | `JobState.LEASED` | `RUNNING` (leased); `RETRYING` is the backoff wait |
   | `Job.attempts` | `Job.attempt` |
   | `Job.idempotencyKey` | `Job.dedupeKey` |
   | `"Mailbox"` | `"EmailAccount"` |
   | `Lead.importBatchId` | `Lead.leadImportId` |

   `WorkerHeartbeat` and `Job.enqueuedByRequestId` did not exist and were added
   (`DECISIONS.md` D3), so §5.4's worker-liveness check and the tracing claim are
   now real rather than aspirational.
2. ~~**`ENCRYPTION_KEY_VERSION` is not in `.env.example`.**~~ **RESOLVED: no such
   variable is needed.** `src/lib/crypto.ts` carries the key version *inside each
   payload* (`v1.<iv>.<tag>.<ciphertext>`), so a record declares which key
   encrypted it and `needsRotation()` reads it back. An env var would be a second,
   drifting source of truth for a fact the data already states — and it would be
   wrong during a rotation, when both key versions are legitimately in use.
   Rotation therefore needs only `ENCRYPTION_KEY` plus the decrypt-only
   `ENCRYPTION_KEY_PREVIOUS`, both already in `.env.example`. §4.2's rotation loop
   should re-encrypt payloads where `needsRotation()` is true.
3. **`.gitignore` needs `!.env.test`.** The current `.env.*` rule excludes it,
   and §2.1/CI depend on it being committed. One-line change, but it is not mine
   to make.
4. **Hosting platform is undecided.** §1.4 recommends topology A but names no
   vendor. The choice determines whether `DIRECT_DATABASE_URL` and a pooler are
   required (§3.4), and whether the release hook exists as a first-class feature.
   Needed before phase 1 ships anything deployable.
5. **A `dotenv` CLI or a shell workaround** for `test:db:reset` (§7.3). Prefer
   the shell workaround to avoid a dependency, but it is a stack decision and the
   brief limits additions.
6. **Who owns `scripts/coverage-gate.ts`, `scripts/restore-test.sh`, and
   `tests/e2e/global-setup.ts`?** All three are referenced here and by CI. I have
   not created them (not my files).
7. **The fake-provider test routes (`/api/test/**`, §10.1)** need an owner in
   `05` and a decision on whether `E2E_FAKE_PROVIDER` is added to the env schema
   as a validated field (recommended: yes, with a production refinement that
   rejects it).
8. **Sending-window semantics that unit tests must pin but the product must
   first decide:** (a) is a window crossing midnight supported? (b) on DST
   fall-back, which of the two 01:30s do we use? (c) does a per-mailbox daily
   cap reset on the mailbox timezone or the campaign timezone? §8.2 asserts
   *some* answer for each; `06` must state which.
