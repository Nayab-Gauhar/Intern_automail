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
> **Out of scope, and who owns it instead.** The schema (`01-database.md`); the
> queue, sending engine, and their event names (`06`); sessions, `Ctx` derivation,
> the capability matrix, validation, rate limiting, CSRF (`07`); the route tree and
> components (`03`); analytics/CRM/AI internals (`08`); deploy topology, the logger,
> and the observability taxonomy (`09`). Where those docs own a mechanism, this one
> **references and defers** rather than restating — §4, §5, §6, §11 and §14 each open
> with an ownership note naming what is theirs and what is this document's, and §13
> attributes the logger and event names inline.
>
> **Verified against the live tree.** `src/lib/{db,errors,result,logger,env}.ts` and
> `src/server/authz.ts` are already on disk; the code shown in §6 and §9 is what is
> implemented, not a proposal. The five-file `leads` module in §3.3 was extracted to
> `src/modules/leads/`, compiled clean with `tsc --noEmit` against those files and a
> Prisma client generated from the live schema (TypeScript 6.0.3, Prisma 7.10.0,
> zod 4.5.4), then removed. Every model, field, and enum value cited was grepped
> against `prisma/schema.prisma`.

---

## 0. The ten rules this document exists to enforce

Restated because every section is an application of one of them.

1. **`workspaceId` comes from the session, never from the caller.** Every action
   schema is `.strict()`, so a `workspaceId` in a form field, JSON body, or search
   param is a *validation failure* and is logged as
   `authz.cross_workspace_attempt` (`07` §9.2).
2. **Every service entrypoint takes `Ctx` as its first parameter.** No
   exceptions, including read-only functions and job handlers.
3. **Prisma is importable only from `src/modules/*/repo.ts`, `src/lib/db.ts`,
   and `prisma/`.** Enforced by `no-restricted-imports` in `eslint.config.mjs`.
4. **Cross-workspace access returns 404, never 403.** 403 confirms the resource
   exists in someone else's workspace.
5. **Modules never import `src/server/**`, except `server/authz.ts`.** Guards and
   the action wrapper sit *above* modules; the capability matrix is the one thing a
   service must reach upward for, and it touches no data (§4.2). This rule is what
   keeps the graph acyclic (§2.4).
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
│  src/server/**         SERVER-ONLY EDGE   (file list owned by 07 §2)    │  ← may import
│    session.ts          cookie ⇄ Session row, sliding refresh            │     modules/*/index + lib
│    ctx.ts              Ctx type · requireWorkspace · workspace switch   │
│    authz.ts            Capability · MATRIX · can() · requireCan()       │
│    action.ts           the one Server Action wrapper                    │
│    route.ts            the route-handler wrapper (§7.3)                 │
│    origin.ts           assertSameOrigin() for route handlers            │
│    audit.ts            writeAudit()                                     │
│    request-context.ts  AsyncLocalStorage { requestId, workspaceId }     │
│    system-ctx.ts       Ctx from Job.workspaceId, for the worker (§4.4)  │
├─────────────────────────────────────────────────────────────────────────┤
│  src/modules/<domain>/ DOMAIN LOGIC — index · service · repo ·          │  ← may import
│                        schema · types (+ pure helpers)                  │     other modules'
│                                                                          │     index.ts + lib
├─────────────────────────────────────────────────────────────────────────┤
│  src/lib/**            env · db · errors · result · logger · crypto ·   │  ← imports nothing
│                        tokens · password · rate-limit · time · cn       │     of ours
│                        (on disk today: db, env, errors, result,         │
│                         logger, crypto, tokens, cn)                     │
└─────────────────────────────────────────────────────────────────────────┘

worker/                  index · loop · maintenance · registry
                         imports modules/*/index.ts ONLY — never server/**,
                         never a service.ts, never a repo.ts
```

`src/lib/**` is a leaf by construction: no file in it imports from `modules/`,
`server/`, or `app/`. `src/lib/db.ts` is the only member that opens a socket.
`src/server/authz.ts` is the one file in the edge layer that modules may import
(§4.2) — it reads no table, so for graph purposes it sits with `lib/`.

### 1.1 Why `server/` is above `modules/` and not beside it

`requireWorkspace()` must read a `WorkspaceMember` row, which is `workspace`'s
table. So `server/ctx.ts` → `modules/workspace`. If any module were allowed to
import `server/ctx.ts` to "get the current workspace", we would have
`workspace → ctx → workspace`. Instead:

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
have no home in that list. Both are resolved here and flagged in §17.10.

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
| `service.ts` | `./repo`, `./schema`, `./types`, `@/lib/*`, `@/server/authz`, other modules' `index.ts` | raw SQL, Prisma model calls | `@prisma/client` for **queries** (types are fine), any other `@/server/*`, `next/*` |
| `repo.ts` | `@/lib/db`, `@prisma/client`, `./types`, the `Ctx` **type** | business rules, user-facing error messages, cross-domain reads | other modules, `@/server/authz`, `next/*` |
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
optional `database: Db = db` parameter is how a service enlists the repo in an
interactive transaction without the repo knowing about transactions.

```ts
// src/modules/leads/repo.ts
import 'server-only'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import type { Ctx } from '@/server/ctx'
import type { LeadFilter } from './schema'
import type { LeadSummary } from './types'

/** `Db` lets every function run standalone or enlisted in a caller's transaction. */
type Db = typeof db | Prisma.TransactionClient

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
  database: Db = db,
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
  return database.lead.findMany({
    where: { AND: [scope(ctx, f), ...keyed] },
    select: SUMMARY_SELECT,
    orderBy: [{ [f.sort]: f.dir }, { id: f.dir }],
    take: f.limit + 1,
  })
}

export async function findByIdInWorkspace(ctx: Ctx, leadId: string, database: Db = db) {
  return database.lead.findFirst({
    where: { id: leadId, workspaceId: ctx.workspaceId, deletedAt: null },
    include: {
      tagLinks:        { select: { leadTag:  { select: { id: true, name: true, colorToken: true } } } },
      listMemberships: { select: { leadList: { select: { id: true, name: true } } } },
    },
  })
}

export async function insert(ctx: Ctx, data: Prisma.LeadCreateInput, database: Db = db) {
  return database.lead.create({ data, select: SUMMARY_SELECT })
}

/** Soft delete only. Leads are referenced by EmailEvent, threads, opportunities. */
export async function softDeleteMany(ctx: Ctx, ids: string[], database: Db = db): Promise<number> {
  const res = await database.lead.updateMany({
    where: { id: { in: ids }, workspaceId: ctx.workspaceId, deletedAt: null },
    data: { deletedAt: new Date() },
  })
  return res.count
}

export async function countScoped(ctx: Ctx, f: LeadFilter, database: Db = db): Promise<number> {
  return database.lead.count({ where: scope(ctx, f) })
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
import { db } from '@/lib/db'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { ok, err, type Result } from '@/lib/result'
import { requireCan } from '@/server/authz'
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
  requireCan(ctx, 'leads.view')
  const rows = await repo.findPage(ctx, filter, decodeCursor(filter.cursor, filter.sort))
  const hasMore = rows.length > filter.limit
  const page = hasMore ? rows.slice(0, filter.limit) : rows
  const last = page.at(-1)
  return { rows: page, hasMore, nextCursor: hasMore && last ? encodeCursor(last, filter.sort) : null }
}

/** Throws NotFoundError for a missing lead AND for another workspace's lead. */
export async function get(ctx: Ctx, leadId: string): Promise<LeadDetail> {
  requireCan(ctx, 'leads.view')
  const row = await repo.findByIdInWorkspace(ctx, leadId)
  if (!row) throw new NotFoundError('Lead')
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
  requireCan(ctx, 'leads.create')
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
    return ok(await db.$transaction(async (tx) => {
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
      const existing = await db.lead.findFirst({
        where: { workspaceId: ctx.workspaceId, email: input.email },
        select: { id: true },
      })
      return err({ kind: 'duplicate_email', existingLeadId: existing?.id ?? '' })
    }
    throw e
  }
}

export async function update(ctx: Ctx, input: UpdateLeadInput): Promise<LeadSummary> {
  requireCan(ctx, 'leads.edit')
  const res = await db.lead.updateMany({
    where: { id: input.leadId, workspaceId: ctx.workspaceId, deletedAt: null },
    data: {
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.status    !== undefined ? { status:    input.status    } : {}),
    },
  })
  // count === 0 covers BOTH "no such lead" and "another workspace's lead", so the
  // 404-not-403 rule holds without a second query (§6.4).
  if (res.count === 0) throw new NotFoundError('Lead')
  const row = await repo.findByIdInWorkspace(ctx, input.leadId)
  if (!row) throw new NotFoundError('Lead')
  return row
}

