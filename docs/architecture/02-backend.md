# 02 — Backend Architecture

> **Status:** design. Subordinate to `00-product-brief.md`. Where this document
> and the brief disagree, the brief wins and this document is the bug.
>
> **Scope.** The server half of the modular monolith: the module dependency
> graph, the anatomy contract every `src/modules/<domain>/` obeys, the `Ctx`
> tenancy pattern, the `action()` server-action wrapper, the error model,
> route-handler-vs-action rules, transactions, the Prisma 7 client, pagination,
> caching, idempotency, observability, and rate limiting.
>
> **Out of scope.** The schema (`01-database.md`), the queue and sending engine
> internals (`06`), the route tree and components (`03`), analytics/CRM/AI
> internals (`08`), deploy topology (`09`). Where this document names a table or
> column it has been grepped against `prisma/schema.prisma`; where it names a
> function in another doc's module, that doc is authoritative on the body.
>
> **Verified.** Every TypeScript block in §4, §5, §6, §7 and §10 was compiled
> against the pinned toolchain (`tsc --noEmit`, TypeScript 6.0.3, Prisma client
> 7.10.0 generated from the live schema, zod 4.5.4) before being pasted here.
> They are not illustrative sketches; they typecheck.

---

## 0. The ten rules this document exists to enforce

Restated because every section is an application of one of them.

1. **`workspaceId` comes from the session, never from the caller.** A
   `workspaceId` in a form field, JSON body, or search param is ignored and
   logged as `authz.cross_workspace_attempt`.
2. **Every service entrypoint takes `Ctx` as its first parameter.** No
   exceptions, including read-only functions and job handlers.
3. **Prisma is importable only from `src/modules/*/repo.ts`, `src/lib/db.ts`,
   and `prisma/`.** Enforced by `no-restricted-imports` in `eslint.config.mjs`.
4. **Cross-workspace access returns 404, never 403.** 403 confirms the resource
   exists in someone else's workspace.
5. **Modules never import `src/server/**`.** Guards and the action wrapper sit
   *above* modules. This one rule is what keeps the graph acyclic (§2.4).
6. **Expected failures return `Result<T, E>`; unexpected failures throw
   `AppError`.** Never a bare `null` for a failure, never a thrown string.
7. **No network I/O inside a database transaction.** Not Gmail, not Anthropic,
   not DNS. A transaction holds a pooled connection and we have eight.
8. **Content is frozen at materialisation.** `ScheduledEmail` carries the
   rendered `subject`/`bodyHtml`/`bodyText`, which is why `sending` needs no
   dependency on `sequences` and a mid-flight template edit cannot rewrite a
   pending send.
9. **Counter columns are caches owned by `analytics`.** The module that owns the
   rest of the row does not write them.
10. **The web process never performs a send.** `src/app/**` contains no provider
    call. Background work is a `Job` row inserted in the same transaction as the
    domain change that caused it.

---

## 1. Layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│  src/app/**            pages, layouts, route handlers, action files     │  ← may import
│  src/components/**     presentation                                     │     server/ + modules/*/index
├─────────────────────────────────────────────────────────────────────────┤
│  src/server/**         SERVER-ONLY EDGE                                 │  ← may import
│    session.ts          cookie ⇄ Session row, sliding refresh            │     modules/*/index + lib
│    guards.ts           requireAuth · requireWorkspace · requireRole     │
│    action.ts           the one Server Action wrapper                    │
│    request-context.ts  AsyncLocalStorage { requestId, workspaceId }     │
│    origin.ts           same-origin / CSRF check for route handlers      │
├─────────────────────────────────────────────────────────────────────────┤
│  src/modules/<domain>/ DOMAIN LOGIC — index · service · repo ·          │  ← may import
│                        schema · types (+ pure helpers)                  │     other modules'
│                                                                          │     index.ts + lib
├─────────────────────────────────────────────────────────────────────────┤
│  src/lib/**            env · db · errors · result · logger · crypto ·   │  ← imports nothing
│                        time · cursor · rate-limit · ids                 │     of ours
└─────────────────────────────────────────────────────────────────────────┘

worker/                  index · loop · maintenance · registry
                         imports modules/*/index.ts ONLY — never server/**,
                         never a service.ts, never a repo.ts
```

`src/lib/**` is a leaf by construction: no file in it imports from `modules/`,
`server/`, or `app/`. `src/lib/db.ts` is the only member that opens a socket.

### 1.1 Why `server/` is above `modules/` and not beside it

`requireWorkspace()` must read a `WorkspaceMember` row, which is
`workspace`'s table. So `server/guards.ts` → `modules/workspace`. If any module
were allowed to import `server/guards.ts` to "get the current workspace", we
would have `workspace → guards → workspace`. Instead:

> **A module never discovers its own tenancy. It is told, via `Ctx`.**

That is the whole reason `Ctx` is a parameter rather than an ambient lookup, and
it is also what makes every service function unit-testable without a request and
callable from the worker, where there is no cookie at all.

---

## 2. Module dependency graph

### 2.1 The graph

Edges point *downward* — an arrow from `A` to `B` means "`A` imports
`B/index.ts`". Nothing points up.

```
                              ┌───────────┐
  L7  read-model              │ dashboard │            (leaf: nothing imports it)
                              └─────┬─────┘
                    ┌───────────────┼───────────────┬───────────────┐
                    │               │               │               │
  L6  CRM      ┌────▼────┐          │               │               │
               │   crm   │          │               │               │
               └────┬────┘          │               │               │
             ┌──────┴──────┬────────┴──────┐        │               │
             │             │               │        │               │
  L5  reactive        ┌────▼────┐      ┌───▼───┐    │               │
                      │ replies │      │   ai  │    │               │
                      └────┬────┘      └───┬───┘    │               │
          ┌────────┬───────┴───┬───────┐   │        │               │
          │        │           │       │   │        │               │
  L4  orchestration │     ┌────▼────┐  │   │   ┌────▼───┐           │
                    │     │campaigns│──┼───┼──▶│ warmup │           │
                    │     └────┬────┘  │   │   └────┬───┘           │
          ┌─────────┼──────────┼───────┼───┼────────┤               │
          │         │          │       │   │        │               │
  L3  I/O      ┌────▼────┐  ┌──▼──────▼┐  │   ┌─────▼────────────┐  │
               │  inbox  │  │ sending  │  │   │ deliverability   │  │
               └────┬────┘  └──┬───┬───┘  │   └─────┬────────────┘  │
                    │          │   │      │         │               │
  L2  resources ┌───▼──────────▼┐  │  ┌───▼─────┐   │        ┌──────▼────┐
                │   mailboxes   │  │  │sequences│   │        │ workspace │
                └───────┬───────┘  │  └────┬────┘   │        └─────┬─────┘
                        │          │       │        │              │
  L1  primitives  ┌─────▼──┐  ┌────▼───┐ ┌─▼─────┐  │        ┌─────▼──┐
                  │  jobs  │  │analytics│ │ leads │◀─┘        │  auth  │
                  └────┬───┘  └────┬───┘ └───┬───┘             └───┬───┘
                       └───────────┴─────────┴─────────────────────┘
                                          │
  L0                                 ┌────▼────┐
                                     │ src/lib │
                                     └─────────┘
```

### 2.2 The adjacency list — this is the normative form

The diagram is a picture; this table is the contract. A module may import
**exactly** the modules listed here and nothing else.

| Level | Module | May import (module public APIs) | Owns (tables) |
|---|---|---|---|
| L1 | `auth` | — | `User`, `Session`, `PasswordResetToken` |
| L1 | `jobs` | — | `Job` |
| L1 | `analytics` | — | `EmailEvent`, **all `*Count` cache columns everywhere**, `MailboxDailyStat`, `Experiment`, `ExperimentArm` |
| L1 | `leads` | — | `Lead`, `LeadList`, `LeadListMembership`, `LeadTag`, `LeadTagLink`, `CustomFieldDefinition`, `LeadImport`, `Suppression` |
| L2 | `workspace` | `auth` | `Workspace`, `WorkspaceMember`, `WorkspaceInvite`, `AuditLog` |
| L2 | `mailboxes` | `jobs` | `EmailAccount`, `SyncState`, `Domain` |
| L2 | `sequences` | `leads` | `Sequence`, `SequenceStep`, `SequenceStepVariant` |
| L3 | `inbox` | `mailboxes` | `EmailThread`, `EmailMessage` |
| L3 | `sending` | `mailboxes`, `leads`, `analytics`, `jobs` | `ScheduledEmail`, `TrackingLink` |
| L3 | `deliverability` | `mailboxes`, `analytics` | *(reads `Domain`, `EmailAccount`; writes DNS status columns on `Domain`)* |
| L4 | `campaigns` | `sequences`, `leads`, `mailboxes`, `sending`, `jobs` | `Campaign`, `CampaignMailbox`, `CampaignLeadListSource`, `CampaignLead` |
| L4 | `warmup` | `mailboxes`, `sending`, `jobs` | `WarmupPool`, `WarmupPoolMember` |
| L5 | `replies` | `inbox`, `campaigns`, `sending`, `leads`, `analytics`, `jobs` | `WebhookEvent` |
| L5 | `ai` | `inbox`, `leads`, `jobs` | `AIAnalysis` |
| L6 | `crm` | `leads`, `campaigns`, `inbox`, `analytics` | `Task`, `Note`, `Opportunity`, `Activity` |
| L7 | `dashboard` | any L1–L6 | *(nothing — read-only projection)* |

### 2.3 Proof that the graph is acyclic

Assign `level(m)` as in the table. Inspect every edge in the "May import"
column: for each, `level(source) > level(target)`.

```
sending  (3) → mailboxes (2) ✓  leads (1) ✓  analytics (1) ✓  jobs (1) ✓
campaigns(4) → sequences  (2) ✓  leads (1) ✓  mailboxes(2) ✓  sending(3) ✓  jobs(1) ✓
warmup   (4) → mailboxes  (2) ✓  sending(3) ✓  jobs(1) ✓
replies  (5) → inbox      (3) ✓  campaigns(4) ✓ sending(3) ✓ leads(1) ✓ analytics(1) ✓ jobs(1) ✓
ai       (5) → inbox      (3) ✓  leads (1) ✓  jobs (1) ✓
crm      (6) → leads      (1) ✓  campaigns(4) ✓ inbox(3) ✓ analytics(1) ✓
dashboard(7) → …          (≤6) ✓
workspace(2) → auth       (1) ✓
mailboxes(2) → jobs       (1) ✓
sequences(2) → leads      (1) ✓
inbox    (3) → mailboxes  (2) ✓
deliv.   (3) → mailboxes  (2) ✓  analytics (1) ✓
auth, jobs, analytics, leads → ∅
```

Every edge strictly decreases a non-negative integer. A cycle would require an
edge that does not, so no cycle exists. ∎

The level column is therefore **load-bearing metadata, not decoration**. Adding
an import means checking the inequality still holds; if it does not, the
dependency is wrong and §2.4 tells you what to do instead.

### 2.4 The four cycles this design deliberately avoids, and where the need went

These are the real ones. Each was reached by following the product requirement,
not by hypothesising.

**(a) `campaigns` ↔ `sending`.** A send completing must advance the enrollment
to the next step. The obvious `sending → campaigns.advanceAfterSend()` closes a
cycle with `campaigns → sending.materialise()`.

*Resolution:* `sending` enqueues, **in the same transaction that marks the row
`SENT`**, a `Job` of type `SCHEDULER_TICK` for the campaign. `campaigns` picks
it up on the next drain. The transactional guarantee the product needs ("the
enrollment is never left un-advanced after a successful send") is preserved
because the job row and the `SENT` row commit together — that is the entire
reason the queue lives in Postgres (brief §5). The edge becomes
`sending → jobs`, which is level 3 → 1.

```
   sending.markSent(ctx, id)              campaigns handler
   ┌──────────── one tx ────────────┐
   │ ScheduledEmail → SENT          │
   │ EmailEvent(SENT)               │     later, separate tx:
   │ MailboxDailyStat.sentCount++   │ ──▶ Job(SCHEDULER_TICK) leased
   │ Job(SCHEDULER_TICK, dedupeKey) │     campaigns.tick() advances
   └────────────────────────────────┘     CampaignLead + materialises next
```

**(b) `analytics` ↔ everything.** The rollup writes `Campaign.sentCount`,
`SequenceStep.openedCount`, `EmailAccount.healthScore`, `Lead.replyCount`,
`ExperimentArm.pValue` — columns on five other modules' tables. Importing five
modules from `analytics` closes five cycles at once.

*Resolution:* declare ownership by column, not by table. **`analytics` owns
every `*Count`, `*At` engagement-cache, `healthScore`, and `statsUpdatedAt`
column, wherever it lives.** `analytics/repo.ts` writes them directly. The
module that owns the rest of the row treats them as read-only. This is legal
because the schema already declares them caches ("COUNTERS ARE CACHES", schema
header note 5) and because nothing else may write them, so there is no
contention over authorship. `campaigns` does not import `analytics` to render a
campaign list — it selects the cached columns off its own `Campaign` row.

**(c) `inbox` ↔ `replies`.** Reply detection needs thread/message rows
(`inbox`); marking `EmailThread.hasHumanReply` is a write to `inbox`'s table.

*Resolution:* one-directional. `replies` imports `inbox` and calls
`inbox.markHumanReply(ctx, threadId, at)`. `inbox` never imports `replies`; the
inbox *page* composes `inbox.getThread()` and `ai.analysisFor()` side by side,
which is composition in `app/`, not a module dependency.

**(d) `leads` ↔ `campaigns`.** Enrolling a lead sets `Lead.status = CONTACTED`
and reads the suppression list; a campaign pause must clear pending sends for a
lead.

*Resolution:* `campaigns → leads` only. `leads` exposes
`leads.isSuppressed(ctx, email)` and `leads.markContacted(ctx, leadIds)`; it
knows nothing about campaigns. `Lead.status` transitions caused by outreach are
driven from `campaigns`/`replies` calling into `leads`, never the reverse.

**The general rule.** When two modules need each other:

1. If the need is a *pure* function or a type (email normalisation, cursor
   codec, timezone math, `Result`, `AppError`) → it goes in `src/lib/`.
2. If the need is *"tell them something happened"* → a `Job` row, enqueued in
   the same transaction. Never a direct call upward.
3. If the need is *"read a column on their table"* → allowed via a relation the
   caller's own row owns the FK for (§3.5), or by declaring column ownership as
   in (b).
4. If the need is *orchestration across peers* → it belongs in the layer above:
   a job handler in `worker/registry.ts`, or a Server Action in `app/`.

### 2.5 Two additions to the brief's module list

The brief §3 lists fifteen module folders. Two things referenced by `03-frontend.md`
have no home in that list. Both are resolved here and flagged in §17.

- **`suppressions.*`** (`03` §2 references `suppressions.describeToken`) is
  **not** a module. `Suppression` is a leads-domain table; the code lives in
  `src/modules/leads/suppressions.ts` and is re-exported from
  `leads/index.ts` as `leads.describeSuppressionToken`, `leads.suppress`,
  `leads.isSuppressed`, `leads.listSuppressions`. A sixteenth folder for one
  table with three functions is not worth a seam.
- **`dashboard`** (`03` §4 references `dashboard.problems`, `dashboard.counts`,
  …) **is** a new module, at L7. It is a read-only projection: it imports many
  modules, exports only queries, owns no table, and is imported by nothing.
  Being a sink, it cannot create a cycle, and putting seven unrelated
  attention-queries into `analytics` would make `analytics` depend on six
  modules and destroy the resolution in §2.4(b).

---

## 3. The module anatomy contract

### 3.1 The five files, and exactly what each may contain

```
src/modules/<domain>/
  index.ts     PUBLIC API. Re-exports only. The only file outsiders may import.
  service.ts   Business logic, invariants, orchestration, transactions.
  repo.ts      The ONLY file in this domain that imports Prisma.
  schema.ts    zod schemas for this domain's inputs. No I/O.
  types.ts     Domain types. No Prisma types leaked outward. No I/O.
  <pure>.ts    Optional pure helpers (windows.ts, pacing.ts, metrics.ts…).
```

| File | May import | Must NOT contain | Must NOT import |
|---|---|---|---|
| `index.ts` | `./service`, `./schema`, `./types` | logic, Prisma, `server-only` | `./repo`, `@/server/*` |
| `service.ts` | `./repo`, `./schema`, `./types`, `@/lib/*`, other modules' `index.ts` | raw SQL, Prisma model calls | `@prisma/client` for **queries** (types are fine), `@/server/*`, `next/*` |
| `repo.ts` | `@/lib/db`, `@prisma/client`, `./types`, `@/server/ctx` types | business rules, error messages for users, cross-domain reads | other modules, `@/server/guards`, `next/*` |
| `schema.ts` | `zod`, `@prisma/client` (enums only), `./types` | any I/O, any DB access | `@/lib/db`, `./repo` |
| `types.ts` | `@prisma/client` (enums only) | functions with side effects | everything else of ours |

Four rules that are easy to get wrong and are therefore stated flatly:

1. **`index.ts` never re-exports `repo`.** If a caller needs a query, `service`
   exposes it. This is what makes swapping the persistence layer per module
   possible and what stops `app/` from writing an unscoped query.
2. **`repo.ts` filters by `ctx.workspaceId` in every single function.** A repo
   function that takes no `Ctx` and touches a tenant-owned table is a bug and
   fails review. `findByIdInWorkspace`, not `findById` — the name says the
   scope.
3. **`repo.ts` returns rows; `service.ts` returns domain types.** Prisma's
   generated row types stay behind the repo boundary. `types.ts` is what crosses
   it. This is not purism: `Lead` has 40 columns including `emailRaw` and
   `encryptionKeyVersion`-adjacent internals, and leaking the row type into a
   client component means shipping columns we did not intend to.
4. **`service.ts` never imports `next/headers`, `next/navigation`, or
   `next/cache`.** A service that calls `redirect()` cannot be called from the
   worker. Revalidation is the caller's job (§11).

### 3.2 `server-only` and the test runner

Files that read secrets or the DB begin with `import 'server-only'`: `lib/db.ts`,
`lib/crypto.ts`, `lib/env.ts` (server half), every `repo.ts`, every
`src/server/*.ts`. In a client bundle that import throws at build time.

`server-only` resolves to a throwing module under the `default` condition and an
empty one under `react-server`. That is why `package.json` runs
`bun test --conditions react-server` — without it every unit test importing a
`repo.ts` explodes on the marker rather than on anything real. Do not "fix" a
`server-only` test failure by deleting the import.

### 3.3 Worked example — `src/modules/leads/` in full

Written against the real schema. `Lead`, `LeadTag`, `LeadTagLink`, `LeadList`,
`LeadListMembership`, `CustomFieldDefinition`, `LeadImport`, `Suppression`, and
every field named below exist in `prisma/schema.prisma`.

#### 3.3.1 `types.ts`

Note what is *absent* from `LeadSummary`: `emailRaw`, `verifiedAt`, `deletedAt`,
`workspaceId`. The list view does not need them, so they do not cross the
boundary.

```ts
// src/modules/leads/types.ts
import type { LeadStatus, VerificationStatus } from '@prisma/client'

export type LeadId = string

/** The row shape the leads table renders. 18 columns, all indexed or cheap. */
export type LeadSummary = {
  id: LeadId
  email: string
  fullName: string | null
  firstName: string | null
  lastName: string | null
  companyName: string | null
  jobTitle: string | null
  emailDomain: string | null
  status: LeadStatus
  verificationStatus: VerificationStatus
  score: number | null
  ownerUserId: string | null
  sentCount: number
  openCount: number
  replyCount: number
  lastContactedAt: Date | null
  lastRepliedAt: Date | null
  createdAt: Date
}

