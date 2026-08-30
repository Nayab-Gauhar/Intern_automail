# Instant Mail

An end-to-end email outreach platform. Leads run through multi-step personalised
sequences from real mailboxes; replies are detected and stop the sequence
automatically, get classified by AI, and become CRM opportunities.

This is an original implementation. No proprietary code, assets, or UI from any
vendor.

## The loop

```
Lead → Campaign → Sequence → Scheduler → Queue → Worker → Provider → Recipient
                                                                          │
Analytics ← CRM/Tasks ← AI Classification ← Inbox ← Reply/Bounce/Tracking ─┘
```

Every architectural decision is judged against one question: does this make the
loop work reliably with nobody watching it?

### Invariants the system is built to hold

1. **Campaigns run with no browser open.** Sending is driven by a standalone
   worker process, never a client-side timer.
2. **A reply stops the sequence** — promptly and idempotently.
3. **No email is ever sent twice**, under retry, worker restart, or concurrent
   workers.
4. **Nothing sends outside its window or over its daily cap**, per mailbox, in the
   right timezone.
5. **AI drafts; humans send.** No autonomous substantive replies.
6. **Workspace isolation is absolute.** No query returns another tenant's data.

The first four are enforced by database constraints rather than application
logic — see `docs/architecture/01-database.md` §5.

## Stack

Bun · Next.js 16 (App Router) · React 19 · TypeScript (strict) · PostgreSQL 16 ·
Prisma 7 · Tailwind v4 · zod · Playwright

Exact pins live in `package.json` and are justified in
`docs/architecture/10-dependency-pins.md`. They are pins, not ranges: a caret on
a framework is how green CI turns red overnight without a commit.

## Getting started

Requires Bun ≥ 1.4 and PostgreSQL 16 binaries.

```bash
bun install

# Starts a user-space Postgres cluster on port 5433 with data in .pgdata/.
# No Docker and no root needed — see docs/architecture/09-deployment-and-testing.md.
bun run db:init

cp .env.example .env
# Generate the two required secrets:
#   openssl rand -base64 32   → AUTH_SECRET
#   openssl rand -base64 32   → ENCRYPTION_KEY
# Env is validated at boot, so a missing value fails fast with a list of problems.

bun run db:migrate:deploy
bun run db:seed          # prints demo credentials
bun run dev              # http://localhost:3000
```

Gmail and AI keys are optional. Without them the app runs and those features
render an honest "not configured" state rather than crashing.

The worker is a separate process — the browser is not involved in sending:

```bash
bun run worker
```

## Commands

| Command | What it does |
|---|---|
| `bun run dev` / `build` / `start` | the web app |
| `bun run worker` | the sending/sync worker |
| `bun run check` | typecheck + lint + unit tests |
| `bun run test:unit` / `test:integration` / `test:e2e` | test tiers |
| `bun run db:init` / `start` / `stop` / `status` / `psql` | local cluster |
| `bun run db:migrate` / `db:migrate:deploy` / `db:seed` / `db:studio` | schema and data |
| `bun run db:verify` | asserts the hand-written DB objects survived |

### `db:verify` is not optional

The initial migration ends with eight objects Prisma's schema language cannot
express: two partial indexes on the hottest paths, three uniques that are the sole
enforcement of a business rule, two GIN indexes, and an append-only trigger on
`EmailEvent`.

Prisma diffs against `schema.prisma` alone, so it cannot see them and **every**
`prisma migrate diff` proposes `DROP`ping them. Read generated SQL before
committing it, strip those DROPs, and let `db:verify` confirm. CI runs it after
every migration. Details in `docs/architecture/INTEGRATION-NOTES.md` §11.

## Architecture

A modular monolith with hard internal seams, extractable later. Read in order:

| Doc | Covers |
|---|---|
| `00-product-brief.md` | **locked decisions** — the contract everything else obeys |
| `01-database.md` | 42 models, state machines, the invariant table, index-per-query-path |
| `02-backend.md` | module graph, `Ctx`, the `action()` wrapper, transactions, caching |
| `03-frontend.md` | route tree, attention-first dashboard, inbox, sequence builder |
| `04-design-system.md` | tokens, type scale, component specs, anti-patterns |
| `05-email-providers.md` | provider interface, Gmail OAuth, sync, quotas, the fake-provider seam |
| `06-jobs-and-sending-engine.md` | worker loop, `SKIP LOCKED` leasing, idempotency, windows |
| `07-auth-and-security.md` | sessions, permission matrix, isolation, encryption, threat model |
| `08-analytics-crm-ai.md` | metric formulas, rollups, the statistical guard, AI boundary |
| `09-deployment-and-testing.md` | topology, observability, runbooks, test strategy |
| `DECISIONS.md` | conflicts between docs, resolved, with reasoning |
| `INTEGRATION-NOTES.md` | defects found by running the tools — **read before touching migrations** |

### Rules that are lint-enforced, not aspirational

- Prisma is importable only from `src/modules/*/repo.ts` and `src/lib/db.ts`.
  Everything else goes through a module's public `index.ts`. (Type-only imports of
  generated enums are allowed; they compile away.)
- `src/components/ui/**` is pure presentation — no modules, no server code, no db.
- No `any`. No `console.log` — use the structured logger, which redacts tokens,
  passwords, and email bodies.

### Multi-tenancy

`workspaceId` is resolved server-side from the session and carried in a `Ctx`
constructed in exactly one place. A `workspaceId` arriving from a client is
ignored and logged as a suspicious event. Cross-workspace access returns **404,
not 403** — we do not confirm that another tenant's data exists.

## Honesty commitments

The product refuses to overstate what it can observe:

- **Open tracking is indicative, not factual.** Image proxying, blocked images,
  and prefetching all corrupt it. It is labelled as such wherever it appears.
- **No claims about inbox-versus-spam placement.** We cannot observe it.
- **No conclusions from small samples.** Comparative insights require a minimum
  sample and carry their sample size; below it, the claim is suppressed rather
  than shown misleadingly.

## Status

Phase 0 (architecture) and Phase 1 (foundation) are in progress. Later phases —
Gmail sync, inbox, leads, campaigns, the sending engine, reply automation,
analytics, CRM, AI — are specified in the docs above and land as vertical slices:
database → module → API → UI → tests, verified before the next begins.

Where a feature is not built, the UI says so. There are no fake controls.