export async function softDelete(ctx: Ctx, ids: string[]): Promise<number> {
  requireCan(ctx, ids.length > 1 ? 'leads.bulk_delete' : 'leads.delete')
  if (ids.length > 1000) throw new ConflictError('Too many leads in one call; use the bulk job.')
  return repo.softDeleteMany(ctx, ids)
}
```

Three details that cost an implementer time if undocumented:

- **`Prisma.InputJsonValue` for `customFields`**, not `object` or `unknown` —
  it is what `Lead.customFields Json @default("{}")` accepts, and the others do
  not compile.
- **`requireCan` is the first statement of every function**, including reads
  (§4.2). `leads.view` is `ALL` in the matrix, so it costs an array lookup and
  documents intent.
- **`NotFoundError` takes a resource name, not an id.** Its constructor signature
  is `(resource = 'Resource', options?)` — passing an id as the second argument
  puts it in `options`, silently. Ids belong in the log line, not the message.

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
3. **Never** `db.emailAccount.findMany()` from `campaigns/repo.ts`. That is
   a hidden dependency lint cannot see and the graph does not record.

---

## 4. The `Ctx` pattern

> **Ownership note.** `07-auth-and-security.md` §9 owns `Ctx`, `requireSession`,
> `requireWorkspace`, the capability matrix, and the 404-not-403 rule, and
> `src/server/authz.ts` + `src/lib/errors.ts` are already on disk implementing
> them. This section does not restate that design. It states the parts that are a
> **backend/module** contract: the shape modules may rely on, why the parameter
> exists at all, and how the worker gets one.

### 4.1 The type modules code against

As specified in `07` §9.1 and constructed only by `requireWorkspace()`:

```ts
// src/server/ctx.ts — owned by 07-auth-and-security.md §9.1
export type Ctx = {
  userId: string
  workspaceId: string
  role: Role          // Prisma enum: OWNER | ADMIN | MEMBER
  sessionId: string   // so changePassword can spare the current session
  timezone: string    // workspace timezone; for rendering, never for storage
}
```

**Every service function takes `Ctx` as its first parameter.** No exceptions,
including read-only functions and job handlers. `07` §9.1 states the security half
of the reason ("making `Ctx` the sole carrier of tenancy is what lets the
isolation sweep be exhaustive"). The architectural half is §1.1's: a module never
*discovers* its own tenancy, it is *told*. That is what keeps `server/ → modules/`
one-directional, and it is why the same `leads.list` runs unchanged under a web
request and under a worker job where no cookie exists.

`requireWorkspace()` is wrapped in React `cache()` (`07` §9.2), so a page with
eight server components each calling it performs one session probe and one
membership lookup. Modules must not cache `Ctx` themselves — a module-scope cache
in a long-lived server process is shared across tenants (`07` §10.5 bans it).

### 4.2 Authorization inside a service

`src/server/authz.ts` (on disk) exports `can`, `requireCan`, `MATRIX`, and
`Capability`. The backend rule:

> **`requireCan(ctx, capability)` is the first statement of every mutating service
> function.** Not in the action wrapper alone, not in the page.

The wrapper checks it too (`07` §13.1 step 4), which looks redundant and is not:
a service is also reachable from a route handler and from a job handler, and only
the service-level check covers all three entry points. `07` §9.6 states this as
"the UI hides, the server stops"; the module-level consequence is that the check
lives at the innermost boundary that every caller must cross.

One thing this creates that `07` does not spell out: **modules import
`@/server/authz`.** That is the single permitted exception to §0 rule 5
("modules never import `src/server/**`"), and it does not create a cycle —
`authz.ts` imports only `@prisma/client`, `@/lib/errors`, `@/lib/logger`, and the
`Ctx` type. It reads no table, so it sits at L0 alongside `lib/` for graph
purposes. Verified against the file on disk: its imports are exactly those four.

### 4.3 Why a client-supplied `workspaceId` is never trusted

`07` §9.2 gives the rule and the mechanism (`.strict()` schemas make a smuggled
`workspaceId` a *validation failure*, not a silently stripped field). The concrete
attack, restated once because it is the reason for §3's entire repo discipline:

```
GET /leads?workspaceId=<victim-workspace-id>&status=REPLIED
```

The attacker is a legitimately authenticated user of their own workspace, so
session auth passes. If the workspace filter came from input, they read the
victim's replied-lead list — names, companies, addresses. Only resolving the
tenant server-side helps.

Three structural, greppable defences follow, and they are module-layer
obligations:

1. **No zod schema in any module accepts a `workspaceId` field.**
   `grep -rn "workspaceId" src/modules/*/schema.ts` must return nothing.
2. **Every action schema is `.strict()`** (`07` §13.1), so the smuggling attempt
   is loud rather than invisible.
3. **`repo.scope(ctx)` is the sole entry to every query in a repo file**, so
   auditing tenancy is "does this file name `workspaceId` in exactly one place",
   a five-second read rather than a forty-query review.

### 4.4 `Ctx` in the worker

The worker has no cookie. `Job.workspaceId` is non-null (schema: "Every job
belongs to a tenant — including MAINTENANCE") and is where its tenancy comes
from. `07` §9.6 specifies the synthetic identity; the module-facing contract:

```ts
// src/server/system-ctx.ts — imported by worker/registry.ts, never by app/**
export async function systemCtxFor(workspaceId: string): Promise<Ctx>
```

It resolves the workspace (throwing `NotFoundError` if purged or soft-deleted),
and returns a `Ctx` with `userId: 'system'`, `role: 'OWNER'`, and a synthetic
`sessionId`. Two consequences worth naming:

- **The worker is never cross-tenant.** A handler receives a `Ctx` scoped to one
  workspace, so §3's `repo.scope(ctx)` chokepoint protects worker paths too. There
  is no "admin mode" that bypasses the filter. `07` §9.6 makes the same point from
  the other direction: `enqueue()` always sets `workspaceId` from the enqueuing
  `Ctx`, never from the payload, "a job that could name an arbitrary workspace
  would be a cross-tenant escalation".
- **`role: 'OWNER'` is safe** because the scope is one workspace and `requireCan`
  exists to stop *users*, not the system. Worker-written `AuditLog` rows carry
  `actorUserId = null`, which the schema explicitly allows.

Cross-tenant maintenance (prune terminal jobs, expire invites, sweep rate-limit
rows) is the one thing that legitimately spans workspaces. Those functions take
**no `Ctx`**, live in `repo.ts`, are reachable only from `worker/maintenance.ts`,
and are enumerated exhaustively — the `*AcrossWorkspaces` suffix is what makes an
unreviewed seventh addition greppable:

```
jobs.pruneTerminalJobsAcrossWorkspaces(olderThanDays)
jobs.reclaimExpiredLeasesAcrossWorkspaces()
workspace.expireInvitesAcrossWorkspaces()
workspace.purgeSoftDeletedWorkspaces(olderThanDays)
mailboxes.listDueForWatchRenewAcrossWorkspaces()
analytics.listWorkspacesNeedingRollup()
```

Six. Plus `rateLimit.sweepExpired()`, which touches no tenant data at all. Any
addition needs lead approval.

## 5. The Server Action wrapper

> **Ownership note.** `07-auth-and-security.md` §13.1 owns `action()` — its
> signature, its five-step order, and the `.strict()` mandate. This section states
> the module-facing half: what an action file may contain, and how a module's
> `Result` error becomes a typed failure.

### 5.1 The contract, as `07` §13.1 fixes it

```ts
// src/server/action.ts — owned by 07-auth-and-security.md §13.1
type ActionOpts<C extends Capability> = {
  name: string          // stable dotted name; used in logs and rate-limit keys
  capability: C
  schema: z.ZodType     // ALWAYS .strict()
  rateLimit?: RateLimitRule
}