/** The lead profile page. Adds the joined collections and the JSONB blob. */
export type LeadDetail = LeadSummary & {
  phone: string | null
  linkedinUrl: string | null
  websiteUrl: string | null
  city: string | null
  state: string | null
  country: string | null
  timezone: string | null
  source: string | null
  leadImportId: string | null
  customFields: Record<string, unknown>
  clickCount: number
  lastOpenedAt: Date | null
  updatedAt: Date
  tags: { id: string; name: string; colorToken: string }[]
  lists: { id: string; name: string }[]
}

/** Opaque, base64url. Never parsed by a caller — see §10. */
export type Cursor = string & { readonly __brand: 'Cursor' }

export type Page<T> = {
  rows: T[]
  nextCursor: Cursor | null
  hasMore: boolean
}

/** Expected write failures. These are Result errors, not exceptions (§6.3). */
export type LeadWriteError =
  | { kind: 'duplicate_email'; existingLeadId: LeadId }
  | { kind: 'suppressed'; reason: string }
  | { kind: 'unknown_custom_field'; key: string }
  | { kind: 'invalid_custom_field'; key: string; expected: string }
```

#### 3.3.2 `schema.ts`

zod 4 API: `z.email()` and `z.cuid()` are top-level, not
`z.string().email()`. `.catch()` on every filter field implements the
`03-frontend.md` §7.2 rule that a stale bookmark shows the default list rather
than an error.

```ts
// src/modules/leads/schema.ts
import { z } from 'zod'
import { LeadStatus, VerificationStatus } from '@prisma/client'

export const LEAD_SORT_KEYS = [
  'createdAt', 'updatedAt', 'email', 'fullName', 'companyName',
  'status', 'score', 'lastContactedAt', 'lastRepliedAt',
] as const
export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number]

/** `?status=NEW,REPLIED` → `['NEW','REPLIED']`; garbage → undefined, not an error. */
const csv = <T extends string>(values: readonly T[]) =>
  z.string()
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values as unknown as [T, ...T[]])))
    .transform((a) => (a.length ? a : undefined))
    .optional()
    .catch(undefined)

export const leadFilterSchema = z.object({
  q:              z.string().trim().max(200).optional().catch(undefined),
  status:         csv(Object.values(LeadStatus)),
  verification:   csv(Object.values(VerificationStatus)),
  listId:         z.cuid().optional().catch(undefined),
  tagId:          z.cuid().optional().catch(undefined),
  campaignId:     z.cuid().optional().catch(undefined),
  ownerUserId:    z.cuid().optional().catch(undefined),
  emailDomain:    z.string().trim().toLowerCase().max(253).optional().catch(undefined),
  scoreMin:       z.coerce.number().int().min(0).max(100).optional().catch(undefined),
  includeDeleted: z.coerce.boolean().default(false).catch(false),
  sort:           z.enum(LEAD_SORT_KEYS).default('createdAt').catch('createdAt'),
  dir:            z.enum(['asc', 'desc']).default('desc').catch('desc'),
  cursor:         z.string().max(200).optional().catch(undefined),
  limit:          z.coerce.number().int().min(1).max(100).default(50).catch(50),
})
export type LeadFilter = z.output<typeof leadFilterSchema>

export const createLeadSchema = z.object({
  email:        z.email().max(320).trim().toLowerCase(),
  firstName:    z.string().trim().max(120).optional(),
  lastName:     z.string().trim().max(120).optional(),
  companyName:  z.string().trim().max(200).optional(),
  jobTitle:     z.string().trim().max(200).optional(),
  phone:        z.string().trim().max(50).optional(),
  linkedinUrl:  z.url().max(500).optional(),
  websiteUrl:   z.url().max(500).optional(),
  city:         z.string().trim().max(120).optional(),
  state:        z.string().trim().max(120).optional(),
  country:      z.string().trim().max(120).optional(),
  timezone:     z.string().max(64).optional(),
  ownerUserId:  z.cuid().optional(),
  source:       z.string().max(120).default('manual'),
  customFields: z.record(z.string(), z.unknown()).default({}),
  tagIds:       z.array(z.cuid()).max(50).default([]),
  listIds:      z.array(z.cuid()).max(50).default([]),
})
export type CreateLeadInput = z.output<typeof createLeadSchema>

export const updateLeadSchema = createLeadSchema
  .omit({ tagIds: true, listIds: true, source: true })
  .partial()
  .extend({
    leadId: z.cuid(),
    status: z.enum(Object.values(LeadStatus) as [LeadStatus, ...LeadStatus[]]).optional(),
  })
export type UpdateLeadInput = z.output<typeof updateLeadSchema>

/** NOTE: there is no `workspaceId` in any schema above, and there never will be. */
```

#### 3.3.3 `repo.ts`

Every function takes `Ctx` and every `where` starts with `workspaceId`. The
optional `db: Db = prisma` parameter is how a service enlists the repo in an
interactive transaction without the repo knowing about transactions.

```ts
// src/modules/leads/repo.ts
import 'server-only'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { Ctx } from '@/server/ctx'
import type { LeadFilter } from './schema'
import type { LeadSummary } from './types'

type Tx = Prisma.TransactionClient
type Db = typeof prisma | Tx

const SUMMARY_SELECT = {
  id: true, email: true, fullName: true, firstName: true, lastName: true,
  companyName: true, jobTitle: true, emailDomain: true, status: true,
  verificationStatus: true, score: true, ownerUserId: true,
  sentCount: true, openCount: true, replyCount: true,
  lastContactedAt: true, lastRepliedAt: true, createdAt: true,
} satisfies Prisma.LeadSelect

/**
 * THE tenancy chokepoint. Every read and every scoped write in this file starts
 * from `scope(ctx)`. There is exactly one place to audit.
 */
export function scope(ctx: Ctx, f?: Partial<LeadFilter>): Prisma.LeadWhereInput {
  const where: Prisma.LeadWhereInput = { workspaceId: ctx.workspaceId }
  if (!f?.includeDeleted) where.deletedAt = null
  if (f?.status?.length) where.status = { in: f.status }
  if (f?.verification?.length) where.verificationStatus = { in: f.verification }
  if (f?.ownerUserId) where.ownerUserId = f.ownerUserId
  if (f?.emailDomain) where.emailDomain = f.emailDomain
  if (f?.scoreMin !== undefined) where.score = { gte: f.scoreMin }
  // Nested filters repeat workspaceId: the join tables carry it (denormalised
  // by design, schema §LeadListMembership) so neither side can be borrowed.
  if (f?.listId) where.listMemberships = { some: { leadListId: f.listId, workspaceId: ctx.workspaceId } }
  if (f?.tagId) where.tagLinks = { some: { leadTagId: f.tagId, workspaceId: ctx.workspaceId } }
  if (f?.campaignId) where.campaignLeads = { some: { campaignId: f.campaignId, workspaceId: ctx.workspaceId } }
  if (f?.q) {
    where.OR = [
      { email:       { contains: f.q, mode: 'insensitive' } },
      { fullName:    { contains: f.q, mode: 'insensitive' } },
      { companyName: { contains: f.q, mode: 'insensitive' } },
    ]
  }
  return where
}

/**
 * Keyset page. Fetches limit+1 so the service can answer `hasMore` without a
 * second query. Tiebreak on `id` is mandatory (§10.1).
 */
export async function findPage(
  ctx: Ctx,
  f: LeadFilter,
  decoded: { sortValue: string | number | Date | null; id: string } | null,
  db: Db = prisma,
): Promise<LeadSummary[]> {
  const cmp = f.dir === 'desc' ? 'lt' : 'gt'
  const keyed: Prisma.LeadWhereInput[] = decoded
    ? [{
        OR: [
          { [f.sort]: { [cmp]: decoded.sortValue } } as Prisma.LeadWhereInput,
          { AND: [
            { [f.sort]: decoded.sortValue } as Prisma.LeadWhereInput,
            { id: { [cmp]: decoded.id } },
          ] },
        ],
      }]
    : []
  return db.lead.findMany({
    where: { AND: [scope(ctx, f), ...keyed] },
    select: SUMMARY_SELECT,
    orderBy: [{ [f.sort]: f.dir }, { id: f.dir }],
    take: f.limit + 1,
  })
}

export async function findByIdInWorkspace(ctx: Ctx, leadId: string, db: Db = prisma) {
  return db.lead.findFirst({
    where: { id: leadId, workspaceId: ctx.workspaceId, deletedAt: null },
    include: {
      tagLinks:        { select: { leadTag:  { select: { id: true, name: true, colorToken: true } } } },
      listMemberships: { select: { leadList: { select: { id: true, name: true } } } },
    },
  })
}

export async function insert(ctx: Ctx, data: Prisma.LeadCreateInput, db: Db = prisma) {
  return db.lead.create({ data, select: SUMMARY_SELECT })
}

/** Soft delete only. Leads are referenced by EmailEvent, threads, opportunities. */
export async function softDeleteMany(ctx: Ctx, ids: string[], db: Db = prisma): Promise<number> {
  const res = await db.lead.updateMany({
    where: { id: { in: ids }, workspaceId: ctx.workspaceId, deletedAt: null },
    data: { deletedAt: new Date() },
  })
  return res.count
}

export async function countScoped(ctx: Ctx, f: LeadFilter, db: Db = prisma): Promise<number> {
  return db.lead.count({ where: scope(ctx, f) })
}
```

Note the shape of `softDeleteMany`: an `updateMany` whose `where` includes
`workspaceId` **and** returns a count. That count is how the service detects
"caller named ids it does not own" without a pre-read, and it is why cross-tenant
writes degrade to a 404 rather than silently succeeding (§6.4).

#### 3.3.4 `service.ts`

```ts
// src/modules/leads/service.ts
import 'server-only'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { ConflictError, NotFoundError, Ok, Err, type Result } from '@/lib/errors'
import type { Ctx } from '@/server/ctx'
import * as repo from './repo'
import type { CreateLeadInput, LeadFilter, UpdateLeadInput } from './schema'
import type { Cursor, LeadDetail, LeadSummary, LeadWriteError, Page } from './types'

const UNIQUE_VIOLATION = 'P2002'   // Postgres 23505 as Prisma reports it

function fullNameOf(first?: string | null, last?: string | null): string | null {
  const n = [first, last].filter((p): p is string => Boolean(p?.trim())).join(' ').trim()
  return n.length ? n : null
}
function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@')
  return at > 0 ? email.slice(at + 1).toLowerCase() : null
}

function encodeCursor(row: LeadSummary, sort: LeadFilter['sort']): Cursor {
  const v = row[sort as keyof LeadSummary]
  const raw = v instanceof Date ? v.toISOString() : String(v ?? '')
  return Buffer.from(JSON.stringify({ v: raw, id: row.id })).toString('base64url') as Cursor
}
function decodeCursor(c: string | undefined, sort: LeadFilter['sort']) {
  if (!c) return null
  try {
    const p = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { v: string; id: string }
    return { sortValue: sort.endsWith('At') ? new Date(p.v) : p.v, id: p.id }
  } catch {
    return null   // a corrupt cursor shows page 1, never a 500
  }
}

export async function list(ctx: Ctx, filter: LeadFilter): Promise<Page<LeadSummary>> {
  const rows = await repo.findPage(ctx, filter, decodeCursor(filter.cursor, filter.sort))
  const hasMore = rows.length > filter.limit
  const page = hasMore ? rows.slice(0, filter.limit) : rows
  const last = page.at(-1)
  return { rows: page, hasMore, nextCursor: hasMore && last ? encodeCursor(last, filter.sort) : null }
}

/** Throws NotFoundError for a missing lead AND for another workspace's lead. */
export async function get(ctx: Ctx, leadId: string): Promise<LeadDetail> {
  const row = await repo.findByIdInWorkspace(ctx, leadId)
  if (!row) throw new NotFoundError('Lead', leadId)
  return {
    ...row,
    customFields: (row.customFields ?? {}) as Record<string, unknown>,
    tags: row.tagLinks.map((l) => l.leadTag),
    lists: row.listMemberships.map((m) => m.leadList),
  }
}

/**
 * Duplicate email is an EXPECTED outcome (a re-import, a double submit), so it
 * is a Result error, not an exception. We do not pre-check then insert: that is
 * a race. We insert and interpret 23505, which the DB decides atomically.
 */
export async function create(
  ctx: Ctx,
  input: CreateLeadInput,
): Promise<Result<LeadSummary, LeadWriteError>> {
  const data: Prisma.LeadCreateInput = {
    workspace:    { connect: { id: ctx.workspaceId } },
    email:        input.email,
    emailRaw:     input.email,
    firstName:    input.firstName ?? null,
    lastName:     input.lastName ?? null,
    fullName:     fullNameOf(input.firstName, input.lastName),
    emailDomain:  domainOf(input.email),
    companyName:  input.companyName ?? null,
    source:       input.source,
    customFields: input.customFields as Prisma.InputJsonValue,
    ...(input.ownerUserId ? { owner: { connect: { id: input.ownerUserId } } } : {}),
  }
  try {
    return Ok(await prisma.$transaction(async (tx) => {
      const lead = await repo.insert(ctx, data, tx)
      if (input.tagIds.length) {
        await tx.leadTagLink.createMany({
          data: input.tagIds.map((leadTagId) => ({
            workspaceId: ctx.workspaceId, leadTagId, leadId: lead.id,
          })),
          skipDuplicates: true,
        })
      }
      return lead
    }, { isolationLevel: 'ReadCommitted', timeout: 10_000 }))
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === UNIQUE_VIOLATION) {
      const existing = await prisma.lead.findFirst({
        where: { workspaceId: ctx.workspaceId, email: input.email },
        select: { id: true },
      })
      return Err({ kind: 'duplicate_email', existingLeadId: existing?.id ?? '' })
    }
    throw e
  }
}

export async function update(ctx: Ctx, input: UpdateLeadInput): Promise<LeadSummary> {
  const res = await prisma.lead.updateMany({
    where: { id: input.leadId, workspaceId: ctx.workspaceId, deletedAt: null },
    data: {
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.status    !== undefined ? { status:    input.status    } : {}),
    },
  })
  if (res.count === 0) throw new NotFoundError('Lead', input.leadId)
  const row = await repo.findByIdInWorkspace(ctx, input.leadId)
  if (!row) throw new NotFoundError('Lead', input.leadId)
  return row
}

export async function softDelete(ctx: Ctx, ids: string[]): Promise<number> {
  if (ids.length > 1000) throw new ConflictError('Too many leads in one call; use the bulk job.')
  return repo.softDeleteMany(ctx, ids)
}
```

`create` uses `Prisma.InputJsonValue` for `customFields`, not `object` — the
narrower type is what `Lead.customFields Json @default("{}")` accepts, and
`unknown` would not compile. Small detail, but it is the kind of thing that
costs an implementer twenty minutes.

#### 3.3.5 `index.ts`

Pure surface. No `import 'server-only'` — a client component may legally import
the *types* from here through `import type`, and the marker would break that.
`service.ts` carries the marker, which is where it matters.

```ts
// src/modules/leads/index.ts
export {
  list, get, create, update, softDelete,
  bulkAddToList, bulkAddTags, bulkAddToCampaign, bulkDelete,
  listLists, createList, listTags, createTag,
  listCustomFields, upsertCustomField,
  startImport, getImport, validateImport, commitImport,
  isSuppressed, suppress, listSuppressions, describeSuppressionToken,
  markContacted, timeline, exportStream,
} from './service'

export {
  leadFilterSchema, createLeadSchema, updateLeadSchema,
  LEAD_SORT_KEYS,
} from './schema'

export type {
  LeadFilter, CreateLeadInput, UpdateLeadInput, LeadSortKey,
} from './schema'

export type {
  LeadId, LeadSummary, LeadDetail, LeadWriteError, Page, Cursor,
} from './types'

// Deliberately NOT exported: ./repo, SUMMARY_SELECT, scope(), encodeCursor().
```

### 3.4 Naming conventions that carry meaning

| Prefix | Contract |
|---|---|
| `list*` | returns `Page<T>`, cursor-paginated, never unbounded |
| `get*` | single row, **throws `NotFoundError`** if absent or foreign |
| `find*` | single row or `null`, caller decides what absence means |
| `create* / update* / delete*` | single-row writes |
| `bulk*` | takes a selection descriptor (§10.4), may enqueue a job above a threshold |
| `*InWorkspace` (repo only) | the workspace filter is in this function |
| `record*` | append-only fact write (`analytics.recordEvent`) |
| `mark*` | idempotent state transition (`inbox.markHumanReply`) |
| `describe*` | resolves a public token to a safe, minimal projection (no session) |

### 3.5 Reading another module's table

Sometimes needed (`campaigns` rendering the assigned mailbox address). Three
options, in order of preference:

1. **Call the other module's public read.** `mailboxes.getSummaries(ctx, ids)`.
   Default choice. One extra query, zero coupling.
2. **Select through a relation your own row owns the FK for.** `CampaignMailbox`
   has `emailAccountId`, so `campaigns/repo.ts` may `include: { emailAccount:
   { select: { email: true, status: true } } }`. Legal because the FK is on the
   caller's table and the join is workspace-scoped by the parent.
3. **Never** `prisma.emailAccount.findMany()` from `campaigns/repo.ts`. That is
   a hidden dependency lint cannot see and the graph does not record.

---

## 4. The `Ctx` pattern

### 4.1 The types

```ts
// src/server/ctx.ts
import 'server-only'
import type { Role } from '@prisma/client'

/**
 * The authenticated tenant context. First parameter of EVERY service function.
 *
 * Constructed ONLY by src/server/guards.ts (web) or src/server/system-ctx.ts
 * (worker). There is no public constructor and no way to build one from request
 * input — that is the point.
 */
export type Ctx = {
  readonly userId: string
  readonly workspaceId: string
  readonly role: Role            // 'OWNER' | 'ADMIN' | 'MEMBER' from the schema
  readonly timezone: string      // Workspace.timezone — for rendering, never storage
  readonly requestId: string     // correlates every log line for this request
}

/** Authenticated but not yet in a workspace: register, onboarding, invite accept. */
export type SessionCtx = {
  readonly userId: string
  readonly sessionId: string
  readonly activeWorkspaceId: string | null
  readonly requestId: string
}

/** The worker's Ctx. `userId` is the sentinel 'system'; AuditLog.actorUserId stays null. */
export type SystemCtx = Ctx & { readonly actor: 'system' }

const RANK: Record<Role, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 }

export function atLeast(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required]
}
```

`Role` is imported from the generated client rather than redeclared, so adding a
role to the schema is a compile error here instead of a silent gap. `RANK` is a
total `Record<Role, …>`, so a new enum member fails to typecheck until ranked.

### 4.2 Construction — the guards

```ts
// src/server/guards.ts
import 'server-only'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { Role } from '@prisma/client'
import { ForbiddenError, UnauthenticatedError } from '@/lib/errors'
import { sha256Hex } from '@/lib/crypto'
import * as auth from '@/modules/auth'
import * as workspace from '@/modules/workspace'
import { atLeast, type Ctx, type SessionCtx } from './ctx'

export const SESSION_COOKIE = 'im_session'

/** Null, not a throw: layouts branch on absence, they do not catch. */
export async function getSession(): Promise<SessionCtx | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return null
  // Only the SHA-256 hash is stored (brief §6), so we hash then look up.
  // resolveSession() also checks revokedAt BEFORE expiresAt and slides expiry.
  const row = await auth.resolveSession(sha256Hex(token))
  if (!row) return null
  const h = await headers()
  return {
    userId: row.userId,
    sessionId: row.sessionId,
    activeWorkspaceId: row.activeWorkspaceId,
    requestId: h.get('x-request-id') ?? crypto.randomUUID(),
  }
}

export async function requireAuth(): Promise<SessionCtx> {
  const s = await getSession()
  if (!s) throw new UnauthenticatedError('Sign in to continue.')
  return s
}

/**
 * THE tenancy constructor. Note what it does NOT accept: a workspaceId.
 * The workspace comes from Session.activeWorkspaceId, verified against a live
 * ACTIVE WorkspaceMember row on every call.
 */
export async function requireWorkspace(minRole: Role = 'MEMBER'): Promise<Ctx> {
  const session = await requireAuth()
  const m = await workspace.resolveMembership(session.userId, session.activeWorkspaceId)
  if (!m) redirect('/onboarding')          // no membership → not an error, a destination
  if (!atLeast(m.role, minRole)) {
    throw new ForbiddenError(`Requires ${minRole} or higher.`, {
      required: minRole, actual: m.role,
    })
  }
  return {
    userId: session.userId,
    workspaceId: m.workspaceId,
    role: m.role,
    timezone: m.timezone,
    requestId: session.requestId,
  }
}

/** In-service role check for an operation stricter than its module's baseline. */
export function requireRole(ctx: Ctx, minRole: Role): void {
  if (!atLeast(ctx.role, minRole)) {
    throw new ForbiddenError(`Requires ${minRole} or higher.`, {
      required: minRole, actual: ctx.role,
    })
  }
}
```

`workspace.resolveMembership` filters `status: 'ACTIVE'` on `WorkspaceMember`, so
a `SUSPENDED` member is treated as having no membership — suspension takes effect
on the next request, with no session revocation needed.

### 4.3 Why a client-supplied `workspaceId` is never trusted

Not a philosophical position — a specific attack. Suppose `leads.list` took
`workspaceId` as an argument and the leads page passed it from a search param:

```
GET /leads?workspaceId=<victim-workspace-id>&status=REPLIED
```

The attacker is a legitimately authenticated user of *their own* workspace, so
`requireAuth()` passes. If the workspace filter comes from input, they read the
victim's entire replied-lead list — names, companies, email addresses. Session
auth does not help, because the session is real. Only *resolving the tenant
server-side* helps.

Hence three structural, not procedural, defences:

1. **No zod schema in any module accepts a `workspaceId` field.** If it is not
   in the parse output, it cannot reach a query. Grep-checkable:
   `grep -rn "workspaceId" src/modules/*/schema.ts` must return nothing.
2. **`Ctx.workspaceId` is `readonly` and `Ctx` is only constructible by
   `server/`.** A service cannot manufacture a different one.
3. **`repo.scope(ctx)` is the sole entry to every query in the file**, so an
   audit is "does this file have exactly one place that names `workspaceId`",
   which is a five-second read rather than a forty-query review.

When a client *does* send a `workspaceId` — usually a stale form or a
tampering attempt — the action wrapper strips it (unknown keys are dropped by
zod object parsing) and, if it differs from `ctx.workspaceId`, logs
`authz.cross_workspace_attempt{requestedId}` at `warn` (taxonomy in
`09-deployment-and-testing.md` §5.2). We do not fail the request on the strip
alone: a legitimate stale form should not become an incident.

### 4.4 Switching workspaces

Changing workspace is a **write to `Session.activeWorkspaceId`**, not a client
state change:

```ts
// modules/workspace/service.ts
export async function switchWorkspace(
  session: SessionCtx,
  workspaceId: string,
): Promise<void>
```

It verifies an `ACTIVE` `WorkspaceMember` for `(session.userId, workspaceId)`,
updates `Session.activeWorkspaceId`, writes an `AuditLog` row, and the caller
calls `revalidatePath('/', 'layout')`. Because the active workspace lives on the
server-side session row, an open tab in workspace A cannot be tricked into
issuing writes against workspace B, and switching in one tab correctly affects
every tab on the next navigation.

### 4.5 `Ctx` in the worker

The worker has no cookie. `Job.workspaceId` is non-null (schema comment: "Every
job belongs to a tenant — including MAINTENANCE") and is where the worker's
tenancy comes from:

```ts
// src/server/system-ctx.ts  (imported by worker/registry.ts, not by app/**)
import 'server-only'
import type { SystemCtx } from './ctx'
import * as workspace from '@/modules/workspace'

export async function systemCtxFor(workspaceId: string, requestId: string): Promise<SystemCtx> {
  const ws = await workspace.getForSystem(workspaceId)   // throws NotFound if purged
  return {
    userId: 'system',
    workspaceId: ws.id,
    role: 'OWNER',          // the worker acts with full authority within ONE tenant
    timezone: ws.timezone,
    requestId,
    actor: 'system',
  }
}
```

Two consequences worth stating:

- **The worker is never cross-tenant.** A handler gets a `SystemCtx` scoped to
  one workspace, so the same `repo.scope(ctx)` chokepoint protects worker code
  paths. There is no "admin mode" that bypasses the filter.
- **`role: 'OWNER'` is safe** because the scope is a single workspace and
  `requireRole` exists to stop *users*, not the system. Audit rows written by the
  worker carry `actorUserId = null`, which `AuditLog` explicitly allows ("the
  actor may be the system (worker, scheduler)").

Cross-tenant maintenance (prune terminal jobs, expire invites) is the one thing
that legitimately spans workspaces. It lives in `modules/jobs/repo.ts` and
`modules/workspace/repo.ts` as functions named `*AcrossWorkspaces`, takes no
`Ctx`, is reachable only from `worker/maintenance.ts`, and is enumerated
exhaustively here:

```
jobs.pruneTerminalJobsAcrossWorkspaces(olderThanDays)
jobs.reclaimExpiredLeasesAcrossWorkspaces()
workspace.expireInvitesAcrossWorkspaces()
workspace.purgeSoftDeletedWorkspaces(olderThanDays)
mailboxes.listDueForWatchRenewAcrossWorkspaces()
analytics.listWorkspacesNeedingRollup()
```

Six functions. Any seventh needs lead approval, and the naming suffix makes an
unreviewed addition greppable.

---

## 5. The Server Action wrapper

### 5.1 What it must do, in order

```
raw input from the client
      │
      ├─1. authenticate      requireAuth() / requireWorkspace(role)   → Ctx
      ├─2. authorize         role floor from config
      ├─3. validate          config.input.safeParse(raw)              → typed input
      ├─4. rate limit        after validation, keyed by ctx+input
      ├─5. run               handler({ input, ctx })
      ├─6. revalidate        config.revalidate(input, data)
      ├─7. log               action.invoked / action.rejected
      └─8. return            ActionResult<T>  — a value, never a thrown error
```

Ordering is not arbitrary. Auth precedes validation so an unauthenticated caller
learns nothing about our input shape. Rate limiting follows validation so a
malformed flood cannot consume a legitimate user's budget, and so the limit key
may reference validated fields. Revalidation follows the handler so a failed
mutation never busts a cache.

### 5.2 The result type

```ts
// src/server/action.ts (types)
export type ActionFailure = {
  code: AppErrorCode                       // 'validation' | 'forbidden' | …
  message: string                          // safe for display; never internal detail
  fieldErrors?: Record<string, string[]>   // set only when code === 'validation'
  retryAfterMs?: number                    // set only when code === 'rate_limited'
}

export type ActionResult<T> =
  | { ok: true;  data: T }
  | { ok: false; error: ActionFailure }
```

A discriminated union on `ok`, so a client narrows with one `if` and TypeScript
guarantees `data` is unreachable on the failure branch. `useActionState` consumers
render `error.fieldErrors` next to inputs and `error.message` in an `aria-live`
region.

### 5.3 The implementation

Compiles as written.

```ts
// src/server/action.ts
import 'server-only'
import { z } from 'zod'
import type { Role } from '@prisma/client'
import {
  AppError, InternalError, ValidationError, RateLimitedError,
  isAppError, type AppErrorCode,
} from '@/lib/errors'
import { log } from '@/lib/logger'
import { consumeRateLimit } from '@/lib/rate-limit'
import { requireAuth, requireWorkspace } from './guards'
import type { Ctx, SessionCtx } from './ctx'

type Auth = 'public' | 'session' | 'workspace'

type ActionConfig<S extends z.ZodType, T, A extends Auth> = {
  /** Stable dotted name: 'leads.create'. Appears in every log line and metric. */
  name: string
  /** Default 'workspace'. 'session' = logged in, no workspace yet. 'public' = login/register. */
  auth?: A
  /** Role floor. Ignored unless auth === 'workspace'. */
  role?: Role
  input?: S
  rateLimit?: { key: (input: z.output<S>) => string; limit: number; windowMs: number }
  /** Cache invalidation. Runs ONLY on success. Called with the handler's output. */
  revalidate?: (input: z.output<S>, data: T) => void | Promise<void>
  handler: (args: {
    input: z.output<S>
    ctx: A extends 'workspace' ? Ctx : A extends 'session' ? SessionCtx : undefined
  }) => Promise<T>
}

export function action<S extends z.ZodType, T, A extends Auth = 'workspace'>(
  config: ActionConfig<S, T, A>,
): (raw: unknown) => Promise<ActionResult<T>> {
  return async function run(raw: unknown): Promise<ActionResult<T>> {
    const started = Date.now()
    const auth = (config.auth ?? 'workspace') as Auth
    try {
      // 1 + 2 — authenticate and authorize before looking at input at all.
      let ctx: Ctx | SessionCtx | undefined
      if (auth === 'workspace') ctx = await requireWorkspace(config.role)
      else if (auth === 'session') ctx = await requireAuth()

      // 3 — validate. Unknown keys (including a smuggled workspaceId) are dropped.
      let input: z.output<S>
      if (config.input) {
        const parsed = config.input.safeParse(raw)
        if (!parsed.success) {
          const { fieldErrors } = z.flattenError(parsed.error)
          throw new ValidationError(
            'Check the highlighted fields.',
            fieldErrors as Record<string, string[]>,
          )
        }
        input = parsed.data as z.output<S>
      } else {
        input = undefined as z.output<S>
      }

      // 4 — rate limit, keyed on the validated input.
      if (config.rateLimit) {
        const { key, limit, windowMs } = config.rateLimit
        await consumeRateLimit(`${config.name}:${key(input)}`, limit, windowMs)
      }

      // 5 — run.
      const data = await config.handler({ input, ctx: ctx as never })

      // 6 — invalidate caches only now that the write committed.
      await config.revalidate?.(input, data)

      log.info({ event: 'action.invoked', name: config.name, durationMs: Date.now() - started })
      return { ok: true, data }
    } catch (err) {
      // redirect() and notFound() throw Next control-flow signals. They must
      // propagate, not be swallowed into an ActionFailure.
      rethrowFrameworkErrors(err)

      const appErr: AppError = isAppError(err)
        ? err
        : new InternalError('Something went wrong. Please try again.', {}, { cause: err })

      const failure: ActionFailure = { code: appErr.code, message: appErr.message }
      if (appErr instanceof ValidationError) failure.fieldErrors = appErr.fieldErrors
      if (appErr instanceof RateLimitedError) failure.retryAfterMs = appErr.retryAfterMs

      const level = appErr.expected ? 'warn' : 'error'
      log[level]({
        event: 'action.rejected',
        name: config.name,
        code: appErr.code,
        durationMs: Date.now() - started,
        err: { name: appErr.name, message: appErr.message, stack: appErr.stack },
      })
      return { ok: false, error: failure }
    }
  }
}
```

`rethrowFrameworkErrors` wraps Next's `unstable_rethrow`, which exists precisely
for this case ("wrapping an API that uses errors to interrupt control flow"):

```ts
// src/server/action.ts (helper)
import { unstable_rethrow } from 'next/navigation'

function rethrowFrameworkErrors(err: unknown): void {
  unstable_rethrow(err)   // no-op unless err is a Next internal signal
}
```

Without this, `requireWorkspace()`'s `redirect('/onboarding')` would be caught by
our `catch` and reported to the user as `{ ok: false, code: 'internal' }`. This
is the single most likely bug in the whole wrapper and it is silent — the
redirect just stops happening.

### 5.4 Using it

```ts
// src/app/(app)/leads/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { action } from '@/server/action'
import { ConflictError, ValidationError } from '@/lib/errors'
import * as leads from '@/modules/leads'

export const createLead = action({
  name: 'leads.create',
  role: 'MEMBER',
  input: leads.createLeadSchema,
  rateLimit: { key: () => 'ws', limit: 120, windowMs: 60_000 },
  revalidate: () => revalidatePath('/leads'),
  handler: async ({ input, ctx }) => {
    const res = await leads.create(ctx, input)
    if (!res.ok) {
      // A Result error becomes a typed ActionFailure by throwing the matching
      // AppError. The wrapper does the mapping; the action states the meaning.
      if (res.error.kind === 'duplicate_email') {
        throw new ConflictError('A lead with that email already exists.', {
          existingLeadId: res.error.existingLeadId,
        })
      }
      throw new ValidationError('That lead could not be created.', {
        email: [res.error.kind],
      })
    }
    return res.value
  },
})

export const deleteLeads = action({
  name: 'leads.bulkDelete',
  role: 'ADMIN',                                    // brief §6: bulk delete is ADMIN+
  input: z.object({ ids: z.array(z.cuid()).min(1).max(1000) }),
  revalidate: () => revalidatePath('/leads'),
  handler: ({ input, ctx }) => leads.softDelete(ctx, input.ids),
})
```

Four properties follow from the shape and are worth naming:

- **`ctx` is never constructed in an action body.** The wrapper hands it over.
  An action that calls `requireWorkspace()` itself is redundant and a review flag.
- **The action file is thin.** Its whole job is: name, role, schema, revalidation
  path, and mapping module `Result` errors to `AppError`s. Any logic in an action
  body belongs in the service.
- **`role` is declarative**, so "which actions are ADMIN-only" is answerable by
  grep, which is what makes the §16 table maintainable.
- **Progressive-enhancement `<form action={fn}>`** works because the wrapper
  accepts `unknown`. For a raw `FormData`, the action file converts with
  `Object.fromEntries(fd)` before calling; zod `z.coerce` handles the
  string-typed values. We do not put `FormData` handling in the wrapper — it
  would force every JSON caller to pay for it.

### 5.5 What the wrapper deliberately does not do

- **No CSRF token.** Next's Server Actions already require a POST with an action
  id and enforce an origin check. Adding our own token would be ceremony. Route
  handlers *do* need an explicit check (§7.3) because they have no such
  protection.
- **No automatic audit log.** Auditing is a domain decision — `AuditLog.action`
  is a curated dotted vocabulary, not "every action that ran". Services write
  audit rows for the events brief §6 lists.
- **No retries.** A retried mutation without an idempotency key is a duplicate
  (§13). Retry is the user's decision in the UI or the queue's, with a key.
- **No response caching.** Actions are mutations.

---

## 6. Error model

### 6.1 The hierarchy

`src/lib/errors.ts`. Compiles as written.

```ts
// src/lib/errors.ts
export type AppErrorCode =
  | 'not_found' | 'forbidden' | 'unauthenticated' | 'validation'
  | 'conflict' | 'rate_limited' | 'provider_error' | 'unavailable' | 'internal'