export function action<S extends z.ZodType, R>(
  opts: ActionOpts<Capability> & { schema: S },
  handler: (ctx: Ctx, input: z.infer<S>) => Promise<R>,
): (raw: unknown) => Promise<ActionResult<R>>
```

Order of operations, load-bearing at every step (`07` §13.1):

```
1. requireWorkspace()          unauthenticated → { ok:false, error:'unauthorized' }
2. rate limit                  over            → { ok:false, error:'rate_limited', retryAfterSeconds }
3. schema.parse(raw)           invalid         → { ok:false, error:'validation', issues }
4. requireCan(ctx, capability) denied          → { ok:false, error:'forbidden' }
5. handler(ctx, input)         AppError        → typed error; unexpected → logged, generic message
```

Rate limiting before parsing so a flood of malformed payloads cannot burn CPU on
zod; authorization after parsing so a denial is not a validation oracle. Note this
differs from the ordering an earlier draft of this document proposed
(validate-then-limit); `07`'s ordering is correct and is the one implemented.

`ActionResult<R>` is a discriminated union on `ok`, so a client narrows with one
`if` and `data` is unreachable on the failure branch. `useActionState` consumers
render field issues next to inputs and the message in an `aria-live` region.

### 5.2 The one framework hazard worth stating explicitly

`requireWorkspace()` calls `redirect('/onboarding')` when there is no membership
(`07` §9.2), and `redirect()` works by **throwing** a Next control-flow signal. A
wrapper with a `catch` that maps everything to `ActionResult` will swallow it, and
the redirect silently stops happening while the user sees
`{ ok: false, error: 'internal' }`.

`action()` must therefore rethrow framework errors before its own handling:

```ts
import { unstable_rethrow } from 'next/navigation'

try {
  // … steps 1–5
} catch (err) {
  unstable_rethrow(err)   // no-op unless err is a Next internal signal
  // … map AppError → ActionResult
}
```

`unstable_rethrow` exists for exactly this ("wrapping an API that uses errors to
interrupt control flow"). This is the single most likely bug in the wrapper and it
is silent, which is why it is called out here rather than left to the reader.

### 5.3 What an action file may contain

```ts
// src/app/(app)/leads/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { action } from '@/server/action'
import { ConflictError, ValidationError } from '@/lib/errors'
import * as leads from '@/modules/leads'

export const createLead = action(
  {
    name: 'leads.create',
    capability: 'leads.create',
    schema: leads.createLeadSchema,
    rateLimit: { bucket: 'leads.create', limit: 120, windowMs: 60_000 },
  },
  async (ctx, input) => {
    const res = await leads.create(ctx, input)
    if (!res.ok) {
      // A module Result error becomes a typed failure by throwing the matching
      // AppError. The wrapper does the mapping; the action states the meaning.
      if (res.error.kind === 'duplicate_email') {
        throw new ConflictError('A lead with that email already exists.')
      }
      throw new ValidationError('That lead could not be created.', {
        email: [res.error.kind],
      })
    }
    revalidatePath('/leads')
    return res.data
  },
)
```

Five rules, all review items:

1. **`ctx` is never constructed in an action body.** The wrapper hands it over. An
   action calling `requireWorkspace()` itself is redundant.
2. **The action file is thin.** Name, capability, schema, rate limit, revalidation,
   and `Result`→`AppError` mapping. Logic belongs in the service.
3. **`capability` is declarative**, so "which actions need which capability" is
   answerable by grep against `authz.ts`'s `MATRIX` — that is what makes §16's
   table maintainable rather than aspirational.
4. **`revalidatePath` is called in the action, never in the service** (§3.1 rule
   4): a service that imports `next/cache` cannot run in the worker.
5. **Progressive-enhancement `<form action={fn}>`** works because the wrapper takes
   `unknown`. For raw `FormData`, convert with `Object.fromEntries(fd)` in the
   action file and let `z.coerce` handle string-typed values. `FormData` handling
   does not go in the wrapper — it would tax every JSON caller.

### 5.4 What the wrapper deliberately does not do

- **No CSRF token.** Next's Server Actions are POSTs with an action id and an
  origin check (`07` §15.1). Route handlers *do* need `assertSameOrigin()` (§7.3)
  because they have no such protection.
- **No automatic audit log.** `AuditLog.action` is a curated dotted vocabulary, not
  "every action that ran". Services call `writeAudit()` for the events brief §6
  lists.
- **No retries.** A retried mutation without an idempotency key is a duplicate
  (§12). Retry is the user's decision, or the queue's — with a key.
- **No response caching.** Actions are mutations.

## 6. Error model

> **Ownership note.** `src/lib/errors.ts` and `src/lib/result.ts` are **already on
> disk**, and `07-auth-and-security.md` §10.2 owns the 404-not-403 rule. This
> section describes what is implemented, not a proposal, and then adds the part no
> other doc covers: the decision rule for throwing versus returning, and how
> Prisma error codes map.

### 6.1 The hierarchy as implemented

```ts
// src/lib/errors.ts (on disk)
export type ErrorCode =
  | 'NOT_FOUND' | 'FORBIDDEN' | 'UNAUTHORIZED' | 'VALIDATION'
  | 'CONFLICT' | 'RATE_LIMITED' | 'PROVIDER_ERROR' | 'UNAVAILABLE' | 'INTERNAL'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  /** Safe to show a user. Never embed internal detail or secrets here. */
  readonly publicMessage: string
  constructor(
    code: ErrorCode, status: number, publicMessage: string,
    options?: { cause?: unknown; internalMessage?: string },
  )
}

export class NotFoundError    extends AppError  // 404
export class UnauthorizedError extends AppError // 401
export class ForbiddenError   extends AppError  // 403
export class ValidationError  extends AppError  // 422, + fieldErrors
export class ConflictError    extends AppError  // 409
export class RateLimitedError extends AppError  // 429, + retryAfterSeconds
export class ProviderError    extends AppError  // 502, + provider, retryable
export class UnavailableError extends AppError  // 503

export function isAppError(e: unknown): e is AppError
export function toPublicError(e: unknown): { code: ErrorCode; status: number; message: string }
```

Three implementation choices worth understanding before writing code against it:

- **`publicMessage` vs `message` is the whole safety mechanism.** `super()` receives
  `options.internalMessage ?? publicMessage`, so `err.message` may carry detail
  (a Prisma message, a provider body) while `err.publicMessage` is the only thing
  a client ever sees. `toPublicError` collapses anything that is not an `AppError`
  to a generic 500. **Never send `err.message` to a client**; send
  `toPublicError(err).message`.
- **There is no `InternalError` class and no `expected` flag.** An unexpected
  throw stays whatever it was and `toPublicError` handles it. Classification for
  logging is therefore `isAppError(e)` — true means a modelled outcome (`warn`),
  false means a bug (`error`).
- **`RateLimitedError` carries `retryAfterSeconds`, not milliseconds.** It maps
  directly to the `Retry-After` header, which is defined in seconds
  (`07` §14.5).

There is deliberately **no `TimeoutError`**. A DB statement timeout surfaces as
`UnavailableError`; a provider timeout as `ProviderError({ retryable: true })`. A
third class would force every consumer to handle a case whose correct response is
always one of those two.

**`ProviderError` is the seam to the queue.** `06` §6.6 defines the queue-control
classes (retryable / terminal / defer) in `modules/jobs/`; `ProviderError` is the
domain fact and `retryable` is the bit the queue reads. The mapping lives in
`modules/sending/providers/gmail.ts` and nowhere else.

### 6.2 `Result` as implemented

```ts
// src/lib/result.ts (on disk)
export type Result<T, E = string> = { ok: true; data: T } | { ok: false; error: E }
export function ok<T>(data: T): Result<T, never>
export function err<E>(error: E): Result<never, E>
export function isOk / isErr / unwrap
```

The success field is **`data`**, not `value`, and the constructors are lowercase
`ok` / `err`. Matching `ActionResult`'s `{ ok, data }` shape is deliberate: a
service `Result` flows into an action result without a rename.

### 6.3 Throw vs `Result` — the decision rule

> **Throw when the caller cannot reasonably do anything except show an error.
> Return a `Result` when a specific failure has its own UI or its own next step.**

| Situation | Mechanism | Why |
|---|---|---|
| Lead id not in this workspace | `throw NotFoundError` | page renders 404; nothing to "handle" |
| Caller's role lacks the capability | `throw ForbiddenError` (via `requireCan`) | one response: tell them |
| Malformed input | `throw ValidationError` (wrapper does it) | field errors *are* the UI |
| Duplicate email on lead create | `Result` → `duplicate_email` | UI offers "open the existing lead" |
| CSV row invalid | `Result` per row | valid rows import, invalid rows are reported |
| Lead suppressed at enrollment | `Result` → `suppressed` | the rest enroll; a count is shown |
| Campaign has no sendable mailbox | `Result` → `no_eligible_mailbox` | the launch dialog names the fix |
| Gmail 429 | `throw ProviderError({ retryable: true })` | the queue handles it; no UI involved |
| Gmail 400 invalid recipient | `throw ProviderError({ retryable: false })` | dead-letter + suppress the lead |
| DB unreachable | let it propagate | nothing to decide |
| A batch where some items fail | `Result` with per-item outcomes | partial success is the truth |

The failure mode this prevents is `Result` everywhere: then every call site is
`if (!r.ok) return r` noise and a five-step service function's type is a union of
eleven error kinds nobody handles.

Corollary: **a `Result` error kind must have a named UI treatment.** If nobody can
say what the screen does differently, it should have been a throw.

### 6.4 The 404-not-403 rule, as a repo obligation

`07` §10.2 owns the rule. The module-layer mechanics, because this is where it is
either free or impossible:

```ts
// Correct: one query. Cannot distinguish "absent" from "foreign".
const row = await db.lead.findFirst({ where: { id, workspaceId: ctx.workspaceId } })
if (!row) throw new NotFoundError('Lead')