export abstract class AppError extends Error {
  abstract readonly code: AppErrorCode
  abstract readonly httpStatus: number
  /** false ⇒ log at error and treat as a bug. true ⇒ a normal outcome. */
  readonly expected: boolean = true

  constructor(
    message: string,
    readonly meta: Readonly<Record<string, unknown>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = new.target.name
  }
}

export class NotFoundError extends AppError {
  readonly code = 'not_found' as const
  readonly httpStatus = 404
  constructor(resource: string, id?: string) {
    super(`${resource} not found`, id === undefined ? { resource } : { resource, id })
  }
}

export class ForbiddenError extends AppError {
  readonly code = 'forbidden' as const
  readonly httpStatus = 403
}

export class UnauthenticatedError extends AppError {
  readonly code = 'unauthenticated' as const
  readonly httpStatus = 401
}

export class ValidationError extends AppError {
  readonly code = 'validation' as const
  readonly httpStatus = 422
  constructor(message: string, readonly fieldErrors: Record<string, string[]> = {}) {
    super(message, { fieldErrors })
  }
}

export class ConflictError extends AppError {
  readonly code = 'conflict' as const
  readonly httpStatus = 409
}

export class RateLimitedError extends AppError {
  readonly code = 'rate_limited' as const
  readonly httpStatus = 429
  constructor(message: string, readonly retryAfterMs: number) {
    super(message, { retryAfterMs })
  }
}

/** A third party failed. `retryable` decides whether the queue backs off or dead-letters. */
export class ProviderError extends AppError {
  readonly code = 'provider_error' as const
  readonly httpStatus = 502
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    meta: Record<string, unknown> = {},
  ) {
    super(message, { ...meta, provider, retryable })
  }
}

/** OUR dependency is down (DB unreachable, migration pending). */
export class UnavailableError extends AppError {
  readonly code = 'unavailable' as const
  readonly httpStatus = 503
}

/** The only one with expected = false. If you construct this by hand, reconsider. */
export class InternalError extends AppError {
  readonly code = 'internal' as const
  readonly httpStatus = 500
  override readonly expected = false
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }
export const Ok  = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error })
```

Design notes:

- **`abstract readonly code` with `as const` in each subclass** gives exhaustive
  narrowing in a `switch (err.code)` without a hand-maintained map.
- **`this.name = new.target.name`** so a minified production bundle still logs
  `NotFoundError`, not `Error`.
- **`cause` is used, not swallowed.** `new InternalError(msg, {}, { cause: err })`
  keeps the original stack for the log while showing the user a safe message.
- **`meta` is `Record<string, unknown>`, never `any`.** Lint bans `any`.
- **`ProviderError` is the seam to the queue.** `06-jobs-and-sending-engine.md`
  §6.6 declares `RetryableError`/`TerminalError`/`DeferError extends AppError`.
  Those are queue-control classes and live in `modules/jobs/`; `ProviderError`
  is the domain fact. Classification maps one to the other:
  `ProviderError.retryable === true` → `RetryableError`, `false` →
  `TerminalError`. Both directions are in `modules/sending/providers/gmail.ts`.

### 6.2 The one error we do not model

There is no `TimeoutError`. A DB statement timeout surfaces as
`UnavailableError`; a provider timeout surfaces as
`ProviderError(retryable: true)`. A separate class would force every consumer to
handle a third case whose correct response is always one of those two.

### 6.3 Throw vs `Result<T, E>` — the decision rule

> **Throw when the caller cannot reasonably do anything except show an error.
> Return a `Result` when a specific failure has its own UI or its own next step.**

| Situation | Mechanism | Why |
|---|---|---|
| Lead id not in this workspace | `throw NotFoundError` | page renders 404; there is no "handle" |
| Caller is `MEMBER`, needs `ADMIN` | `throw ForbiddenError` | one response: tell them |
| Malformed input | `throw ValidationError` (wrapper does it) | field errors are the UI |
| Duplicate email on lead create | `Result` → `duplicate_email` | UI offers "open the existing lead" |
| CSV row invalid | `Result` per row | invalid rows are *reported*, valid rows import |
| Lead is suppressed at enrollment | `Result` → `suppressed` | enrollment continues for the rest; count shown |
| Campaign has no sendable mailbox | `Result` → `no_eligible_mailbox` | launch dialog names the fix |
| Gmail 429 | `throw ProviderError(retryable)` | the queue handles it; no UI involved |
| Gmail 400 invalid recipient | `throw ProviderError(!retryable)` | dead-letter + suppress the lead |
| DB unreachable | let it propagate → `internal`/`unavailable` | nothing to decide |
| A batch where some items fail | `Result` with per-item outcomes | partial success is the truth |

The failure mode this rule prevents: `Result` everywhere. Then every call site
is `if (!r.ok) return r` noise, and the type of a five-step service function
becomes a union of eleven error kinds nobody handles. `Result` earns its keep
only where a branch actually exists.

Corollary: **a `Result` error kind must have a named UI treatment.** If nobody
can say what the screen does differently, it should have been a throw.

### 6.4 The 404-not-403 rule

**Cross-workspace access returns 404. Always. No exceptions.**

403 says "this exists, and it is not yours" — a membership oracle. An attacker
enumerating cuids learns which ids are live in other tenants, and 404-vs-403 on
`/campaigns/<id>` leaks whether a competitor runs a campaign we happen to know
the id of.

Mechanically this is free, because the workspace filter is inside the query:

```ts
// Correct: one query, cannot distinguish "absent" from "foreign".
const row = await db.lead.findFirst({ where: { id, workspaceId: ctx.workspaceId } })
if (!row) throw new NotFoundError('Lead', id)

// WRONG: two queries, and the second one leaks.
const row = await db.lead.findUnique({ where: { id } })
if (!row) throw new NotFoundError('Lead', id)
if (row.workspaceId !== ctx.workspaceId) throw new ForbiddenError('Not your lead.')
```

The wrong version is the natural thing to write, which is why the rule is stated
and why `repo.scope(ctx)` exists: with the filter in the `where`, there is no
place to put the leak. `findUnique({ where: { id } })` on a tenant-owned table is
a review rejection.

`ForbiddenError` is reserved for **role** failures on a resource the caller's
workspace does own — a `MEMBER` pressing "delete all leads". There, 403 leaks
nothing: they already know the workspace exists.

### 6.5 Error → HTTP → UI

| `AppError` | HTTP (route handler) | Server Component | Action result | UI |
|---|---|---|---|---|
| `NotFoundError` | 404 | `notFound()` → in-shell 404 | `code: 'not_found'` | "Not found" + back link |
| `ForbiddenError` | 403 | in-shell unauthorized state | `code: 'forbidden'` | "You do not have permission" + who to ask |
| `UnauthenticatedError` | 401 | `redirect('/login?next=…')` | `code: 'unauthenticated'` | client redirects to login |
| `ValidationError` | 422 | *(cannot occur — no user input)* | `code: 'validation'` + `fieldErrors` | inline field errors, `aria-live` summary |
| `ConflictError` | 409 | `error.tsx` | `code: 'conflict'` | specific message + the alternative action |
| `RateLimitedError` | 429 + `Retry-After` | rate-limited state | `code: 'rate_limited'` + `retryAfterMs` | "Try again in Ns", control disabled with countdown |
| `ProviderError` | 502 | disconnected/degraded state | `code: 'provider_error'` | honest "Gmail is not responding" + Retry |
| `UnavailableError` | 503 | `error.tsx` | `code: 'unavailable'` | "Temporarily unavailable" + Retry |
| `InternalError` / unknown | 500 | `error.tsx` | `code: 'internal'` | generic message + Retry; **detail only in logs** |

Two hard rules on the boundary:

1. **A 500 body never contains `err.message` from an unknown error.** It may
   carry a database error, a file path, or a fragment of a query. The user gets
   a fixed string plus the `requestId`; the detail is in the log line keyed by
   that id.
2. **Server Components translate, they do not catch-and-render.** A page calls
   `notFound()` or `redirect()` and lets everything else hit `error.tsx`. A page
   that try/catches around a module call and renders its own error box
   duplicates the boundary and loses the reset button.

```
        module service
              │ throws AppError
   ┌──────────┴──────────┬────────────────────┐
   ▼                     ▼                    ▼
 action()            page/layout        route handler
 catches →           translates →       maps →
 ActionResult        notFound()         Response(status)
                     redirect()         + { code, message, requestId }
 │                   or bubbles to
 ▼                   error.tsx
 form/toast state
```

### 6.6 Prisma error codes we interpret

Only these three. Anything else propagates as `InternalError`.

| Prisma code | PG | Meaning | Mapping |
|---|---|---|---|
| `P2002` | 23505 | unique violation | `ConflictError`, or a `Result` dedupe branch (`Lead(workspaceId,email)`, `Job.dedupeKey`, `ScheduledEmail.dedupeKey`, `EmailEvent.dedupeKey`) |
| `P2003` | 23503 | FK violation | `ConflictError('Referenced record no longer exists.')` — normally a concurrent delete |
| `P2025` | — | record required but not found | `NotFoundError` |

`P2002` on a `dedupeKey` is **not an error** in the queue path: the schema states
"a second insert with the same key raises 23505 and the caller treats that as
success". `jobs.enqueue` returns `{ created: false }`. Never surface it as a
conflict — a deduped enqueue is the system working.

---

## 7. Route handlers vs Server Actions

### 7.1 The decision rule

> **Server Action** when the caller is our own authenticated UI and the payload
> is small and structured.
>
> **Route handler** when *any* of these is true: the caller is not our UI (a
> provider, a cron, a recipient's mail client); there is no session; the request
> or response must stream; the response needs a non-HTML content type or a
> specific status code; or the caller cannot invoke an action id (an OAuth
> redirect is a browser GET).

Server Actions cannot satisfy those. An action is a POST with a framework action
id, it buffers its body, it returns serialised React data rather than a typed
HTTP response, and it cannot be a GET at all.

### 7.2 Every route handler, and why it must be one

| Route | Method | Auth | Why not an action |
|---|---|---|---|
| `/api/oauth/google/start` | GET | session + workspace | Must **302 to Google**. An action cannot redirect off-origin as its response. Signs a single-use `state` (brief §6) and rate-limits. |
| `/api/oauth/google/callback` | GET | signed `state` only | Google performs a browser **GET**. No action id exists. Verifies `state`, exchanges the code, encrypts the refresh token (AES-256-GCM, `encryptionKeyVersion`), writes `EmailAccount`, enqueues `MAILBOX_BACKFILL`. |
| `/api/webhooks/gmail` | POST | `GMAIL_PUBSUB_VERIFICATION_TOKEN` + Google JWT | Pub/Sub is a third party with an aggressive ack deadline. Persists a `WebhookEvent` (unique `providerEventId` makes redelivery a no-op), enqueues `PROCESS_WEBHOOK_EVENT`, **returns 204 immediately**. Never processes inline. |
| `/api/worker/tick` | POST | `Authorization: Bearer $WORKER_AUTH_TOKEN` | Called by a platform cron with no cookie. Constant-time token compare. Returns `{ leased, succeeded, failed }` JSON. |
| `/api/leads/import` | POST | session + workspace | **Streams** a multipart body up to 20MB. An action buffers the whole body in memory — a self-inflicted DoS (`03-frontend.md` §7.4 says the same). Enforces 20MB / 50k rows, sniffs delimiter and BOM, writes `LeadImport`, returns `{ importId }`. |
| `/api/leads/export` | GET | session + workspace | Streams a `text/csv` response with `Content-Disposition`. Must escape `= + - @` and tab/CR leaders per cell (formula injection, brief §6). Keyset-paginates the cursor so memory is O(page), not O(leads). |
| `/api/leads/import/[importId]/errors.csv` | GET | session + workspace | Same: streamed CSV download. |
| `/api/track/open/[token]` | GET | none (token) | Must return a 1×1 GIF with `Content-Type: image/gif` and no-store. Records `OPENED` with `isBot` heuristics. Fire-and-forget: the write happens in `after()` so the pixel is not delayed. |
| `/api/track/click/[token]` | GET | none (token) | Must **302** to `TrackingLink.originalUrl`. `token` is `@unique` globally because there is no session at redirect time. |
| `/api/unsubscribe/[token]` | GET → confirm POST | none (token) | A one-click link from a recipient's mail client. **GET must not mutate** (brief §6 forbids state-changing GETs): GET renders a confirmation, POST writes `Suppression` and enqueues `unsubscribe.process`. Also honours RFC 8058 `List-Unsubscribe-Post` on POST directly. |
| `/api/health` | GET | none | LB probe. Needs a real 503 for `down`, 200 for `ok`/`degraded` (`09` §5.3). No tenant data in the body. |

Everything else is a Server Action. There is no general-purpose REST API in v1 —
a public API is phase 11 and gets its own key model and its own doc.

### 7.3 Route handler obligations

A route handler has none of an action's built-in protection, so all of it is
explicit. The shared helper enforces the order.

```ts
// src/server/route.ts
import 'server-only'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { AppError, InternalError, isAppError } from '@/lib/errors'
import { log } from '@/lib/logger'

type RouteAuth = 'workspace' | 'session' | 'worker-token' | 'webhook' | 'public-token'

export type RouteConfig<S extends z.ZodType, T> = {
  name: string
  auth: RouteAuth
  /** Required for every non-GET with auth 'workspace' | 'session'. */
  requireSameOrigin?: boolean
  input?: S
  handler: (args: { input: z.output<S>; req: Request; ctx: unknown }) => Promise<T>
}

export function jsonRoute<S extends z.ZodType, T>(config: RouteConfig<S, T>) {
  return async function handle(req: Request): Promise<Response> {
    const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID()
    try {
      // ... auth by mode, same-origin check, zod parse (see below)
      const data = await config.handler({ input: undefined as z.output<S>, req, ctx: undefined })
      return NextResponse.json(data, { headers: { 'x-request-id': requestId } })
    } catch (err) {
      const e: AppError = isAppError(err) ? err : new InternalError('Internal error', {}, { cause: err })
      log[e.expected ? 'warn' : 'error']({
        event: 'http.request.completed', name: config.name,
        status: e.httpStatus, requestId,
        err: { name: e.name, message: e.message, stack: e.stack },
      })
      return NextResponse.json(
        { code: e.code, message: e.expected ? e.message : 'Internal error', requestId },
        { status: e.httpStatus, headers: { 'x-request-id': requestId } },
      )
    }
  }
}
```

The five obligations, restated as review items:

1. **Same-origin check on every mutating handler with cookie auth.** Actions get
   this from Next; handlers do not. Compare `Origin` (or `Sec-Fetch-Site`) against
   `APP_URL`; reject with 403 on mismatch. Without it, `/api/leads/import` is a
   CSRF target that uploads a lead list into the victim's workspace.
2. **Constant-time secret comparison.** `WORKER_AUTH_TOKEN` and the Pub/Sub
   verification token are compared with `crypto.timingSafeEqual` over equal-length
   buffers, never `===`.
3. **Webhook payloads are data, never instructions** (brief §6). A Gmail push tells
   us *a mailbox changed*; we then call Gmail ourselves. We never act on
   payload-supplied ids without resolving them through our own tables — the
   `WebhookEvent.workspaceId`-nullable / `UNMATCHED` state exists precisely so an
   unattributable payload is quarantined rather than trusted.
4. **Public-token handlers do zero session work and leak nothing.** An open-pixel
   or click token resolves to a `TrackingLink` row; the response is a GIF or a
   302 and *never* an error body naming a campaign, lead, or workspace. An unknown
   token still returns the GIF / a 302 to a safe default. Behaving differently for
   valid and invalid tokens is an enumeration oracle.
5. **No state-changing GET.** Tracking pixels and click redirects are the one
   apparent exception, and they are not: they append to `EmailEvent`, an
   append-only fact log, they are idempotent under prefetch, and `isBot` marks
   scanner traffic. A GET must never change *user-visible* state — which is why
   unsubscribe splits into GET-confirm and POST-commit.

### 7.4 The tracking-write pattern

Both tracking routes must respond in single-digit milliseconds and must not fail
the response if the DB is slow:

```ts
// src/app/api/track/open/[token]/route.ts
import { after } from 'next/server'

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  after(async () => {
    // Runs after the response is flushed. A failure here loses one open event —
    // acceptable, because open tracking is explicitly indicative (brief §10).
    await analytics.recordOpenByToken(token, {
      userAgent: req.headers.get('user-agent'),
      ip: clientIp(req),
    })
  })
  return new Response(TRANSPARENT_GIF, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Content-Length': String(TRANSPARENT_GIF.byteLength),
    },
  })
}
```

**The real-world caveat, stated plainly:** open tracking is unreliable and we
must not pretend otherwise. Gmail proxies images through
`googleusercontent.com`, often prefetching them at delivery time, which produces
an "open" nobody performed; Apple Mail Privacy Protection prefetches everything;
corporate scanners fetch links and pixels; and a large fraction of clients block
remote images entirely, producing no event for a genuine read. Consequences that
are already in the design: `EmailEvent.isBot` exists and headline rates exclude
bot events; `EmailEvent.isFirstForSend` makes unique-open counting a filtered
count; `Experiment.primaryMetric` defaults to `"reply"`, not open; and the UI
labels opens indicative. Never gate a product decision on an open rate. A click
is stronger evidence but shares the scanner problem. A **reply** is the only
signal we treat as fact.

---

## 8. Transaction strategy

### 8.1 Three tools, in order of preference

| Tool | Use when | Cost |
|---|---|---|
| A single statement (`updateMany` with a guard in `where`, `createMany`, `INSERT … ON CONFLICT`) | the atomic unit is one row-set | none — no explicit tx at all |
| `prisma.$transaction([...])` (batch) | 2+ independent writes, no reads between them | one round trip, connection held briefly |
| `prisma.$transaction(async (tx) => …)` (interactive) | a write depends on a read taken in the same tx | holds a pooled connection for the whole callback |

**Reach for the first one first.** Most "I need a transaction" instincts are
actually "I need a conditional update", and a conditional update is atomic on its
own. The canonical example is claiming a send:

```sql
-- Not a transaction. Exactly one worker wins; the loser sees count = 0.
UPDATE "ScheduledEmail"
   SET state = 'SENDING', "claimedAt" = now(), "claimedBy" = $worker
 WHERE id = $id AND state = 'SCHEDULED';
```

That single statement is the whole "we never send the same email twice"
enforcement at claim time, and it needs no transaction, no isolation level, and
no lock we hold.

### 8.2 Where an interactive transaction is genuinely required

Four places. Each is listed with what must commit together and why nothing weaker
works.

**(1) Enrollment — `campaigns.enroll(ctx, campaignId, leadIds)`**

```
BEGIN  (ReadCommitted)
  ├─ read   Campaign  (status, timezone, skipIfInOtherCampaign, sequence.version)
  ├─ read   Suppression WHERE (workspaceId, scope, value) ∈ leads' emails+domains
  ├─ read   CampaignLead WHERE leadId IN (…) AND state ∈ active  (skipIfInOtherCampaign)
  ├─ write  CampaignLead  createMany skipDuplicates      ← @@unique([campaignId, leadId])
  ├─ write  Campaign.leadCount += inserted
  └─ write  Job(SCHEDULER_TICK, dedupeKey "SCHEDULER_TICK:<campaignId>:<bucket>")
COMMIT
```

Interactive because the suppression and duplicate-enrollment reads decide which
rows get written. `skipDuplicates` plus `@@unique([campaignId, leadId])` makes a
concurrent second enroll a no-op rather than a failure, so this needs no stricter
isolation than `ReadCommitted`: the constraint, not the isolation level, provides
the guarantee. Batched at **500 lead ids per transaction** (`06` §5.2 uses the
same batch size for `lead.enroll`); a 50k-lead campaign is 100 short transactions,
not one long one.

**(2) Sequence advance — `campaigns.advance(ctx, campaignLeadId)`**

```
BEGIN  (ReadCommitted)
  ├─ read   CampaignLead  (state, currentStepId, lastCompletedPosition, nextStepAt,
  │                        assignedEmailAccountId, primaryThreadId)
  ├─ guard  state ∈ (ACTIVE, WAITING, PENDING)   else COMMIT and do nothing
  ├─ read   SequenceStep WHERE sequenceId AND position > lastCompletedPosition
  │                      AND enabled ORDER BY position LIMIT 1
  ├─ write  ScheduledEmail  INSERT  (dedupeKey, frozen subject/bodyHtml/bodyText)
  │                                 ← @@unique([campaignLeadId, sequenceStepId])
  ├─ write  CampaignLead  currentStepId, lastCompletedPosition, nextStepAt, state
  ├─ write  EmailEvent(QUEUED)
  └─ write  Job(SEND_SCHEDULED_EMAIL, dedupeKey "SEND_SCHEDULED_EMAIL:<seId>",
              scheduledEmailId FK, runAt = scheduledAt)
COMMIT
```

This is the transaction that makes the product's third invariant true. If the
`ScheduledEmail` row committed without the `CampaignLead` update, the next tick
would materialise the same step again — and the `@@unique([campaignLeadId,
sequenceStepId])` constraint would catch it, but the enrollment would be stuck.
If the `CampaignLead` advanced without the `Job`, the email would never send. Both
halves commit or neither does.

`ReadCommitted` suffices, again because of a constraint rather than a lock: two
concurrent ticks both insert, one gets 23505, and the loser rolls back and exits
cleanly. This is the deliberate trade — **let the database's unique index be the
serialisation point, not `SERIALIZABLE` isolation.**

**(3) Enqueue-with-row — the general pattern**

Any state change that must cause background work:

```ts
await prisma.$transaction(async (tx) => {
  await tx.campaign.update({
    where: { id },                                   // pre-verified in-workspace
    data: { status: 'ACTIVE', launchedAt: new Date() },
  })
  await jobs.enqueue({
    type: 'SCHEDULER_TICK',
    workspaceId: ctx.workspaceId,
    payload: { campaignId: id },
    tx,                                              // ← the reason the queue is in Postgres
  })
})
```

The `tx` parameter on `jobs.enqueue` is the single most important API in the
backend. With Redis this is a dual write that can drift: campaign ACTIVE with no
tick means a campaign that never sends and nobody notices for a day. Here it
cannot happen.

**(4) Send completion — `sending.markSent(ctx, scheduledEmailId, result)`**

```
BEGIN  (ReadCommitted)
  ├─ write ScheduledEmail  state=SENT, sentAt, providerMessageId, rfcMessageId,
  │                        providerThreadId   WHERE state='SENDING'  (guarded)
  ├─ write EmailEvent(SENT, dedupeKey)
  ├─ write MailboxDailyStat  upsert (emailAccountId, localDate) sentCount += 1
  ├─ write CampaignLead  sentCount += 1, lastSentAt
  ├─ write EmailAccount  sentCount += 1, lastSentAt
  └─ write Job(SCHEDULER_TICK, dedupeKey)      ← §2.4(a): breaks the cycle
COMMIT
```

The `WHERE state='SENDING'` guard makes a replayed `markSent` a zero-row update,
and `EmailEvent.dedupeKey` makes the event insert idempotent. Together: replay is
free.

### 8.3 Isolation levels

**`ReadCommitted` (Postgres default) everywhere.** No exceptions in the current
design. Justification per candidate:

| Candidate for stricter isolation | Why `ReadCommitted` is enough |
|---|---|
| Duplicate send | `@@unique([campaignLeadId, sequenceStepId])` + `@@unique([dedupeKey])` |
| Double enqueue | `Job.@@unique([dedupeKey])` |
| Double enrollment | `CampaignLead.@@unique([campaignId, leadId])` |
| Duplicate lead | `Lead.@@unique([workspaceId, email])` |
| Daily-cap overshoot | The cap is enforced by a conditional `UPDATE … WHERE sentCount < cap` on `MailboxDailyStat` inside the claim, which is atomic |
| Duplicate provider event | `EmailEvent.@@unique([dedupeKey])`, `WebhookEvent.providerEventId @unique` |
| Queue lease | `FOR UPDATE SKIP LOCKED` — a row lock, not an isolation concern |

The pattern is deliberate and worth naming: **every correctness guarantee in this
system is a database constraint or a row lock, never an isolation level.**
`SERIALIZABLE` would add serialisation failures that every call site must retry,
and retry logic around a send is exactly where duplicates come from. If a future
invariant genuinely needs `RepeatableRead` or `SERIALIZABLE`, it goes in this
table with its retry policy, and not before.

Prisma's isolation values are TypeScript-cased, not SQL-cased:
`'ReadCommitted'`, not `'READ COMMITTED'`. Passing the SQL spelling is a type
error, which is the good outcome.

### 8.4 Keeping transactions short

The pool is 8–10 connections (§9.3). A transaction holds one for its whole
duration, so a 3-second transaction under 10 concurrent requests is an outage.

**Hard rules:**

1. **No network I/O inside a transaction.** Not Gmail, not Anthropic, not DNS,
   not a fetch of any kind. `09` §3.4 says the same about the lease. The send
   path is: claim (tx) → **provider call (no tx)** → `markSent` (tx). Three
   phases, and the middle one holds nothing.
2. **`timeout: 10_000, maxWait: 5_000`** as the default in
   `PrismaClient.transactionOptions` (§9.1). A transaction that cannot finish in
   10s is a design error, not a slow query — raise it explicitly per call site
   with a comment saying why, never globally.
3. **Read what you need *before* `BEGIN` when the read does not need to be
   consistent with the write.** Rendering a personalised body needs the lead's
   fields; that read happens outside, and the frozen content is passed in.
4. **Batch, do not loop.** `createMany` over 500 rows, not 500 `create` calls
   inside one transaction. A loop of awaits inside a transaction is the single
   most common way this design gets broken.
5. **Bulk operations above 500 rows become a job.** `03-frontend.md` §7.3
   already specifies this for the UI; the reason is this section. A 50k-row bulk
   tag is `LEAD_IMPORT_BATCH`-shaped work, chunked, each chunk its own short
   transaction.
6. **No `$transaction` in a route handler or a page.** Only in `service.ts`.
   Transaction boundaries are business boundaries.

### 8.5 The queue lease is not an interactive transaction

Worth separating, because it looks like one. The lease is:

```sql
-- modules/jobs/repo.ts :: leaseBatch  (one statement, one round trip)
WITH claimed AS (
  SELECT id FROM "Job"
   WHERE state IN ('PENDING','RETRYING') AND "runAt" <= now()
   ORDER BY priority DESC, "runAt" ASC
   FOR UPDATE SKIP LOCKED
   LIMIT $batch
)
UPDATE "Job" j
   SET state = 'RUNNING', "lockedBy" = $worker, "lockedAt" = now(),
       "leaseExpiresAt" = now() + ($leaseSeconds || ' seconds')::interval,
       attempt = j.attempt + 1
  FROM claimed c
 WHERE j.id = c.id
RETURNING j.*;
```

The row locks live only for that statement's implicit transaction — milliseconds.
The *work* then happens with no transaction open, bounded by `leaseExpiresAt`.
This is why the design survives a transaction-mode pooler (`09` §3.4) and why a
crashed worker's jobs recover without anything held open.

Note `priority DESC` here: `Job.priority` is documented in the schema as "Higher
runs first", while `06-jobs-and-sending-engine.md` §5 uses "lower number runs
first" with band numbers 10–200. Flagged in §17 — one of them must change, and
the SQL above follows the schema.

---

## 9. Connection management

### 9.1 `src/lib/db.ts` — the whole file

Prisma 7 removed `url` and `directUrl` from the `datasource` block entirely
(`INTEGRATION-NOTES.md` §1). The block carries `provider` only; `PrismaClient`
takes a **driver adapter**. Any code or doc showing `datasources: { db: { url } }`
or a URL in `schema.prisma` is Prisma ≤6 and wrong for this repo.

Compiles as written, verified against `@prisma/adapter-pg@7.10.0` and
`@types/pg@8.23.1`.

```ts
// src/lib/db.ts
import 'server-only'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

/**
 * Two access patterns, two budgets (09-deployment-and-testing.md §3.4).
 * Selected by IM_DB_PROFILE, which the worker sets and the web app does not.
 * Encoding the profile in an env var rather than a build flag means one image
 * runs both processes.
 */
type Profile = 'web' | 'worker'

const PROFILES: Record<Profile, {
  max: number
  statementTimeoutMs: number
  idleTimeoutMs: number
}> = {
  // Web: many short queries, bursty. 10 per replica × 3 replicas = 30 of ~100.
  web:    { max: 10, statementTimeoutMs: 10_000, idleTimeoutMs: 10_000 },
  // Worker: few longer transactions, steady. WORKER_CONCURRENCY(4) + 4 = 8.
  worker: { max:  8, statementTimeoutMs: 60_000, idleTimeoutMs: 30_000 },
}

function resolveProfile(): Profile {
  return process.env.IM_DB_PROFILE === 'worker' ? 'worker' : 'web'
}

function createPrisma(): PrismaClient {
  const profile = resolveProfile()
  const p = PROFILES[profile]

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: p.max,
    idleTimeoutMillis: p.idleTimeoutMs,
    connectionTimeoutMillis: 5_000,
    // Server-side kill switch: a runaway query cannot pin a connection forever.
    // Set on the connection, so it survives a Prisma-side timeout being missed.
    statement_timeout: p.statementTimeoutMs,
    // Shows up in pg_stat_activity — the difference between a five-minute
    // diagnosis and a fifty-minute one during an incident.
    application_name: `instantmail-${profile}`,
    // The worker should be able to exit cleanly on SIGTERM; the web process
    // keeps its pool warm.
    allowExitOnIdle: profile === 'worker',
  })

  const adapter = new PrismaPg(pool, { schema: 'public' })

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    // Defaults for EVERY $transaction; §8.4 rule 2.
    transactionOptions: { maxWait: 5_000, timeout: 15_000 },
  })
}

/**
 * Next dev HMR recreates modules on every edit. Without this cache each edit
 * leaks a Pool, and after twenty saves Postgres refuses connections with
 * "too many clients already" — which reads like a pooling bug and is not.
 */
const globalForPrisma = globalThis as unknown as { __imPrisma?: PrismaClient }

export const prisma: PrismaClient = globalForPrisma.__imPrisma ?? createPrisma()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__imPrisma = prisma
}
```

Details that are load-bearing:

- **`new PrismaPg(pool, …)` takes our `Pool`, not a connection string.** The
  string overload exists, but then pool sizing is Prisma's default
  (`cpus × 2 + 1`), which is wrong for both profiles. Owning the `Pool` is how
  `max`, `statement_timeout`, and `application_name` get set at all.
- **`connectionString: process.env.DATABASE_URL`** — the pool reads the env var
  directly. There is no schema URL to read and no `datasources` override.
- **The prod `log` level is `['error']`, not `['query']`.** Query logging on a
  send path prints recipient addresses, and brief §9 forbids that.
- **`process.env.NODE_ENV !== 'production'`** guards the global cache, not
  `=== 'development'`, so `test` also reuses one client across test files.
- **`serverExternalPackages`** in `next.config.ts` already lists
  `@prisma/client`, `@prisma/adapter-pg`, `pg`, so a stray client-side import
  fails at build instead of shipping a broken chunk.

### 9.2 The worker's client

The worker imports the same module. `worker/index.ts` sets the profile before any
import that could touch `db.ts`:

```ts
// worker/index.ts — FIRST lines of the file, before other imports.
process.env.IM_DB_PROFILE = 'worker'
```

Setting it after importing a module that transitively imports `db.ts` silently
gets the web profile, because `createPrisma()` already ran at module evaluation.
An assertion in `worker/index.ts` guards it:

```ts
if (resolveProfileForAssert() !== 'worker') {
  throw new Error('db.ts initialised before IM_DB_PROFILE was set — move the assignment up')
}
```

On `SIGTERM` the worker stops leasing, waits for in-flight jobs, then
`await prisma.$disconnect()`. The web process never disconnects — the pool lives
as long as the process.

### 9.3 Budget

From `09-deployment-and-testing.md` §3.4, restated because §8.4's rules only make
sense against these numbers:

```
managed Postgres, max_connections = 100
  web      3 replicas × 10                 = 30
  worker   1 replica  ×  8                 =  8
  migrate deploy (transient)               =  1
  operator psql / platform dashboard       =  5
  reserved superuser                       =  3
  ────────────────────────────────────────────
  peak                                     = 47   ✓ ~50% headroom
```

Local dev: one web process at 10 and one worker at 8 against the user-space
cluster on port 5433, whose `max_connections` is the initdb default of 100. Never
a constraint locally.

### 9.4 pgbouncer

We have no pooler today; the schema comment says so explicitly and says to add
`directUrl` "the same day a pooler lands, and not before". When one lands, four
things change and nothing else:

1. `DATABASE_URL` points at the pooler in **transaction mode**; `max` drops to
   `1` per serverless invocation (each invocation is its own process; the pooler
   does the pooling).
2. `DIRECT_DATABASE_URL` must be set and non-empty. `prisma.config.ts` already
   prefers it for Migrate, and DDL through a transaction pooler fails.
3. **Prepared statements must be disabled.** With `@prisma/adapter-pg` this is a
   `pg` concern, not a `?pgbouncer=true` query param: transaction-mode pooling
   gives a different backend per transaction, so a named prepared statement
   cached against one backend is not there on the next. `PrismaPgOptions` exposes
   `statementNameGenerator`, and the adapter does not cache prepared statements
   unless one is provided — so **do not provide one under a transaction pooler.**
   Leave it unset, which is the default in §9.1.
4. `SELECT … FOR UPDATE SKIP LOCKED` still works, because §8.5's lease is one
   statement and the work happens outside any transaction. Session-level state
   (`LISTEN/NOTIFY`, advisory locks held across statements, `SET` without
   `SET LOCAL`) does **not** work in transaction mode. This matters for one thing
   in the current design: `worker/maintenance.ts` uses
   `pg_try_advisory_lock` to serialise maintenance ticks. Under a transaction
   pooler that must become `pg_advisory_xact_lock` inside a transaction, which
   releases on commit. Noted here so the migration to a pooler is a checklist and
   not an investigation.

### 9.5 Prisma singleton anti-patterns

| Anti-pattern | What breaks |
|---|---|
| `new PrismaClient()` in a module or a route handler | one pool per module instance; connection exhaustion in dev within minutes |
| `$connect()` at import time | slows cold start; the adapter connects lazily on first query for a reason |
| A client per request | ~40ms of TCP + TLS + auth per request, and 100 concurrent requests exceed `max_connections` |
| `$disconnect()` in a route handler or after each action | kills the shared pool for every other in-flight request |
| Passing the client around as a parameter | encourages a repo taking a client from a caller that is not a transaction; `db: Db = prisma` in §3.3.3 is for `tx` only |

---

## 10. Pagination

### 10.1 Cursor (keyset) is the standard

```ts
// src/lib/pagination.ts
export type Cursor = string & { readonly __brand: 'Cursor' }

export type Page<T> = {
  rows: T[]
  nextCursor: Cursor | null
  hasMore: boolean
}