// WRONG: two steps, and the second one is the oracle.
const row = await db.lead.findUnique({ where: { id } })
if (!row) throw new NotFoundError('Lead')
if (row.workspaceId !== ctx.workspaceId) throw new ForbiddenError('view this lead')
```

The wrong version is the natural thing to write, which is why `repo.scope(ctx)`
exists: with the filter inside the `where`, there is no place to put the leak.
**`findUnique` / `update` / `delete` by bare id on a tenant-owned model is a review
rejection** — `07` §10.1 bans them and `09` §9.3's isolation sweep fails CI on an
uncovered repo export. Use `findFirst` and `updateMany` / `deleteMany` with
`workspaceId` in the `where`, and read the returned `count` to detect "the caller
named rows it does not own".

`ForbiddenError` is thrown **only** by `requireCan` and the explicit role guards in
`authz.ts`. A repo miss is always `NotFoundError`.

### 6.5 Error → HTTP → UI

| Class | HTTP (route handler) | Server Component | Action result | UI |
|---|---|---|---|---|
| `NotFoundError` | 404 | `notFound()` → in-shell 404 | `NOT_FOUND` | "Not found" + back link |
| `ForbiddenError` | 403 | in-shell unauthorized state | `FORBIDDEN` | "You do not have permission" + who to ask |
| `UnauthorizedError` | 401 | `redirect('/login?next=…')` | `UNAUTHORIZED` | client redirects to login |
| `ValidationError` | 422 | *(cannot occur — no user input)* | `VALIDATION` + `fieldErrors` | inline field errors + `aria-live` summary |
| `ConflictError` | 409 | `error.tsx` | `CONFLICT` | specific message + the alternative action |
| `RateLimitedError` | 429 + `Retry-After` | rate-limited state | `RATE_LIMITED` + `retryAfterSeconds` | real reset time, control disabled with countdown |
| `ProviderError` | 502 | disconnected/degraded state | `PROVIDER_ERROR` | honest "Gmail is not responding" + Retry |
| `UnavailableError` | 503 | `error.tsx` | `UNAVAILABLE` | "Temporarily unavailable" / "not configured yet" |
| anything else | 500 | `error.tsx` | `INTERNAL` | generic message + Retry; **detail only in logs** |

Two hard rules on the boundary:

1. **A 500 body never contains a raw `err.message`.** It may carry a database
   error, a file path, or a query fragment. The client gets `toPublicError`'s fixed
   string plus the `requestId`; the detail is in the log line keyed by that id.
2. **Server Components translate, they do not catch-and-render.** A page calls
   `notFound()` or `redirect()` and lets everything else reach `error.tsx`. A page
   that try/catches a module call and renders its own error box duplicates the
   boundary and loses the reset button.

```
        module service
              │ throws AppError
   ┌──────────┴──────────┬────────────────────┐
   ▼                     ▼                    ▼
 action()            page/layout        route handler
 catches →           translates →       toPublicError →
 ActionResult        notFound()         Response(status)
                     redirect()         + { code, message, requestId }
 │                   or bubbles to
 ▼                   error.tsx
 form/toast state
```

### 6.6 Prisma error codes we interpret

Only these three. Anything else propagates and becomes a 500.

| Prisma | PG | Meaning | Mapping |
|---|---|---|---|
| `P2002` | 23505 | unique violation | `ConflictError`, or a `Result` dedupe branch (`Lead(workspaceId,email)`, `Job.dedupeKey`, `ScheduledEmail.dedupeKey`, `EmailEvent.dedupeKey`) |
| `P2003` | 23503 | FK violation | `ConflictError('Referenced record no longer exists.')` — normally a concurrent delete |
| `P2025` | — | record required but not found | `NotFoundError` |

Detected with `e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'`.
`code` is typed `string`, not a literal union, so there is no exhaustiveness help
from the compiler — keep the checks in one helper per repo rather than scattered.

`P2002` on a `dedupeKey` is **not an error** in the queue path: the schema states "a
second insert with the same key raises 23505 and the caller treats that as
success". `jobs.enqueue` returns `{ created: false }`. Never surface it as a
conflict — a deduped enqueue is the system working.

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
import { isAppError, toPublicError } from '@/lib/errors'
import { logger } from '@/lib/logger'

type RouteAuth = 'workspace' | 'session' | 'worker-token' | 'webhook' | 'public-token'

export type RouteConfig<S extends z.ZodType, T> = {
  name: string
  auth: RouteAuth
  /** Mandatory for every non-GET with cookie auth. Calls assertSameOrigin(). */
  requireSameOrigin?: boolean
  rateLimit?: RateLimitRule
  input?: S
  handler: (args: { input: z.output<S>; req: Request; ctx: Ctx | null }) => Promise<T>
}