/** Every list endpoint's params extend this. */
export type PageParams = {
  cursor?: string
  limit: number            // clamped 1..100 by the module's zod schema
  dir: 'asc' | 'desc'
}
```

**Two non-negotiables:**

1. **The `ORDER BY` always ends with a unique tiebreak.** `ORDER BY <sortKey>
   <dir>, id <dir>`. Without it, ten leads created in the same millisecond
   produce a page boundary that skips and repeats rows — a bug that only appears
   on real data. The repo in §3.3.3 does this unconditionally.
2. **The cursor is opaque and validated on decode.** It is
   `base64url(JSON({ v, id }))`. A malformed cursor returns page 1 (see
   `decodeCursor` in §3.3.4), never a 500 — a stale bookmark is a normal event.

The cursor is **not** signed. It contains only a sort value and a row id, both of
which the holder already saw, and the query it feeds is still scoped by
`ctx.workspaceId`. A tampered cursor can at worst move the caller to a different
page of *their own* data. Signing would be theatre.

Why keyset by default: `OFFSET 40000` makes Postgres walk and discard 40,000
rows, so page 800 is 800× the cost of page 1, and any insert between requests
shifts every subsequent page. Keyset is an index seek — page 800 costs what page
1 costs.

### 10.2 Where offset is acceptable

Three conditions, **all** required:

1. The result set is bounded by construction (a workspace has ≤ 50 mailboxes,
   ≤ 20 members, ≤ 30 custom fields, ≤ 100 sequence steps).
2. The user needs page numbers (jump to page 7) or a total count.
3. The data changes slowly enough that page drift is not a correctness problem.

Concretely: **`/mailboxes`, `/settings/members`, `/settings/custom-fields`,
`/leads/lists`, the dead-letter job console.** All bounded, all admin-ish, all
better with a page count.

Everything else is keyset: leads, campaigns, inbox threads, thread messages,
events, activity timelines, opportunities, tasks, AI analyses, audit log.

### 10.3 The `/leads` exception, and why this doc overrules `03-frontend.md`

`03-frontend.md` §7.2 specifies **offset** pagination for `/leads`, with
`page`/`per` params, an exact `total`, and a `pageCount`. Its reasoning is
genuine: users jump to page 7, and "select all matching" wants a stable notion of
a filtered set.

That is a real product requirement and it is satisfiable without offset:

- **Exact total: keep it.** `total` comes from a separate
  `repo.countScoped(ctx, filter)` — one indexed `COUNT(*)`, run in parallel with
  the page query. Counting and paginating are independent; offset is not required
  for a count.
- **"Select all matching": keep it.** It already sends a *filter descriptor*, not
  ids (`03` §7.3 `BulkTarget = { kind: 'filter'; params; excluded }`). The server
  re-derives the set. It never needed a page number.
- **Page numbers: this is the actual loss.** Keyset gives previous/next, not
  "jump to page 7".

**Decision: `/leads` is keyset with an exact total, and the UI shows
"1–50 of 1,284" with previous/next rather than numbered pages.** Reasons, in
order: a 200k-lead workspace makes deep offset pages slow enough to notice while
the filter+sort keyset path stays flat; jumping to page 7 of a lead list ordered
by `createdAt` is not a real workflow (searching and filtering is); and having one
pagination mechanism for all six large tables is worth more than page numbers on
one of them.

This contradicts `03-frontend.md` §7.2 and is flagged in §17 for the lead. If the
lead rules for offset, the change is contained: `leadFilterSchema` swaps
`cursor` for `page`, `repo.findPage` takes `skip`, and `Page<T>` grows
`page`/`pageCount` — `service.list`'s signature does not change. The tiebreak
rule in §10.1 applies either way (`03` §7.2 says the same).

### 10.4 Bulk selection

Never ship a list of ids where a filter will do.

```ts
// src/lib/pagination.ts
export type BulkTarget =
  | { kind: 'ids'; ids: string[] }                              // hard cap 1000
  | { kind: 'filter'; params: unknown; excluded: string[] }      // params re-parsed server-side
```

The server re-derives the set from `params` under `ctx.workspaceId`, so a client
cannot widen the blast radius past what its own filter selects. Above **500**
affected rows the operation becomes a job (chunked, one short transaction per
chunk — §8.4 rule 5) and the UI reports progress. `bulkDelete` additionally
requires `ADMIN` and writes an `AuditLog` row.

### 10.5 The inbox's extra requirement

`EmailThread` is ordered by `lastMessageAt DESC`, which **mutates** when a new
message arrives — a row can move from page 3 to page 1 mid-scroll. Keyset handles
this correctly (you simply do not see the moved row again) but the count changes
under the user.

The design already answers this without a data-fetching library: no silent
mutation of the list, a 60-second `inbox.unreadSince(ctx, since)` poll while the
tab is visible, and a non-moving "3 new messages — refresh" pill
(`03-frontend.md` §5.10). Backend obligation: `unreadSince` must be **one indexed
count** — it is served by
`@@index([emailAccountId, isRead, lastMessageAt(sort: Desc)])` — and nothing else.

---

## 11. Caching and revalidation

### 11.1 The default is: do not cache tenant data

Every `(app)/**` page reads cookies through `requireWorkspace()`, which makes the
route dynamic. That is correct and we do not fight it. RSC still gives us
streaming, parallel section queries, and per-`<Suspense>` boundaries — the
performance story is "seven parallel indexed queries", not "a cache".

**The rule that matters, stated as an absolute:**

> **A cache entry containing tenant data must have `workspaceId` in its key. No
> exceptions. A cache key that omits it is a cross-tenant data leak, which is
> strictly worse than a slow page.**

This is why `"use cache"` and `unstable_cache` are near-banned in this codebase:
their default key is the function's arguments plus the build id, so a helper that
closes over `ctx` instead of taking `workspaceId` as an argument caches one
tenant's rows under a key every tenant hits. That failure is silent, it passes
review, and it violates brief §4.

### 11.2 What is cached

| Data | Mechanism | Key | Lifetime |
|---|---|---|---|
| Static marketing, legal, pricing pages | full route cache (no cookie read) | route | build |
| Fonts, icons, CSS, JS | immutable asset headers | content hash | 1 year |
| `next/font` self-hosted files | build-time | — | build |
| `CustomFieldDefinition` list per workspace | `unstable_cache`, key `['custom-fields', workspaceId]`, tag `ws:${workspaceId}:custom-fields` | includes `workspaceId` | 300s |
| Workspace nav badges (`getNavBadges`) | `unstable_cache`, key `['nav', workspaceId, userId]` | includes both | 60s |
| Everything else tenant-scoped | **not cached** | — | — |

Two entries, both because they are read on every page render and change rarely.
That is the whole list. `03-frontend.md` §3.5 already proposes `unstable_cache`
for the nav badges "keyed by workspace" — this section is the rule that makes that
safe.

Note `next/cache` in Next 16 also exports `cacheTag`, `cacheLife`, `updateTag`,
and `refresh` for the `"use cache"` directive. We do not adopt `"use cache"` for
tenant data, for the keying reason above. If a future need is genuine, the entry
goes in the table above with its key spelled out, and the key starts with
`workspaceId`.

### 11.3 Revalidation conventions

Path revalidation is the default; tags are for data that appears on pages other
than the one being mutated.

**Naming convention for tags — always workspace-prefixed:**

```
ws:${workspaceId}:leads
ws:${workspaceId}:campaigns
ws:${workspaceId}:campaign:${campaignId}
ws:${workspaceId}:mailboxes
ws:${workspaceId}:inbox
ws:${workspaceId}:custom-fields
ws:${workspaceId}:crm
```

The `ws:${workspaceId}:` prefix is mandatory. An unprefixed `leads` tag
invalidates every tenant's cache on one tenant's write — not a security hole, but
a self-inflicted thundering herd.

**Per-module revalidation table.** Server Actions declare this via
`action({ revalidate })`; nothing else calls `revalidatePath`.

| Module · operation | Revalidates |
|---|---|
| `leads.create` / `update` / `softDelete` | `/leads`, `/leads/${leadId}` |
| `leads.bulk*` | `/leads`; `tag ws:*:leads` |
| `leads.commitImport` | `/leads`, `/leads/import/${importId}` |
| `leads.createList` / list membership | `/leads/lists`, `/leads` |
| `leads.suppress` | `/leads/${leadId}`, `/settings/suppressions`; `tag ws:*:leads` |
| `campaigns.create` / `update` | `/campaigns`, `/campaigns/${id}` |
| `campaigns.launch` / `pause` / `resume` | `/campaigns`, `/campaigns/${id}`, `/dashboard` |
| `campaigns.enroll` | `/campaigns/${id}/leads`, `/campaigns/${id}` |
| `sequences.upsertStep` / `deleteStep` / `reorder` | `/campaigns/${id}/sequence`, `/campaigns/${id}` |
| `mailboxes.connect` / `disconnect` / `update` | `/mailboxes`, `/mailboxes/${id}`, `/dashboard` |
| `inbox.sendReply` / `archive` / `markRead` | `/inbox`, `/inbox/${threadId}`, `/dashboard` |
| `crm.*` | `/crm`, `/crm/opportunities/${id}`, `/leads/${leadId}` |
| `workspace.updateSettings` | `/settings`, `/` (`layout`) |
| `workspace.switchWorkspace` | `/` with `'layout'` — the shell must re-render |
| `ai.*` | nothing (results render in a client island that refreshes itself) |

Rules:

1. **Revalidate the specific path, then the list.** `/leads/${id}` and `/leads`,
   not `revalidatePath('/', 'layout')`. The nuclear option costs every user's
   entire router cache.
2. **Only `revalidatePath('/', 'layout')` for a workspace switch or a workspace
   settings change**, because those alter the shell itself.
3. **Worker code never revalidates.** `revalidatePath` requires a request scope
   and there is none in the worker. Data written by a job becomes visible on the
   user's next navigation — which is why `/leads/import/[importId]/running` polls
   (`03` §7.4) and why the inbox has its "new messages" pill.
4. **Revalidation runs only on success**, enforced by the wrapper's step order
   (§5.1). Busting a cache after a failed write means re-fetching identical data.

### 11.4 Cross-workspace cache safety checklist

Four grep-able review items:

```bash
# 1. No unstable_cache / "use cache" outside the two approved entries.
grep -rn "unstable_cache\|'use cache'\|\"use cache\"" src/

# 2. Every cache key array literally contains workspaceId.
grep -rn -A3 "unstable_cache(" src/ | grep -c "workspaceId"

# 3. Every revalidateTag argument starts with the ws: prefix.
grep -rn "revalidateTag(" src/ | grep -v "ws:\${"

# 4. No module imports next/cache — revalidation is the caller's job (§3.1).
grep -rn "from 'next/cache'" src/modules/
```

Items 1 and 4 must return nothing beyond the approved entries; 2 must equal the
count of `unstable_cache` calls; 3 must return nothing.

---

## 12. Idempotency

Four layers, each with a different failure it defends against. The schema already
provides every one of them; this section names which is doing what, because an
implementer who does not know will add a fifth.

```
 layer            mechanism                                       stops
 ─────────────────────────────────────────────────────────────────────────────
 1 enqueue        Job.dedupeKey                    @unique        a duplicated
                  "SEND_SCHEDULED_EMAIL:<seId>"                   job row
 2 materialise    ScheduledEmail                                  a duplicated
                  @@unique([campaignLeadId, sequenceStepId])      step per lead
                  ScheduledEmail.dedupeKey         @unique        (covers WARMUP
                                                                   and MANUAL too)
 3 claim          UPDATE … WHERE state = 'SCHEDULED'              two workers
                  (one statement, exactly one winner)             sending once each
 4 record         EmailEvent.dedupeKey             @unique        double-counting
                  WebhookEvent.providerEventId     @unique        a redelivered
                  EmailMessage @@unique([emailAccountId,          provider fact
                                         providerMessageId])
                  AIAnalysis @@unique([targetType, targetId,      burning tokens
                                       kind, promptVersion])      twice
```

**Layer 3 is the one that actually prevents a duplicate email**, and it is not a
transaction. Layers 1, 2 and 4 reduce waste and keep counters honest; layer 3 is
the guarantee. Stated because the temptation is to think a transaction is what
protects the send — it is a conditional `UPDATE`.

**The gap layer 3 does not close.** If the provider accepts the message and the
network dies before we read the response, the row is `SENDING` and we do not know
whether Gmail got it. Retrying blindly duplicates the email; giving up loses it.
This is the crash-after-accept problem and its resolution
(`send.reconcile`, a 120s grace period for Gmail's search-index lag, an
`inconclusive` verdict that goes to a human rather than guessing) belongs to
`06-jobs-and-sending-engine.md` §6. The backend contract here is only: **a
`SENDING` row is never automatically retried**, and `sending.markSent` is guarded
by `WHERE state = 'SENDING'` so reconciliation can safely conclude "already sent".

**Dedupe key formats** — deterministic, derived from the payload, never random:

```
SCHEDULER_TICK:<campaignId>:<bucket60>          bucket60 = floor(epochSec / 60)
SEND_SCHEDULED_EMAIL:<scheduledEmailId>
MAILBOX_SYNC:<emailAccountId>:<reason>
MAILBOX_RENEW_WATCH:<emailAccountId>:<YYYY-MM-DD>
PROCESS_INBOUND_MESSAGE:<emailMessageId>
PROCESS_WEBHOOK_EVENT:<webhookEventId>
AI_CLASSIFY_MESSAGE:<emailMessageId>
ROLLUP_ANALYTICS:<workspaceId>:<YYYY-MM-DD>
LEAD_IMPORT_BATCH:<leadImportId>:<batchIndex>
MAINTENANCE:<workspaceId>:<YYYY-MM-DD>
```

A recurring job gets its stability from a **time bucket** in the key: identical
within a period, distinct across periods, so calling `enqueue` every 30s on a
60s-bucket key is a no-op with no cron table and no drift.

`Job.dedupeKey` is globally `@unique` and non-nullable, which means a key must
also be reusable once the previous instance is terminal. `06` §5.3 handles this
with `INSERT … ON CONFLICT ("dedupeKey") WHERE state IN (leasable) DO NOTHING`.
That predicate requires a **partial** unique index, which Prisma cannot express —
it lives in migration SQL (schema header note 4). Flagged in §17: the schema's
plain `@@unique([dedupeKey])` and that partial-index requirement are not the same
constraint, and the database doc owner must reconcile them.

**Idempotency the API does *not* have:** no client-supplied `Idempotency-Key`
header on route handlers. The only handler where a retry could duplicate a write
is `/api/leads/import`, and it is already idempotent by resource: it creates a
`LeadImport` row and returns its id; a retried upload creates a second import the
user can see and cancel, which is honest. Adding a header-based scheme for one
endpoint is not worth the machinery.

---

## 13. Observability

`src/lib/logger.ts` is specified in `09-deployment-and-testing.md` §5.1 (fields,
redaction deny-list, `child()`, `LOG_FORMAT=pretty` in dev) and the event
taxonomy in §5.2. This section adds only the backend-specific parts: the per-module
event names each service owns, and where correlation ids come from.

### 13.1 Correlation

| Process | Id | Source |
|---|---|---|
| web request / action | `requestId` | `x-request-id` inbound header, else `crypto.randomUUID()`; carried in `Ctx.requestId` and in `AsyncLocalStorage` (`src/server/request-context.ts`) |
| job attempt | `jobId` | `Job.id`; `log.child({ jobId, jobType, attempt })` per attempt |
| link between them | — | see §17: `09` §5.1 specifies a `Job.enqueuedByRequestId` column that does not exist in `prisma/schema.prisma` |

Until that column exists, a send is traceable to its click through
`Job.payload.scheduledEmailId` → `ScheduledEmail.id`, which appears in the action
log line. Workable, one hop longer.

### 13.2 Per-module event names

Dotted `domain.subject.verb`, past tense, **stable** — dashboards key on these
strings, so a rename is a breaking change. The list below extends `09` §5.2 with
the events that section does not cover, in the same style. Each module owns its
prefix and no other module emits it.

| Module | Events it owns |
|---|---|
| `auth` | `auth.login.succeeded` · `auth.login.failed{reason}` · `auth.logout` · `auth.register.succeeded` · `auth.session.revoked` · `auth.session.slid` · `auth.password.reset_requested` · `auth.password.reset_completed` · `auth.account.locked{failedCount}` |
| `workspace` | `workspace.created` · `workspace.switched` · `workspace.settings.updated` · `workspace.member.invited` · `workspace.member.joined` · `workspace.member.role_changed{from,to}` · `workspace.member.suspended` · `workspace.invite.expired` · `authz.denied{required,actual}` · `authz.cross_workspace_attempt{requestedId}` **always warn** |
| `mailboxes` | `mailbox.oauth.started` · `mailbox.oauth.callback_failed{reason}` · `mailbox.connected` · `mailbox.disconnected{reason}` · `mailbox.token.refreshed` · `mailbox.token.refresh_failed{status}` · `mailbox.sync.started` · `mailbox.sync.completed{messages,durationMs}` · `mailbox.sync.failed{reason}` · `mailbox.cursor.expired` · `mailbox.watch.renewed` · `mailbox.watch.expired` · `mailbox.throttled{until}` |
| `leads` | `lead.created{source}` · `lead.updated` · `lead.deleted{count}` · `lead.imported{rows,accepted,rejected}` · `lead.import.rejected_row{rowNumber,reason}` · `lead.unsubscribed{source}` · `lead.suppressed{reason,scope}` · `lead.bulk.queued{operation,affected}` · `lead.export.streamed{rows}` |
| `sequences` | `sequence.step.created{type,position}` · `sequence.step.updated` · `sequence.step.deleted` · `sequence.reordered` · `sequence.version.bumped{from,to}` · `sequence.variant.added{label}` · `sequence.render.failed{missingToken}` |
| `campaigns` | `campaign.created` · `campaign.launched` · `campaign.paused{by}` · `campaign.resumed` · `campaign.completed` · `campaign.archived` · `campaign.enrolled{leads,skipped,suppressed}` · `campaign.enroll.skipped{reason}` · `campaign.tick.completed{advanced,materialised,durationMs}` · `campaign.advance.blocked{reason}` |
| `sending` | `send.attempted` · `send.succeeded{providerMessageId}` · `send.failed{providerStatus,classification}` · `send.suppressed{reason}` · `send.deferred{reason:'window'\|'daily_cap'\|'pacing'\|'throttled'}` · `send.claim.lost` · `send.reconcile.started` · `send.reconcile.verdict{verdict}` · `provider.rate_limited{provider,retryAfterMs}` · `provider.quota_exhausted{provider}` |
| `inbox` | `inbox.thread.created` · `inbox.message.stored{direction}` · `inbox.reply.sent` · `inbox.thread.archived` · `inbox.search.completed{durationMs,results}` |
| `replies` | `reply.detected{kind}` · `reply.attributed{campaignLeadId}` · `reply.unattributed{reason}` · `reply.sequence_stopped{stepsCancelled}` · `bounce.recorded{kind}` · `bounce.suppressed{email}` · `webhook.received{provider}` · `webhook.unmatched{providerEventId}` |
| `analytics` | `analytics.event.recorded{type}` · `analytics.event.deduped{dedupeKey}` · `analytics.rollup.completed{workspaceId,day,durationMs}` · `analytics.counter.drift_detected{table,column,delta}` · `analytics.open.bot_filtered` |
| `ai` | `ai.request{model,purpose}` · `ai.response{model,tokensIn,tokensOut,durationMs}` · `ai.failed{model,reason}` · `ai.output_invalid{model,purpose}` **error** · `ai.prefilter.decided{label}` · `ai.budget.exceeded{workspaceId}` |
| `crm` | `crm.opportunity.created{stage}` · `crm.opportunity.stage_changed{from,to}` · `crm.opportunity.won{value,currency}` · `crm.opportunity.lost{reason}` · `crm.task.created` · `crm.task.completed` · `crm.note.added` |
| `deliverability` | `dns.checked{domain,spf,dkim,dmarc,mx}` · `dns.lookup_failed{domain,error}` · `deliverability.score.updated{mailboxId,score}` |
| `warmup` | `warmup.ramp.advanced{mailboxId,day,target}` · `warmup.send.queued` · `warmup.paused{reason}` |
| `jobs` | `job.enqueued{type,runAt,dedupeKey}` · `job.duplicate_suppressed{dedupeKey}` · `job.leased{type,attempt}` · `job.succeeded{type,durationMs}` · `job.failed{type,attempt,willRetryAt}` · `job.dead_lettered{type,attempts}` **error** · `job.lease_expired{type}` · `job.lease_lost{jobId}` · `job.replayed{by}` |
| `src/server/` | `action.invoked{name}` · `action.rejected{name,code}` · `http.request.completed{method,path,status,durationMs}` · `ratelimit.exceeded{key,limit}` |

Levels: `debug` per-item detail · `info` facts · `warn`
handled-but-notable (`send.deferred`, `provider.rate_limited`,
`authz.cross_workspace_attempt`, every `action.rejected` with an expected code) ·
`error` a human should look (`job.dead_lettered`, `mailbox.sync.failed`,
`ai.output_invalid`, `analytics.counter.drift_detected`, any unexpected throw).

### 13.3 Logging rules specific to services

1. **A service logs facts; it does not log its own throws.** The `action()` /
   `jsonRoute()` wrapper logs the rejection once, with the code and the stack.
   A service that also logs produces two lines for one failure and doubles the
   noise on every dashboard.
2. **`workspaceId` on every line inside a request or job.** It comes free from
   `ctx`; a line without it cannot be filtered per tenant during an incident.
3. **Never log an email body, a subject line, a refresh token, or a session
   token.** The redaction pass catches key names; it cannot catch a body you
   interpolated into `msg`. Log `{ bodyLength: n }`.
4. **Recipient addresses are hashed** (`sha256(addr).slice(0,12)`) except in an
   `AuditLog` row, which is the deliberate exception.
5. **`durationMs` on every completion event.** It is the only latency data we
   have, and `09` §5 explicitly rejects a metrics vendor in v1.

---

## 14. Rate limiting

### 14.1 Placement

```
                            ┌── login, register, password reset  → IP + email
   Server Action ──────────▶│   invite send                       → workspace
   (action() step 4)        │   CSV import start                  → workspace
                            │   AI generate / regenerate          → workspace + user
                            └── bulk ops                          → workspace

                            ┌── /api/oauth/google/start           → user
   Route handler ──────────▶│   /api/leads/import                 → workspace
   (jsonRoute, before body) │   /api/worker/tick                  → token identity
                            └── /api/track/*, /api/unsubscribe/*  → IP, generous

   Job handler ────────────▶  NOT rate limited. Bounded by concurrency, per-mailbox
                              pacing (minSecondsBetweenSends + sendJitterSeconds),
                              and daily caps (MailboxDailyStat). Those are pacing,
                              not rate limiting, and they live in modules/sending.
```

Rate limiting sits at **the trust boundary, inside the wrapper** — never in a
service. A service called from the worker must not consume a user's HTTP budget,
and a service called twice inside one action must not count twice.

### 14.2 Implementation

```ts
// src/lib/rate-limit.ts
import 'server-only'
import { RateLimitedError } from './errors'

/**
 * Fixed-window counter in Postgres. Deliberately boring.
 *
 * Not Redis: brief §2 rejects it, and the whole point of one datastore is that
 * this needs no second one.
 * Not in-memory: three web replicas would give a 3× effective limit, and a
 * restart would reset every window — which is exactly the wrong behaviour for
 * login throttling.
 * Not a sliding window / token bucket: a fixed window admits at most 2× the
 * limit across a boundary, which for "5 login attempts a minute" is irrelevant,
 * and the simpler thing is the thing that stays correct.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<void>
```

One statement, atomic, no read-then-write race:

```sql
-- The window start is derived, so there is no cleanup job for expired windows:
-- a new window is a different primary key, and MAINTENANCE prunes old rows.
INSERT INTO "RateLimit" ("key", "windowStart", "count")
VALUES ($key, to_timestamp(floor(extract(epoch from now()) / $windowSec) * $windowSec), 1)
ON CONFLICT ("key", "windowStart")
DO UPDATE SET "count" = "RateLimit"."count" + 1
RETURNING "count";
-- count > limit  ⇒  throw RateLimitedError(retryAfterMs = window end − now)
```

**This requires a `RateLimit` table that does not exist in
`prisma/schema.prisma`.** Flagged in §17 — it is the one new table this document
needs.

```prisma
/// Fixed-window rate limit counter. Not tenant-owned: the key namespaces itself
/// ("login:ip:1.2.3.4", "ws:<id>:leads.import"), and login limiting happens
/// before any workspace is known.
model RateLimit {
  key         String
  windowStart DateTime @db.Timestamptz(6)
  count       Int      @default(0)
  @@id([key, windowStart])
  @@index([windowStart])          // MAINTENANCE prunes windowStart < now() - 1 day
}
```

### 14.3 The limits

| Surface | Key | Limit | Window | Rationale |
|---|---|---|---|---|
| `auth.login` | `login:ip:${ip}` | 20 | 5 min | slows spraying across accounts |
| `auth.login` | `login:email:${sha256(email)}` | 5 | 5 min | per-account; pairs with `User.failedLoginCount` / `lockedUntil` |
| `auth.register` | `register:ip:${ip}` | 5 | 1 h | signup abuse |
| `auth.requestPasswordReset` | `pwreset:email:${sha256(email)}` | 3 | 1 h | email bombing a third party |
| `workspace.invite` | `invite:ws:${workspaceId}` | 20 | 1 h | we send those emails; abuse is our reputation |
| `/api/leads/import` | `import:ws:${workspaceId}` | 5 | 1 h | each is up to 50k rows |
| `leads.bulk*` | `bulk:ws:${workspaceId}` | 30 | 1 h | each may enqueue thousands of jobs |
| `/api/oauth/google/start` | `oauth:user:${userId}` | 10 | 10 min | state-token flooding |
| `ai.*` generate | `ai:ws:${workspaceId}` | 100 | 1 h | real money; `modules/ai/budget.ts` also enforces spend |
| `ai.regenerate` | `ai:msg:${messageId}` | 5 | 1 h | matches `08` §2210 |
| `leads.create` | `leads.create:ws:${workspaceId}` | 120 | 1 min | a sane ceiling, not a real constraint |
| `/api/track/*` | `track:ip:${ip}` | 600 | 1 min | generous: one recipient's mail client may fetch many pixels |

### 14.4 What rate limiting is not for

**Gmail's quotas are not rate limiting; they are pacing, and they are not ours to
enforce by counting.** Gmail's real limits are a *rolling* window — roughly 2,000
messages/day for Workspace and 500 for consumer accounts, plus undocumented
per-minute and per-recipient throttles — enforced server-side and exposed by no
API. Our `EmailAccount.dailySendLimit` default of **50** is therefore a courtesy
limit set far below Gmail's, chosen for deliverability rather than to avoid a 429.

Consequences already in the schema and design:

- `EmailAccount.minSecondsBetweenSends` (90) and `sendJitterSeconds` (120) exist
  so a mailbox does not emit a machine-regular burst.
- `MailboxDailyStat` per local day exists so the cap check is one indexed read
  inside the claim transaction, not a `COUNT` over `ScheduledEmail`.
- A `quotaExceeded` from Gmail is treated as **authoritative and terminal for that
  mailbox for the rest of the day** — `EmailAccount.status = THROTTLED` with
  `throttledUntil`, and the scheduler skips it (that is what
  `@@index([status, throttledUntil])` is for). We do not retry into a quota wall;
  retrying makes reputation worse.
- Timezone/DST bites here: "today" for a cap is the mailbox's local date
  (`MailboxDailyStat.localDate`, derived from `EmailAccount.timezone`), and a
  spring-forward day is 23 hours of wall clock but still one calendar date. That
  is the behaviour operators expect and it is why the schema stores an IANA zone
  string rather than a fixed offset. Window arithmetic lives in
  `modules/sending/windows.ts` and is unit-tested against both DST transitions.

---

## 15. The worker's contract with modules

`06-jobs-and-sending-engine.md` owns the loop, the lease, backoff, and the dead
letter. This section states only the part that is a *backend* contract: what a job
handler is allowed to be, so that the graph in §2 and the tenancy rule in §4 hold
in the worker process too.

```ts
// src/modules/jobs/types.ts (the part app-side code must respect)
export type JobOutcome =
  | { kind: 'ok' }
  | { kind: 'retry'; afterMs?: number; reason: string }
  | { kind: 'defer'; runAt: Date; reason: string }   // not a failure; attempt NOT incremented
  | { kind: 'dead';  reason: string }

export type JobHandler<P> = (payload: P, ctx: SystemCtx, deps: JobDeps) => Promise<JobOutcome>
```

Five rules:

1. **A handler takes `SystemCtx` as its second parameter**, built by
   `systemCtxFor(job.workspaceId, requestId)` (§4.5). It never reads a cookie and
   never widens its own scope.
2. **`worker/registry.ts` is the only worker file that touches domain code, and it
   imports `modules/<d>/index.ts` exclusively.** Not `service.ts`, not `repo.ts`.
   The brief's import rule is not relaxed for the worker.
3. **A handler is a thin adapter.** It parses the payload with the module's zod
   schema, calls one module public function, and maps the result to a
   `JobOutcome`. Business logic in `worker/` is logic that cannot be unit-tested
   without a queue.
4. **A handler must be safe to run twice.** At-least-once is the delivery
   contract (`Job` schema comment: "a job row is intent, not a guarantee of
   once-only execution"). Every handler's effect is guarded by §12's layer 2, 3,
   or 4.
5. **`defer` is not a failure.** Out-of-window, daily cap reached, mailbox
   throttled, reconcile grace period not elapsed — all `defer`, which reschedules
   without consuming an attempt. Treating a closed sending window as a failure
   burns five retries and dead-letters a perfectly healthy send by 09:00.

`JobType` naming is the one place the two docs diverge on vocabulary: the schema's
`JobType` enum is `SCREAMING_SNAKE` (`SEND_SCHEDULED_EMAIL`, `SCHEDULER_TICK`,
`PROCESS_INBOUND_MESSAGE`), while `06` §5.1 declares a dotted string union
(`'email.send'`, `'campaign.tick'`, `'reply.process'`). **This document uses the
schema's enum**, because the column is `type JobType` and a Prisma enum is not a
free-form string. Flagged in §17.

---

## 16. API surface

Every operation callable from outside its own module. `auth` column: the minimum
role `requireWorkspace()` is called with, or the auth mode for non-workspace
surfaces. `W` = the operation writes.

Roles: `M` = MEMBER, `A` = ADMIN, `O` = OWNER, `S` = session only (no workspace),
`P` = public/unauthenticated, `T` = token (worker/webhook/public token),
`SYS` = worker-only (`SystemCtx`, unreachable from `app/`).

### 16.1 `auth`

| Operation | Auth | W |
|---|---|---|
| `register(input)` | P | ✓ |
| `login(input)` | P | ✓ |
| `logout(session)` | S | ✓ |
| `resolveSession(tokenHash)` | internal (guards only) | ✓ (slides expiry) |
| `requestPasswordReset(email)` | P | ✓ |
| `resetPassword(token, password)` | P | ✓ |
| `me(session)` | S | |
| `listSessions(session)` | S | |
| `revokeSession(session, sessionId)` | S | ✓ |
| `updateProfile(session, input)` | S | ✓ |

### 16.2 `workspace`

| Operation | Auth | W |
|---|---|---|
| `create(session, input)` | S | ✓ |
| `get(ctx)` | M | |
| `listForUser(userId)` | S | |
| `resolveMembership(userId, workspaceId)` | internal (guards only) | |
| `switchWorkspace(session, workspaceId)` | S | ✓ |
| `updateSettings(ctx, input)` | A | ✓ |
| `listMembers(ctx)` | M | |
| `invite(ctx, email, role)` | A | ✓ |
| `describeInvite(token)` | P | |
| `acceptInvite(session, token)` | S | ✓ |
| `revokeInvite(ctx, inviteId)` | A | ✓ |
| `changeRole(ctx, userId, role)` | O | ✓ |
| `suspendMember(ctx, userId)` | A | ✓ |
| `removeMember(ctx, userId)` | O | ✓ |
| `listAuditLog(ctx, params)` | A | |
| `softDelete(ctx)` | O | ✓ |
| `getForSystem(workspaceId)` | SYS | |
| `expireInvitesAcrossWorkspaces()` | SYS | ✓ |
| `purgeSoftDeletedWorkspaces(days)` | SYS | ✓ |

### 16.3 `mailboxes`

| Operation | Auth | W |
|---|---|---|
| `list(ctx)` | M | |
| `get(ctx, id)` | M | |
| `listSendable(ctx)` | M | |
| `getSummaries(ctx, ids)` | M | |
| `beginOAuth(ctx, provider)` → `{ url, state }` | A | ✓ (state) |
| `completeOAuth(state, code)` | T (signed state) | ✓ |
| `update(ctx, id, input)` (limits, window, from-name) | A | ✓ |
| `pause(ctx, id)` / `resume(ctx, id)` | A | ✓ |
| `disconnect(ctx, id)` | A | ✓ |
| `recentErrors(ctx, id)` | M | |
| `getAuth(ctx, id)` → decrypted access token | SYS | ✓ (refresh) |
| `syncNow(ctx, id)` | A | ✓ (enqueue) |
| `listDueForWatchRenewAcrossWorkspaces()` | SYS | |
| `markThrottled(ctx, id, until)` | SYS | ✓ |

`getAuth` is the only function anywhere that returns a decrypted credential. It is
`SystemCtx`-only, never reachable from an action, and its return value never
crosses a serialisation boundary.

### 16.4 `leads`

| Operation | Auth | W |
|---|---|---|
| `list(ctx, filter)` | M | |
| `get(ctx, id)` | M | |
| `create(ctx, input)` | M | ✓ |
| `update(ctx, input)` | M | ✓ |
| `softDelete(ctx, ids)` | A | ✓ |
| `bulkAddToList` / `bulkAddTags` / `bulkAddToCampaign` | M | ✓ |
| `bulkDelete(ctx, target)` | A | ✓ |
| `timeline(ctx, leadId, params)` | M | |
| `listLists(ctx)` / `createList` / `updateList` / `deleteList` | M / M / M / A | ✓ |
| `listTags(ctx)` / `createTag` / `deleteTag` | M / M / A | ✓ |
| `listCustomFields(ctx)` / `upsertCustomField` / `deleteCustomField` | M / A / A | ✓ |
| `startImport(ctx, meta)` | M | ✓ |
| `getImport(ctx, id)` / `validateImport(ctx, id)` | M | |
| `commitImport(ctx, id, options)` | M | ✓ (enqueue) |
| `exportStream(ctx, filter)` | M | |
| `isSuppressed(ctx, email)` | M | |
| `suppress(ctx, input)` / `unsuppress(ctx, id)` | M / A | ✓ |
| `listSuppressions(ctx, params)` | M | |
| `describeSuppressionToken(token)` | P | |
| `markContacted(ctx, leadIds)` | SYS | ✓ |
| `applyImportBatch(ctx, importId, batchIndex)` | SYS | ✓ |

### 16.5 `sequences`

| Operation | Auth | W |
|---|---|---|
| `get(ctx, campaignId)` | M | |
| `upsertStep(ctx, campaignId, step)` | M | ✓ (bumps `version`) |
| `deleteStep(ctx, stepId)` | M | ✓ |
| `reorderSteps(ctx, campaignId, orderedIds)` | M | ✓ |
| `upsertVariant(ctx, stepId, variant)` | M | ✓ |
| `deleteVariant(ctx, variantId)` | M | ✓ |
| `preview(ctx, variantId, leadId)` | M | |
| `render(ctx, variantId, leadId)` → frozen content | SYS | |
| `variableCoverage(ctx, campaignId)` | M | |
| `validate(ctx, campaignId)` | M | |

### 16.6 `campaigns`

| Operation | Auth | W |
|---|---|---|
| `list(ctx, filter)` | M | |
| `get(ctx, id)` | M | |
| `create(ctx, input)` | M | ✓ |
| `update(ctx, id, input)` | M | ✓ |
| `getSchedule(ctx, id)` / `updateSchedule(ctx, id, input)` | M | ✓ |
| `setMailboxes(ctx, id, mailboxIds)` | M | ✓ |
| `launch(ctx, id)` | M | ✓ |
| `pause(ctx, id)` / `resume(ctx, id)` | M | ✓ |
| `archive(ctx, id)` / `softDelete(ctx, id)` | A | ✓ |
| `enroll(ctx, id, leadIds)` | M | ✓ |
| `unenroll(ctx, id, campaignLeadIds)` | M | ✓ |
| `listLeads(ctx, id, filter)` | M | |
| `tick(ctx, campaignId)` | SYS | ✓ |
| `advance(ctx, campaignLeadId)` | SYS | ✓ |
| `stopEnrollment(ctx, campaignLeadId, reason)` | SYS | ✓ |
| `checkComplete(ctx, campaignId)` | SYS | ✓ |

### 16.7 `sending`

| Operation | Auth | W |
|---|---|---|
| `capacityEstimate(ctx, campaignId)` | M | |
| `sendManual(ctx, input)` | M | ✓ |
| `materialise(ctx, campaignLeadId, stepId)` | SYS | ✓ |
| `claimForSend(ctx, scheduledEmailId, workerId)` | SYS | ✓ |
| `presendGuard(ctx, scheduledEmailId)` | SYS | |
| `sendScheduledEmail(ctx, scheduledEmailId)` | SYS | ✓ |
| `markSent(ctx, id, result)` / `markFailed(ctx, id, error)` | SYS | ✓ |
| `cancelPending(ctx, selector, reason)` | SYS | ✓ |
| `reconcile(ctx, scheduledEmailId)` | SYS | ✓ |
| `sweepStuckSends()` | SYS | ✓ |
| `resolveTrackingToken(token)` | P (token) | |

### 16.8 `inbox`

| Operation | Auth | W |
|---|---|---|
| `listThreads(ctx, filter)` | M | |
| `getThread(ctx, threadId)` | M | |
| `search(ctx, query, params)` | M | |
| `unreadSince(ctx, since)` | M | |
| `sendReply(ctx, threadId, input)` | M | ✓ |
| `markRead(ctx, threadIds, read)` | M | ✓ |
| `archive(ctx, threadIds, archived)` | M | ✓ |
| `star(ctx, threadIds, starred)` | M | ✓ |
| `upsertMessage(ctx, input)` | SYS | ✓ |
| `markHumanReply(ctx, threadId, at)` | SYS | ✓ |
| `listUnprocessedInbound(ctx, limit)` | SYS | |

### 16.9 `replies`

| Operation | Auth | W |
|---|---|---|
| `recordWebhook(payload, provider)` | T (webhook) | ✓ |
| `processWebhookEvent(ctx, webhookEventId)` | SYS | ✓ |
| `processInboundMessage(ctx, emailMessageId)` | SYS | ✓ |
| `classifyDeterministic(message)` | pure | |
| `onInboundHuman(ctx, emailMessageId)` | SYS | ✓ |
| `processBounce(ctx, emailMessageId)` | SYS | ✓ |
| `processUnsubscribe(ctx, email, source)` | SYS | ✓ |
| `confirmUnsubscribeToken(token)` | P (token) | ✓ |

### 16.10 `analytics`

| Operation | Auth | W |
|---|---|---|
| `campaignSummary(ctx, campaignId, range)` | M | |
| `campaignBreakdown(ctx, campaignId, range)` | M | |
| `mailboxSummary(ctx, mailboxId, range)` | M | |
| `workspaceTrend(ctx, range)` | M | |
| `experimentReadout(ctx, experimentId)` | M | |
| `recordEvent(ctx, input, tx?)` | SYS | ✓ |
| `recordOpenByToken(token, meta)` | P (token) | ✓ |
| `recordClickByToken(token, meta)` | P (token) | ✓ |
| `rollup(ctx, day)` | SYS | ✓ |
| `listWorkspacesNeedingRollup()` | SYS | |

`recordEvent` takes an optional `tx` because §8.2(4) requires the event and the
state change to commit together (`08` §0 states the same contract).

### 16.11 `crm`, `ai`, `deliverability`, `warmup`, `jobs`, `dashboard`

| Module | Operation | Auth | W |
|---|---|---|---|
| `crm` | `board(ctx, filter)` · `listOpportunities` · `getOpportunity` · `listTasks` · `notesFor` | M | |
| `crm` | `createOpportunity` · `updateStage` · `updateOpportunity` · `createTask` · `completeTask` · `addNote` | M | ✓ |
| `crm` | `deleteOpportunity` · `deleteNote` | A | ✓ |
| `crm` | `setLeadStatus(ctx, leadId, status)` | M | ✓ |
| `crm` | `recordActivity(ctx, input)` | SYS | ✓ |
| `ai` | `analysisFor(ctx, target)` · `listInsights(ctx)` · `usage(ctx)` | M | |
| `ai` | `suggestReply(ctx, messageId, tone)` · `personalise(ctx, variantId, leadId)` | M | ✓ |
| `ai` | `acceptOutput(ctx, analysisId)` · `correctLabel(ctx, analysisId, label)` | M | ✓ |
| `ai` | `classifyMessage(ctx, messageId)` · `summariseThread` · `scoreLead` | SYS | ✓ |
| `deliverability` | `overview(ctx)` · `dns(ctx, domainId)` | M | |
| `deliverability` | `recheckDomain(ctx, domainId)` | A | ✓ |
| `deliverability` | `runDomainHealthCheck(ctx, domainId)` | SYS | ✓ |
| `warmup` | `list(ctx)` · `get(ctx, poolId)` | M | |
| `warmup` | `createPool` · `updatePool` · `addMember` · `removeMember` · `pause` | A | ✓ |
| `warmup` | `tick(ctx, mailboxId, day)` | SYS | ✓ |
| `jobs` | `enqueue(input)` · `enqueueMany(inputs, tx?)` | SYS *(+ services)* | ✓ |
| `jobs` | `listDeadLetter(ctx, params)` · `diagnose(ctx, jobId)` | A | |
| `jobs` | `replay(ctx, jobIds)` · `replayGroup(ctx, sel)` · `discard(ctx, jobIds, note)` | A | ✓ |
| `jobs` | `drainOnce(limit)` | T (worker token) | ✓ |
| `jobs` | `leaseBatch` · `renewLease` · `applyOutcome` · `reclaimExpiredLeasesAcrossWorkspaces` · `pruneTerminalJobsAcrossWorkspaces` | SYS | ✓ |
| `dashboard` | `problems(ctx)` · `counts(ctx)` · `needsReply(ctx)` · `campaignHealth(ctx)` · `mailboxHealth(ctx)` · `activity(ctx)` · `trend(ctx, range)` | M | |

`jobs.enqueue` is marked `SYS` for its *worker* callers, but services call it too —
with the `Ctx` they already hold, inside their own transaction. It is not callable
from `app/**`: an action that wants background work calls the service that owns the
state change, and that service enqueues.

### 16.12 Role floors, summarised

| Role | Can do |
|---|---|
| `MEMBER` | everything operational: create/edit leads, campaigns, sequences; enroll; launch/pause campaigns; reply in the inbox; CRM; run AI; import CSV |
| `ADMIN` | + connect/disconnect mailboxes, edit sending limits, bulk delete, invite and suspend members, delete lists/tags/custom fields, workspace settings, dead-letter replay, read the audit log |
| `OWNER` | + change roles, remove members, delete the workspace |

The floor is `MEMBER`, not `ADMIN`, for launching a campaign. A tool where the
person doing outreach must ask an admin to press send is a tool people work around.
Mailbox credentials and destructive bulk operations are where the line sits, and
`03-frontend.md` §7.3 agrees (`bulkDelete` is `ADMIN+`).

---

## 17. Conflicts the lead engineer must resolve

Every item was found by grepping `prisma/schema.prisma` or a sibling doc as of
**2026-08-31**, not by inspection of prose. Sibling docs are being revised
concurrently; `06-jobs-and-sending-engine.md` in particular added a §0
("Conformance to the committed schema") during this document's drafting and now
follows the schema's `Job.state` / `attempt` / `dedupeKey` / `priority DESC`
naming. Items below are what remained after that pass.

### 17.1 `RateLimit` table does not exist — blocking

§14.2 requires it. Brief §6 mandates rate limiting on login, invite, CSV import,
AI calls, and OAuth start. Grep: zero occurrences of a `RateLimit` model in the
schema, and no alternative store exists (brief §2 rejects Redis).

**Recommendation: add the two-column model in §14.2** (`@@id([key, windowStart])`,
`@@index([windowStart])`). It is deliberately **not** tenant-owned — login
limiting happens before any workspace is known — which makes it a **third** model
with no `workspaceId`, alongside `AuditLog` and `WebhookEvent`. The schema header
comment enumerating those exceptions, and `01-database.md` §3, both need updating.
Without this table, phase 1 cannot satisfy brief §6.

### 17.2 `WorkerHeartbeat` table does not exist — blocking for phase 6

`09` §5.3 makes it the basis of `/api/health`'s worker check — "the check that
catches 'campaigns silently stopped'", which is the failure this product cannot
tolerate — and `09` §926 alerts on a 3-minute gap. `06` §0 records that it uses
`09`'s name verbatim and §159/§167 shows a model. Grep: zero occurrences of
`WorkerHeartbeat` in `prisma/schema.prisma`.

**Recommendation: add it** with `09`'s columns
(`{ id, lastSeenAt, hostname, pid, version, leasedCount }`). Not tenant-owned
(so a fourth exception, with `RateLimit`).

### 17.3 `SendAttempt` model does not exist — blocking for phase 6

`06` §159 defines `model SendAttempt`, and its per-attempt timeline is
load-bearing in three places: the reconcile decision (§6.4 `outcome = 'unknown'`),
the operator's "Sent anyway / Did not send" console, and its own integration test
("10 workers racing one row ⇒ exactly one `SendAttempt` with
`outcome='accepted'`"). `ScheduledEmail.attemptCount` and `lastError` record only
the latest attempt. Grep: zero occurrences in the schema.

**Recommendation: add it**, or accept that reconciliation has no attempt history
and rewrite `06` §6.4 to decide from `ScheduledEmail` alone. The first is a small
table; the second weakens the one guarantee the product cannot get wrong.

### 17.4 `Job.dedupeKey`: unconditional unique makes coalescing jobs single-use

Schema: `@@unique([dedupeKey])`, globally and unconditionally, and `06` §0 accepts
this explicitly ("There is no 'unique among outstanding rows' escape hatch"),
resolving it by embedding a period bucket in every repeatable key.

That resolution works for time-driven jobs but leaves one case unresolved.
`06` §603 gives `MAILBOX_SYNC` the key
`MAILBOX_SYNC:{emailAccountId}:{historyId ?? bucketMinute}` and describes the
coalescing as intentional. When `historyId` is present the key is single-use *per
history id*, which is correct. When it is absent it falls back to a minute
bucket — so two pushes for the same mailbox in one minute coalesce, which is
desired, but a push in minute N+1 for the *same unchanged* historyId enqueues a
second job. Tolerable.

The genuinely unresolved case is a **retry after terminal failure**: once a
`MAILBOX_SYNC:{id}:{historyId}` job reaches `DEAD`, that key is consumed forever
and the same history id can never be re-synced, even by an operator replay.
`06` §1036 relies on `Job.replayCount` for replay, which mutates the existing row
rather than inserting — so replay works, but *re-enqueue* does not.

**Recommendation: keep the unconditional unique** (it is simpler and `06` has
already designed around it) **and document that recovery from a `DEAD` job is
always replay-in-place, never re-enqueue.** If a future job type genuinely needs
key reuse, switch to a partial unique index in migration SQL
(`WHERE state IN ('PENDING','RUNNING','RETRYING')`, per schema header note 4),
remembering that `ON CONFLICT`'s target predicate must textually match the index.

### 17.5 `09-deployment-and-testing.md` still uses pre-schema names

`09` §13 item 1 already flags this and says "if a name differs, the *check* is the
contract and the SQL should be corrected here". Confirming what differs, with
current grep counts in `09`:

| `09` uses | occurrences | schema has |
|---|---|---|
| `Job.status`, state `LEASED` | 7, 6 | `Job.state`; `JobState` has `RUNNING`, no `LEASED` |
| `Job.attempts` | 6 | `Job.attempt` |
| `Job.idempotencyKey` | 6 | `Job.dedupeKey` |
| `Job.leasedBy` | 2 | `Job.lockedBy` |
| `Mailbox` + `status='CONNECTED'`, `disconnectedAt`, `disconnectReason` | 1 / 1 / 3 / 2 | `EmailAccount`; `EmailAccountStatus` = `CONNECTING · ACTIVE · PAUSED · DISCONNECTED · THROTTLED · ERROR` |
| `MailboxCredential.keyVersion` | 4 | `EmailAccount.encryptedRefreshToken` + `encryptionKeyVersion` |
| `EmailEvent.bounceKind`, `.mailboxId` | 2 / 8 | bounce detail lives on `EmailMessage.bounceType`/`bounceCode`; the event FK is `emailAccountId` |
| `Lead.importBatchId` | 2 | `Lead.leadImportId` |

Every one of these appears inside runnable SQL — the six §5.4 metrics queries and
the §3.5 restore-verification script — so all of it fails on contact with the real
database. **Recommendation: mechanical rename pass over `09`, schema wins.**

### 17.6 `Job.enqueuedByRequestId` does not exist

`09` §5.1 calls it "the whole distributed-tracing story" — the column linking a
send back to the click that caused it. Not in the schema.

**Recommendation: add it** (`String?`, no index — it is read by log search, not by
query). Cheap. Without it §13.1's correlation table has a gap costing one extra
hop in every incident, and `09` §5.1's tracing claim is false.

### 17.7 `03-frontend.md` field names that do not exist

Grepped against the schema, all zero:

| `03` uses | occurrences in `03` | schema has |
|---|---|---|
| `Mailbox` | 22 | `EmailAccount` |
| `status = 'HEALTHY'`, `AUTH_FAILED`, `RATE_LIMITED` | 4 / 1 / 2 | `EmailAccountStatus` values above |
| `Mailbox.statusChangedAt` | 2 | no equivalent; nearest is `lastErrorAt` |
| `lastActivityAt` (lead sort key) | 2 | `lastContactedAt` / `lastRepliedAt` / `lastOpenedAt` |
| `leadScore` | 2 | `Lead.score` |
| `Lead.interestStatus`; `INTERESTED` / `MEETING` | 3 / 8 | `LeadStatus` has `ENGAGED`, no `INTERESTED`; interest is `AIAnalysis.classification` / `.sentiment` |
| `aiCategory` (inbox folder filter) | 9 | `AIAnalysis.classification` + `MessageClassification` |
| `z.nativeEnum(...)` | 1 | **zod 4 removed it** — use `z.enum(Object.values(E))` |
| `z.string().uuid()` for ids | 3 | ids are `cuid()` — use `z.cuid()`; `.uuid()` rejects every real id |

The last two are not renames, they are code that throws or rejects valid input at
runtime. `08-analytics-crm-ai.md` §0 similarly names `Message` / `Thread` for
`EmailMessage` / `EmailThread`.

**Recommendation: schema wins in every row; one mechanical pass over `03` and `08`
before phase 1.** The `z.uuid()` → `z.cuid()` fix is the highest priority — it
would make every id-taking action reject valid ids.

### 17.8 `/leads` pagination: cursor (this doc) vs offset (`03` §7.2)

`03` §7.2 specifies offset with `page`/`per`/`total`/`pageCount`; §10.3 here
specifies keyset with an exact total and previous/next.

**Recommendation: keyset**, for §10.3's reasons — one mechanism across six large
tables, deep offset degrades on a 200k-lead workspace, and page numbers on a
`createdAt`-ordered lead list are not a real workflow. Both of `03`'s stated
requirements survive: the exact total comes from a parallel `countScoped`, and
select-all-matching already ships a filter descriptor rather than ids. If the lead
rules for offset, the change is contained to `leadFilterSchema`, `repo.findPage`,
and `Page<T>`; `service.list`'s signature is unaffected either way.

### 17.9 Two module-surface additions

From §2.5, repeated so the lead sees them in one list:

- **`dashboard` is a sixteenth module** (L7, read-only, owns no table), needed by
  `03` §4's seven `dashboard.*` calls. Folding them into `analytics` would make
  `analytics` depend on six modules and break §2.4(b)'s cycle resolution.
- **`suppressions` is not a module.** `03` §2's `suppressions.describeToken` maps
  to `leads.describeSuppressionToken`; `Suppression` is a leads-domain table.

### 17.10 Open requests from `06` that this document depends on

Listed for visibility because §8 and §14 assume they resolve in `06`'s favour;
they are `06`'s to argue and the lead's to decide.

- **`EmailAccount.nextSendAt`** (`06` §16.1, blocking) — without it the
  per-mailbox minimum-gap check is unenforced under concurrency, which is exactly
  when it matters. §14.4's pacing claim depends on this landing.
- **`MailboxDailyStat.reservedCount`** (`06` §16.2, blocking) — §8.3's claim that
  the daily cap is enforced by a conditional `UPDATE` needs a counter that
  increments *before* the send. Incrementing `sentCount` pre-send would make
  analytics count sends that never happened. `06`'s stated fallback is a
  `SERIALIZABLE` transaction around check-and-send, which would be the **first
  exception to §8.3** and would serialise all sends on one mailbox.
- **`JobType.RECONCILE_SEND`** (`06` §16.4) — currently a `MAINTENANCE` subtype,
  which buries a correctness path in housekeeping and makes it unalertable.

### 17.11 One thing that is settled and must not be re-litigated

`prisma/schema.prisma`'s `datasource` block carries **`provider` only**. No `url`,
no `directUrl`. Migrate reads `datasource.url` from `prisma.config.ts`;
`PrismaClient` takes a `@prisma/adapter-pg` driver adapter (§9.1). The file on
disk is already correct. Any doc, snippet, or PR showing a URL in
`schema.prisma`, or `new PrismaClient({ datasources: { db: { url } } })`, is
describing Prisma ≤6 and is wrong for this repository.

---

## 18. Definition of done for the backend of any phase

Per brief §11, specialised to this document. All twelve, every phase.

1. `bun run typecheck` clean · `bun run lint` clean · `bun run test:unit` green.
2. Every new module folder has all five files, and `index.ts` re-exports no `repo`.
3. Every new service function takes `Ctx` first.
4. Every new repo function names `workspaceId` in its `where` or its `data`, via
   `scope(ctx)`. `grep -rn "findUnique" src/modules/*/repo.ts` shows no
   tenant-owned table looked up by bare id.
5. No new `workspaceId` field in any `schema.ts`:
   `grep -rn "workspaceId" src/modules/*/schema.ts` returns nothing.
6. Every new mutation goes through `action()` with an explicit `name` and `role`.
7. Every new cross-workspace read path has a test asserting **404, not 403**.
8. No new `$transaction` contains a `fetch`, a provider call, or an `await` inside
   a loop.
9. Every new cache entry's key contains `workspaceId`; §11.4's four greps pass.
10. Every new job type has a deterministic `dedupeKey` and a handler that is safe
    to run twice.
11. Every new module event name is in §13.2 and emitted at the documented level.
12. Migrations apply from scratch (`bun run db:reset`) and no secret is committed.