export function jsonRoute<S extends z.ZodType, T>(config: RouteConfig<S, T>) {
  return async function handle(req: Request): Promise<Response> {
    const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID()
    try {
      // auth by mode → same-origin check → rate limit → zod parse → handler
      const data = await config.handler({ input: undefined as z.output<S>, req, ctx: null })
      return NextResponse.json(data, { headers: { 'x-request-id': requestId } })
    } catch (err) {
      // toPublicError collapses anything that is not an AppError to a generic 500,
      // so an internal message can never reach the client (§6.1).
      const pub = toPublicError(err)
      const headers: Record<string, string> = { 'x-request-id': requestId }
      if (pub.code === 'RATE_LIMITED' && isAppError(err) && 'retryAfterSeconds' in err) {
        headers['Retry-After'] = String(err.retryAfterSeconds)
      }
      if (isAppError(err)) {
        logger.warn('http.request.completed', {
          name: config.name, status: pub.status, code: pub.code, requestId,
        })
      } else {
        logger.error('http.request.completed', err, {
          name: config.name, status: 500, requestId,
        })
      }
      return NextResponse.json(
        { code: pub.code, message: pub.message, requestId },
        { status: pub.status, headers },
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
| `db.$transaction([...])` (batch) | 2+ independent writes, no reads between them | one round trip, connection held briefly |
| `db.$transaction(async (tx) => …)` (interactive) | a write depends on a read taken in the same tx | holds a pooled connection for the whole callback |

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
await db.$transaction(async (tx) => {
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

Note `priority DESC`: the schema documents `Job.priority` as "Higher runs first",
and `06` §0 and §5.1 now follow it (bands 90 = stop propagation … 10 = rollups), so
every `ORDER BY priority` in the codebase is `DESC`. An earlier draft of `06` used
the opposite convention; it does not any more, and there is nothing for the lead to
resolve. The trap this leaves is real, though: `priority: 10` means *lowest*
urgency, which reads backwards to anyone who has used a queue where 1 is highest.
Use the band names from `06` §5.1 rather than bare numbers in code.

---

## 9. Connection management

### 9.1 `src/lib/db.ts` — as implemented

**This file is already on disk.** Prisma 7 removed `url` and `directUrl` from the
`datasource` block entirely (`INTEGRATION-NOTES.md` §1): the block carries
`provider` only, Migrate reads `datasource.url` from `prisma.config.ts`, and
`PrismaClient` takes a **driver adapter**.

```ts
// src/lib/db.ts (on disk)
import 'server-only'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { env } from './env'

const isWorker = process.env.INSTANT_MAIL_PROCESS === 'worker'

function createClient() {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    // Headroom over worker concurrency so a job never waits on the pool while
    // holding a lease.
    max: isWorker ? env.WORKER_CONCURRENCY + 2 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

// Next dev HMR re-evaluates modules on every edit; without the global cache we
// leak a pool per reload until Postgres refuses connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const db = globalForPrisma.prisma ?? createClient()

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = db
```

**The export is `db`, not `prisma`.** Every repo and service file writes
`import { db } from '@/lib/db'`, and §3.3 does so throughout. A repo function's
optional transaction parameter is therefore named `database` to avoid shadowing it.

Details that are load-bearing:

- **Profile selection is `INSTANT_MAIL_PROCESS === 'worker'`**, read at module
  evaluation. `worker/index.ts` must set it **before** any import that transitively
  reaches `db.ts`, or the worker silently gets the web pool. Put the assignment on
  the first line of the file and assert it after imports.
- **`connectionString` is passed to `PrismaPg`, not a bare `Pool`.** Both overloads
  exist. The string form is used here and takes the `pg` `PoolConfig` fields
  inline, which is where `max` comes from — without it, sizing would be Prisma's
  `cpus × 2 + 1` default, wrong for both profiles.
- **The prod `log` level is `['error']`, never `['query']`.** Query logging on a send
  path prints recipient addresses, and brief §9 forbids that.
- **`env.NODE_ENV !== 'production'`** guards the global cache, not
  `=== 'development'`, so `test` also reuses one client across test files.
- **`serverExternalPackages`** in `next.config.ts` lists `@prisma/client`,
  `@prisma/adapter-pg`, and `pg`, so a stray client-side import fails at build
  rather than shipping a broken chunk.

Two settings this document recommends adding, both diagnostic rather than
functional, and both cheap:

```ts
  application_name: isWorker ? 'instantmail-worker' : 'instantmail-web',
  statement_timeout: isWorker ? 60_000 : 10_000,
```

`application_name` is the difference between a five-minute and a fifty-minute
diagnosis in `pg_stat_activity` during an incident. `statement_timeout` is a
server-side kill switch: a runaway query cannot pin a connection indefinitely even
if a Prisma-side timeout is missed. `09` §3.4 specifies both timeout values.

### 9.2 The worker's client

The worker imports the same module and the same singleton. On `SIGTERM` it stops
leasing, waits for in-flight jobs, then `await db.$disconnect()`. **The web process
never disconnects** — the pool lives as long as the process.

### 9.3 Budget

From `09` §3.4, restated because §8.4's rules only make sense against these
numbers:

```
managed Postgres, max_connections = 100
  web      3 replicas × 10                 = 30
  worker   1 replica  × (4 + 2) = 6        =  6
  migrate deploy (transient)               =  1
  operator psql / platform dashboard       =  5
  reserved superuser                       =  3
  ────────────────────────────────────────────
  peak                                     = 45   ✓ ~55% headroom
```

`09` §3.4 budgets the worker at `WORKER_CONCURRENCY + 4` (8); the code on disk uses
`+ 2` (6). Both fit comfortably; the code is the operative number and the doc's
table should be corrected to match rather than the reverse — `+2` is the tighter,
more defensible figure since a leased job's work happens outside any transaction.

Local dev: one web process at 10 and one worker at 6 against the user-space cluster
on port 5433, whose `max_connections` is the initdb default of 100. Never a
constraint locally.

### 9.4 pgbouncer

There is no pooler today; the schema comment says to add `directUrl` "the same day
a pooler lands, and not before". When one lands, four things change and nothing
else:

1. `DATABASE_URL` points at the pooler in **transaction mode**; `max` drops to `1`
   per serverless invocation (each invocation is its own process; the pooler does
   the pooling).
2. `DIRECT_DATABASE_URL` must be set and non-empty. `prisma.config.ts` already
   prefers it for Migrate, and DDL through a transaction pooler fails.
3. **Prepared statements must not be cached.** With `@prisma/adapter-pg` this is a
   `pg` concern, not a `?pgbouncer=true` query param: transaction-mode pooling gives
   a different backend per transaction, so a named statement cached against one
   backend is absent on the next. `PrismaPgOptions.statementNameGenerator` is the
   control, and the adapter caches nothing unless one is supplied — so **do not
   supply one under a transaction pooler.** Leave it unset, which is what the file
   on disk does.
4. `SELECT … FOR UPDATE SKIP LOCKED` still works, because §8.5's lease is one
   statement and the work happens outside any transaction. **Session-level state does
   not**: `LISTEN/NOTIFY`, advisory locks held across statements, and `SET` without
   `SET LOCAL`. One thing in the current design depends on that —
   `worker/maintenance.ts` serialises maintenance ticks with
   `pg_try_advisory_lock`. Under a transaction pooler that must become
   `pg_advisory_xact_lock` inside a transaction, which releases on commit. Noted so
   the migration is a checklist rather than an investigation.

### 9.5 Prisma singleton anti-patterns

| Anti-pattern | What breaks |
|---|---|
| `new PrismaClient()` in a module or route handler | one pool per module instance; dev exhausts connections within minutes |
| `$connect()` at import time | slows cold start; the adapter connects lazily on first query for a reason |
| A client per request | ~40ms of TCP + TLS + auth per request, and 100 concurrent requests exceed `max_connections` |
| `$disconnect()` in a route handler or after an action | kills the shared pool for every other in-flight request |
| Passing the client as a parameter | encourages a repo taking a client from a non-transaction caller; `database: Db = db` in §3.3.3 exists for `tx` only |

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

This contradicts `03-frontend.md` §7.2 and is flagged in §17.8 for the lead. If the
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

> **Ownership note.** `07-auth-and-security.md` §10.5 owns the tenancy rules for
> caching and **bans `unstable_cache` / `"use cache"` for any tenant-scoped read**,
> plus module-scope `Map`/object caches. This section does not soften that; it
> states what remains cacheable and fixes the revalidation conventions per module.

### 11.1 The default is: do not cache tenant data

Every `(app)/**` page reads cookies through `requireWorkspace()`, which makes the
route dynamic. That is correct and we do not fight it. RSC still gives streaming,
parallel section queries, and per-`<Suspense>` boundaries — the performance story
is "seven parallel indexed queries", not a cache.

`07` §10.5 and `07` §2551 rank a mis-keyed cache as the highest-severity leak
available to us, and the reasoning is worth internalising: a cache key is derived
from a function's *arguments*, so a helper that reads `ctx.workspaceId` from an
enclosing scope produces **one entry that serves every tenant**. It passes every
query-level isolation test, because the query was never re-run. It presents as a UI
bug rather than a breach.

> **Rule: no tenant data enters a cross-request cache. Full stop.** If a future
> need is genuine, `workspaceId` must be an explicit first argument, the entry goes
> in the table below with its key spelled out, and the lead approves it.

### 11.2 What is cached

| Data | Mechanism | Key | Lifetime |
|---|---|---|---|
| Marketing, legal, pricing pages | full route cache (no cookie read) | route | build |
| Fonts, icons, CSS, JS | immutable asset headers | content hash | 1 year |
| `next/font` files | build-time | — | build |
| `getSession()`, `requireWorkspace()` | React `cache()` | per-request by construction | one request |
| Everything else tenant-scoped | **not cached** | — | — |

React `cache()` is the only caching in the request path, and it is safe because its
lifetime *is* the request (`07` §10.5). It is what makes `requireWorkspace()` free
to call from eight server components.

Note this **overrules** two earlier proposals. `03-frontend.md` §3.5 suggests
`unstable_cache` for the nav badges "for 60s keyed by workspace", and an earlier
draft of this document proposed the same plus a `CustomFieldDefinition` cache.
Both are banned by `07` §10.5. `03`'s own stated budget is the right answer: keep
the badges to three indexed counts, and "if this budget is ever exceeded, the fix
is to drop a badge, not to add caching layers." Flagged in §17.9.

`next/cache` in Next 16 also exports `cacheTag`, `cacheLife`, `updateTag`, and
`refresh` for `"use cache"`. None is used for tenant data.

### 11.3 Revalidation conventions

Path revalidation is the default; tags are for data that appears on pages other
than the one being mutated.

**Tag naming — always workspace-prefixed**, per `07` §10.5:

```
ws:${workspaceId}:leads          ws:${workspaceId}:campaigns
ws:${workspaceId}:campaign:${id} ws:${workspaceId}:mailboxes
ws:${workspaceId}:inbox          ws:${workspaceId}:crm
```

A bare `'leads'` tag invalidates across tenants. Not leaky, but it means one
tenant's write can serve another's stale render, and on a busy instance it is a
self-inflicted thundering herd.

**Per-module revalidation table.** Called from the action file (§5.3 rule 4),
never from a service.

| Module · operation | Revalidates |
|---|---|
| `leads.create` / `update` / `softDelete` | `/leads`, `/leads/${leadId}` |
| `leads.bulk*` | `/leads`; tag `ws:*:leads` |
| `leads.commitImport` | `/leads`, `/leads/import/${importId}` |
| `leads.createList` / list membership | `/leads/lists`, `/leads` |
| `leads.suppress` | `/leads/${leadId}`, `/settings/suppressions`; tag `ws:*:leads` |
| `campaigns.create` / `update` | `/campaigns`, `/campaigns/${id}` |
| `campaigns.launch` / `pause` / `resume` | `/campaigns`, `/campaigns/${id}`, `/dashboard` |
| `campaigns.enroll` | `/campaigns/${id}/leads`, `/campaigns/${id}` |
| `sequences.upsertStep` / `deleteStep` / `reorder` | `/campaigns/${id}/sequence`, `/campaigns/${id}` |
| `mailboxes.connect` / `disconnect` / `update` | `/mailboxes`, `/mailboxes/${id}`, `/dashboard` |
| `inbox.sendReply` / `archive` / `markRead` | `/inbox`, `/inbox/${threadId}`, `/dashboard` |
| `crm.*` | `/crm`, `/crm/opportunities/${id}`, `/leads/${leadId}` |
| `workspace.updateSettings` | `/settings`, `/` (`'layout'`) |
| `workspace.switchWorkspace` | `/` with `'layout'` — the shell must re-render (`07` §10.4) |
| `ai.*` | nothing (results render in a client island that refreshes itself) |

Rules:

1. **Revalidate the specific path, then the list.** `/leads/${id}` and `/leads`, not
   `revalidatePath('/', 'layout')`. The nuclear option costs every user's entire
   router cache.
2. **`revalidatePath('/', 'layout')` only for a workspace switch or a workspace
   settings change**, because those alter the shell itself.
3. **Worker code never revalidates.** `revalidatePath` needs a request scope and the
   worker has none. Data written by a job becomes visible on the user's next
   navigation — which is why `/leads/import/[importId]/running` polls (`03` §7.4)
   and the inbox has a "new messages" pill (`03` §5.10).
4. **Revalidate only after the write commits.** Busting a cache on a failed write
   means re-fetching identical data.

### 11.4 Review checklist

Four greps, all of which must come back empty:

```bash
# 1. No cross-request cache of tenant data (07 §10.5 ban).
grep -rn "unstable_cache\|'use cache'\|cacheTag(" src/

# 2. No module-scope mutable cache in a long-lived process.
grep -rn "^const .* = new Map(\|^const cache = {" src/modules/ src/server/

# 3. Every revalidateTag argument is workspace-prefixed.
grep -rn "revalidateTag(" src/ | grep -v 'ws:\${'

# 4. No module imports next/cache — revalidation is the caller's job (§3.1).
grep -rn "from 'next/cache'" src/modules/
```

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

`Job.dedupeKey` is globally `@unique` and non-nullable — unconditionally, for the
row's whole lifetime. `06` §0 accepts this explicitly ("There is no 'unique among
outstanding rows' escape hatch") and resolves it by embedding a period bucket in
every repeatable key, which is why §12's key list has `bucket60` and `YYYY-MM-DD`
components rather than bare ids.

The consequence to internalise: **a key is consumed forever, so recovery from a
`DEAD` job is always replay-in-place, never re-enqueue.** `jobs.replay` mutates the
existing row and increments `Job.replayCount`; enqueueing the same logical work again
would collide. §17.4 covers the one case where this is uncomfortable.

**Idempotency the API does *not* have:** no client-supplied `Idempotency-Key`
header on route handlers. The only handler where a retry could duplicate a write
is `/api/leads/import`, and it is already idempotent by resource: it creates a
`LeadImport` row and returns its id; a retried upload creates a second import the
user can see and cancel, which is honest. Adding a header-based scheme for one
endpoint is not worth the machinery.

---

## 13. Observability

`src/lib/logger.ts` is **on disk**. Its API differs from the sketch in
`09-deployment-and-testing.md` §5.1 — the implemented shape is event-first
positional, not a single field object:

```ts
// src/lib/logger.ts (on disk)
export type LogContext = {
  requestId?: string; jobId?: string; workspaceId?: string; userId?: string
  [key: string]: unknown
}

export const logger = {
  debug(event: string, ctx?: LogContext): void
  info (event: string, ctx?: LogContext): void
  warn (event: string, ctx?: LogContext): void
  /** The throwable is a separate parameter so the stack is captured, not stringified. */
  error(event: string, error?: unknown, ctx?: LogContext): void
  child(base: LogContext): { debug; info; warn; error }
}
```

So a service writes `logger.info('lead.created', { workspaceId, leadId })` and a
failure writes `logger.error('mailbox.sync.failed', err, { mailboxId })` — not
`log.info({ event: … })`. Redaction is a key-name deny-list applied at up to four
levels of depth, and it already covers `body`, `html`, `htmlBody`, `textBody`, so an
email body passed as one of those keys is redacted automatically. It is **not**
covered if you interpolate it into the event name or a differently-named field.

The event taxonomy is `09` §5.2. This section adds the backend-specific parts:
per-module event ownership, and where correlation ids come from.

### 13.1 Correlation

| Process | Id | Source |
|---|---|---|
| web request / action | `requestId` | `x-request-id` inbound header, else `crypto.randomUUID()`; held in `AsyncLocalStorage` (`src/server/request-context.ts`, per `09` §5.1) |
| job attempt | `jobId` | `Job.id`; `logger.child({ jobId, jobType, attempt })` per attempt |
| link between them | — | see §17.6: `09` §5.1 specifies a `Job.enqueuedByRequestId` column that does not exist in the schema |

Note `Ctx` as `07` §9.1 defines it carries **no `requestId`** — it holds `userId`,
`workspaceId`, `role`, `sessionId`, `timezone`. So a service that wants the
correlation id reads it from `request-context.ts`, not from its `Ctx` parameter, and
in the worker there is no request context at all — the job's `logger.child` is
passed down explicitly. Do not add `requestId` to `Ctx` to avoid this: `Ctx` is the
tenancy carrier and widening it invites widening it again.

Until `enqueuedByRequestId` exists, a send is traceable to its click through
`Job.payload.scheduledEmailId` → `ScheduledEmail.id`, which appears in the action
log line. Workable, one hop longer.

### 13.2 Per-module event names

Dotted `domain.subject.verb`, **stable** — dashboards and alerts key on these
strings, so a rename is a breaking change. Each module owns its prefix and no other
module emits it.

**Ownership, and why the table below has holes.** `09` §5.2 owns the cross-cutting
taxonomy, and `06` §13 owns the `job.*`, `send.*`, `cap.*`, `window.*`, and
`enrollment.*` names — with concrete spellings that differ from an earlier draft of
this section (`job.dead` not `job.dead_lettered`, `job.retry` not `job.failed`,
`send.accepted` not `send.succeeded`, `send.blocked` / `send.deferred` /
`send.unknown_outcome` / `send.reconciled`). **Those two docs win**; the rows below
for `jobs` and `sending` point at them rather than restating a competing list, since
two spellings for one event is worse than one imperfect spelling.

| Module | Events it owns |
|---|---|
| `auth` | `auth.login.succeeded` · `auth.login.failed{reason}` · `auth.logout` · `auth.register.succeeded` · `auth.session.revoked` · `auth.session.slid` · `auth.password.reset_requested` · `auth.password.reset_completed` · `auth.account.locked{failedCount}` |
| `workspace` | `workspace.created` · `workspace.switched` · `workspace.settings.updated` · `workspace.member.invited` · `workspace.member.joined` · `workspace.member.role_changed{from,to}` · `workspace.member.suspended` · `workspace.invite.expired` · `authz.denied{required,actual}` · `authz.cross_workspace_attempt{requestedId}` **always warn** |
| `mailboxes` | `mailbox.oauth.started` · `mailbox.oauth.callback_failed{reason}` · `mailbox.connected` · `mailbox.disconnected{reason}` · `mailbox.token.refreshed` · `mailbox.token.refresh_failed{status}` · `mailbox.sync.started` · `mailbox.sync.completed{messages,durationMs}` · `mailbox.sync.failed{reason}` · `mailbox.cursor.expired` · `mailbox.watch.renewed` · `mailbox.watch.expired` · `mailbox.throttled{until}` |
| `leads` | `lead.created{source}` · `lead.updated` · `lead.deleted{count}` · `lead.imported{rows,accepted,rejected}` · `lead.import.rejected_row{rowNumber,reason}` · `lead.unsubscribed{source}` · `lead.suppressed{reason,scope}` · `lead.bulk.queued{operation,affected}` · `lead.export.streamed{rows}` |
| `sequences` | `sequence.step.created{type,position}` · `sequence.step.updated` · `sequence.step.deleted` · `sequence.reordered` · `sequence.version.bumped{from,to}` · `sequence.variant.added{label}` · `sequence.render.failed{missingToken}` |
| `campaigns` | `campaign.created` · `campaign.launched` · `campaign.resumed` · `campaign.completed` · `campaign.archived` · `campaign.enrolled{leads,skipped,suppressed}` · `campaign.enroll.skipped{reason}` · `campaign.tick.completed{advanced,materialised,durationMs}` — plus `campaign.paused{actor,cancelledRows,cancelledJobs}` and `enrollment.stopped{stopReason,atPosition}`, both owned by `06` §13 |
| `sending` | **owned by `06` §13**: `send.claimed` · `send.blocked{stopReason}` · `send.deferred{reason}` · `send.accepted{providerMessageId}` · `send.failed{errorClass,providerStatus,permanent}` · `send.unknown_outcome` **pages** · `send.reconciled{verdict}` · `send.duplicate_detected` **pages** · `cap.reserved` / `cap.exhausted` · `mailbox.throttled_by_provider` |
| `inbox` | `inbox.thread.created` · `inbox.message.stored{direction}` · `inbox.reply.sent` · `inbox.thread.archived` · `inbox.search.completed{durationMs,results}` |
| `replies` | `reply.detected{kind}` · `reply.attributed{campaignLeadId}` · `reply.unattributed{reason}` · `reply.sequence_stopped{stepsCancelled}` · `bounce.recorded{kind}` · `bounce.suppressed{email}` · `webhook.received{provider}` · `webhook.unmatched{providerEventId}` |
| `analytics` | `analytics.event.recorded{type}` · `analytics.event.deduped{dedupeKey}` · `analytics.rollup.completed{workspaceId,day,durationMs}` · `analytics.counter.drift_detected{table,column,delta}` · `analytics.open.bot_filtered` |
| `ai` | `ai.request{model,purpose}` · `ai.response{model,tokensIn,tokensOut,durationMs}` · `ai.failed{model,reason}` · `ai.output_invalid{model,purpose}` **error** · `ai.prefilter.decided{label}` · `ai.budget.exceeded{workspaceId}` |
| `crm` | `crm.opportunity.created{stage}` · `crm.opportunity.stage_changed{from,to}` · `crm.opportunity.won{value,currency}` · `crm.opportunity.lost{reason}` · `crm.task.created` · `crm.task.completed` · `crm.note.added` |
| `deliverability` | `dns.checked{domain,spf,dkim,dmarc,mx}` · `dns.lookup_failed{domain,error}` · `deliverability.score.updated{mailboxId,score}` |
| `warmup` | `warmup.ramp.advanced{mailboxId,day,target}` · `warmup.send.queued` · `warmup.paused{reason}` |
| `jobs` | **owned by `06` §13**: `job.leased{attempt,priority}` · `job.succeeded{durationMs}` · `job.deferred{reason,untilMs}` · `job.retry{attempt,maxAttempts,errorClass}` · `job.dead{attempt,errorClass}` **error** · `job.lease_lost` **error** · `job.lease_reclaimed{count}` · `job.replayed{actor,replayCount}` · plus `worker.*` |
| `src/server/` | `action.invoked{name}` · `action.rejected{name,code}` · `http.request.completed{method,path,status,durationMs}` · `ratelimit.exceeded{key,limit}` |

Levels: `debug` per-item detail · `info` facts (including `send.deferred` and
`job.deferred` — a closed sending window is normal, not a problem) · `warn`
handled-but-notable (`job.retry`, `authz.denied`, `authz.cross_workspace_attempt`,
`provider.rate_limited`, every `action.rejected` carrying an `AppError`) · `error` a
human should look (`job.dead`, `send.unknown_outcome`, `mailbox.sync.failed`,
`ai.output_invalid`, `analytics.counter.drift_detected`, and every throw that is not
an `AppError`).

The `isAppError(e)` test in §6.1 is exactly the warn/error boundary: a modelled
outcome is `warn`, an unmodelled one is a bug and is `error`.

### 13.3 Logging rules specific to services

1. **A service logs facts; it does not log its own throws.** The `action()` /
   route wrapper logs the rejection once, with the code and the stack. A service
   that also logs produces two lines for one failure and doubles the noise on every
   dashboard. `requireCan` already emits `authz.denied` itself (see
   `src/server/authz.ts`), so a service must not log a denial on top of it.
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

> **Ownership note.** `07-auth-and-security.md` §14 owns the limiter: the
> `RateLimit` model, the single-statement upsert, `consume()`, the fixed-window
> choice, fail-open behaviour, and every auth limit. This section states only
> where limiting sits relative to modules, and the limits for the surfaces `07`
> does not cover.

### 14.1 The limiter, as `07` §14 fixes it

```ts
// src/lib/rate-limit.ts — owned by 07-auth-and-security.md §14.2
export type RateLimitRule = { bucket: string; limit: number; windowMs: number }
export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSeconds: number; limit: number; resetAt: Date }

/** `identity` is already-composed, e.g. `ip:203.0.113.7` or `user:cuid`. */
export async function consume(rule: RateLimitRule, identity: string): Promise<RateLimitResult>
```

The window is **in the primary key**
(`"<bucket>:<identity>:<windowStartEpochSeconds>"`), which is what makes the whole
limiter one atomic upsert with no read-modify-write. Fixed window, accepted 2×
boundary burst, fail-open on limiter error. `MAINTENANCE` deletes closed windows.

### 14.2 Placement

```
                            ┌── login, register, password reset  → IP + email   (07 §14)
   Server Action ──────────▶│   invite send                       → workspace    (07 §14)
   action() step 2          │   CSV import commit                 → workspace
                            │   AI generate / regenerate          → workspace + message
                            └── bulk ops                          → workspace

                            ┌── /api/oauth/google/start           → user
   Route handler ──────────▶│   /api/leads/import                 → workspace
   before reading the body  │   /api/leads/export                 → workspace
                            └── /api/track/*, /api/unsubscribe/*  → IP, generous

   Job handler ────────────▶  NOT rate limited. Bounded by worker concurrency,
                              per-mailbox pacing (minSecondsBetweenSends +
                              sendJitterSeconds), and daily caps
                              (MailboxDailyStat). That is pacing, not rate
                              limiting, and it lives in modules/sending.
```

**Rate limiting sits at the trust boundary, inside the wrapper — never in a
service.** Two reasons, both structural: a service called from the worker must not
consume a user's HTTP budget, and a service called twice within one action must not
count twice. A `rateLimit` rule is therefore a property of an *action or route*, not
of a domain operation.

It sits **before** parsing (`07` §13.1 step 2) so a flood of malformed payloads
cannot burn CPU on zod, which also means a rule's `identity` cannot reference a
validated input field. Compose identity from `ctx` and route params only.

### 14.3 The non-auth limits

`07` §14.3–14.4 set the auth limits (login, register, reset, invite). These are the
rest, all keyed by workspace or user because every caller is authenticated:

| Surface | bucket · identity | limit | window | Rationale |
|---|---|---|---|---|
| `POST /api/leads/import` | `leads.import` · `ws:<id>` | 5 | 1 h | each is up to 50k rows |
| `GET /api/leads/export` | `leads.export` · `ws:<id>` | 5 | 1 h | matches `07` §7's `export:workspace → 5/hour`; one export is the whole commercial asset |
| `leads.bulk*` | `leads.bulk` · `ws:<id>` | 30 | 1 h | each may enqueue thousands of jobs |
| `leads.create` | `leads.create` · `ws:<id>` | 120 | 1 min | a sane ceiling, not a real constraint |
| `POST /api/oauth/google/start` | `oauth.start` · `user:<id>` | 10 | 10 min | signed-state flooding |
| `ai.*` generate | `ai.generate` · `ws:<id>` | 100 | 1 h | real money; `modules/ai/budget.ts` also enforces spend |
| `ai.regenerate` | `ai.regenerate` · `msg:<id>` | 5 | 1 h | matches `08` §2210 |
| `campaigns.launch` | `campaigns.launch` · `ws:<id>` | 20 | 1 h | launch is cheap but audit-logged and irreversible in effect |
| `GET /api/track/*` | `track` · `ip:<addr>` | 600 | 1 min | generous: one recipient's client may fetch many pixels |

Two are per-resource rather than per-workspace (`ai.regenerate` on a message,
`oauth.start` on a user) because the abuse they prevent is per-resource; using a
workspace key there would let one user exhaust a colleague's budget.

### 14.4 What rate limiting is not for

**Gmail's quotas are not rate limiting, and they are not ours to enforce by
counting.** Gmail's real limits are a *rolling* window — roughly 2,000 messages/day
for Workspace and 500 for consumer accounts, plus undocumented per-minute and
per-recipient throttles — enforced server-side and exposed by no API. Our
`EmailAccount.dailySendLimit` default of **50** is a courtesy limit set far below
Gmail's, chosen for deliverability rather than to dodge a 429.

Consequences already in the schema and design:

- `EmailAccount.minSecondsBetweenSends` (90) and `sendJitterSeconds` (120) exist so a
  mailbox does not emit a machine-regular burst. `06` §16.1 notes these cannot be
  enforced under concurrency without a `nextSendAt` column — see §17.11.
- `MailboxDailyStat` per local day exists so the cap check is one indexed read inside
  the claim, not a `COUNT` over `ScheduledEmail`.
- A `quotaExceeded` from Gmail is **authoritative and terminal for that mailbox for
  the rest of the day**: `EmailAccount.status = THROTTLED` with `throttledUntil`, and
  the scheduler skips it (that is what `@@index([status, throttledUntil])` is for).
  We do not retry into a quota wall; retrying makes reputation worse.
- **Timezone and DST bite here.** "Today" for a cap is the mailbox's local date
  (`MailboxDailyStat.localDate`, derived from `EmailAccount.timezone`). A
  spring-forward day is 23 hours of wall clock but still one calendar date, and a
  fall-back day is 25 — which is the behaviour operators expect, and why the schema
  stores an IANA zone string rather than a fixed offset. A stored offset would be
  wrong twice a year in a way nobody notices until a send lands at 03:00. Window
  arithmetic lives in `modules/sending/windows.ts` and is unit-tested against both
  transitions.

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

`JobType` values are the schema's `SCREAMING_SNAKE` enum members
(`SEND_SCHEDULED_EMAIL`, `SCHEDULER_TICK`, `PROCESS_INBOUND_MESSAGE`, …), not dotted
strings — `Job.type` is a Prisma enum column, so a free-form string is not storable.
An earlier draft of `06` used a dotted union; its §0 has since adopted the enum, so
the two documents agree and there is nothing here for the lead to resolve. The one
value `06` needs and the enum lacks is `RECONCILE_SEND` (§17.11).

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

Every item was grepped against `prisma/schema.prisma` or a sibling doc as of
**2026-08-31**, not inferred from prose. Sibling docs were being revised
concurrently with this one, so two things already resolved themselves and are
recorded here only so nobody re-raises them:

- `06-jobs-and-sending-engine.md` added a §0 ("Conformance to the committed
  schema") and now follows the schema's `Job.state` / `attempt` / `dedupeKey` /
  `priority DESC` naming throughout.
- `07-auth-and-security.md` §21 independently enumerates the auth-side schema gaps.
  Where it and this section overlap, **`07` is the owner** and this section defers
  rather than restating — a gap listed twice with two different recommendations is
  worse than one listed once.

What follows is what remained after both passes.

### 17.1 `RateLimit` table does not exist — blocking, owned by `07` §21.1

§14 of this document and `07` §14.1 both require it; brief §6 mandates the
limiting it implements. Grep: no such model in the schema, and Redis is rejected by
brief §2.

**`07` §21.1 owns this item and its model definition** (`key` as the primary key
with the window embedded, `count`, `expiresAt`, `@@index([expiresAt])`). Recorded
here only because §14.2's placement rules are unimplementable without it, and
because it has one consequence in this document's territory: `MAINTENANCE` gains a
`DELETE FROM "RateLimit" WHERE "expiresAt" < now()` sweep, which is the seventh
cross-workspace function in §4.4's enumerated list — except it touches no tenant
data at all, so it needs no `*AcrossWorkspaces` suffix.

Note the earlier draft of this document proposed a two-column composite key
(`@@id([key, windowStart])`). **`07`'s single-column form is better** and is the one
to build: putting the window *inside* the key string makes the limiter one upsert
against a primary key with no composite-key handling, and makes the sweep a single
indexed range delete.

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

### 17.4 `Job.dedupeKey`: one consequence of the unconditional unique — not blocking

Schema: `@@unique([dedupeKey])`, globally and for the row's whole lifetime. `06` §0
accepts this explicitly ("There is no 'unique among outstanding rows' escape hatch")
and designs around it: every repeatable key embeds a period bucket, and `06` §7.3's
`replay` **resets the original row in place** (`UPDATE … SET state='PENDING',
attempt=0, replayCount=replayCount+1 WHERE state='DEAD'`) rather than cloning it,
"because `dedupeKey` is globally unique and a clone would collide".

That resolution is coherent and this document follows it. The residual sharp edge,
recorded so it is a known limit rather than a surprise: **for a key with no time
bucket, the work can never be enqueued a second time.** `MAILBOX_SYNC:{id}:{historyId}`
is the case — once that row exists, only replay-in-place can re-run it, and if the row
has been pruned (`MAINTENANCE` deletes terminal jobs after 30 days) the key is
unreachable and a re-sync of that history id is impossible. In practice Gmail expires a
`historyId` in about a week, well before the prune, so the window where this matters is
empty. Stated because "it works because two retention periods happen to be ordered
correctly" is worth writing down.

**Recommendation: keep the unconditional unique** — it is simpler, `06` has designed
around it, and a partial unique index would need `ON CONFLICT`'s predicate to match
the index text exactly, which is a footgun in migration SQL. Document the rule as
"recovery from `DEAD` is replay, never re-enqueue." If a future job type genuinely
needs key reuse after a terminal state, that is when to switch to a partial index
(`WHERE state IN ('PENDING','RUNNING','RETRYING')`, per schema header note 4).

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
| `EmailEvent.bounceKind`, `.mailboxId` | 2 / 8 | bounce detail lives on `EmailMessage.bounceType`/`bounceCode`; the event FK is `emailAccountId` |
| `Lead.importBatchId` | 2 | `Lead.leadImportId` |

Every one of these appears inside runnable SQL — the six §5.4 metrics queries and
the §3.5 restore-verification script — so all of it fails on contact with the real
database. **Recommendation: mechanical rename pass over `09`, schema wins.**

`09`'s `MailboxCredential.keyVersion` (4 occurrences) is the same class of drift but
is **already owned by `07` §21.3**, which resolves it in the schema's favour and
lists the two concrete consequences. Not restated here.

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

### 17.9 `03-frontend.md` §3.5's nav-badge cache is banned by `07` §10.5

`03` §3.5 specifies caching the nav badges / sending meter with `unstable_cache`
"for 60s keyed by workspace". `07` §10.5 bans `unstable_cache` and `"use cache"`
outright for any tenant-scoped read, and `07` §20 item 6 ranks a mis-keyed cache as
the highest-severity leak available to us — it defeats every query-level isolation
test because the query never re-runs.

The two are not reconcilable by being careful: the ban is categorical precisely
because "keyed by workspace" is easy to say and easy to get wrong (a closure over
`ctx.workspaceId` produces one entry serving every tenant, and it looks correct).

**Recommendation: uphold `07`'s ban and drop the cache.** `03` §3.5's own budget is
the right answer and it says so: keep the badges to three indexed counts, and "if
this budget is ever exceeded, the fix is to drop a badge, not to add caching
layers." §11.2 of this document is written to the ban. An earlier draft of this
section proposed the same cache plus a `CustomFieldDefinition` one; both are
withdrawn.

### 17.10 Two module-surface additions

From §2.5, repeated so the lead sees them in one list:

- **`dashboard` is a sixteenth module** (L7, read-only, owns no table), needed by
  `03` §4's seven `dashboard.*` calls. Folding them into `analytics` would make
  `analytics` depend on six modules and break §2.4(b)'s cycle resolution.
- **`suppressions` is not a module.** `03` §2's `suppressions.describeToken` maps
  to `leads.describeSuppressionToken`; `Suppression` is a leads-domain table.

### 17.11 Open requests from `06` that this document depends on

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

### 17.12 One thing that is settled and must not be re-litigated

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
