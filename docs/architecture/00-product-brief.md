# Instant Mail — Product Brief & Locked Architectural Decisions

> **Status:** authoritative. This document is the shared contract for all
> contributors. Domain architecture docs elaborate on it; they must not
> contradict it. Contradictions are resolved by the lead engineer, not by
> silently diverging.

---

## 1. What we are building

An **end-to-end cold email outreach platform** — a system that takes a list of
leads, runs them through multi-step personalised email sequences from real
mailboxes, detects replies, stops sequences automatically, classifies replies
with AI, and turns positive replies into CRM opportunities.

This is an **original implementation**. We reproduce *product capabilities*.
We copy no proprietary code, assets, branding, or UI from any existing vendor.

### The core loop, end to end

```
Lead → Campaign → Sequence → Scheduler → Queue → Worker → Provider → Recipient
                                                                          │
Analytics ← CRM/Tasks ← AI Classification ← Inbox ← Reply/Bounce/Tracking ─┘
```

Every architectural decision is judged by one question: **does it make this
loop work reliably without a human watching it?**

### Non-negotiable product invariants

1. **Campaigns run with no browser open.** Sending is driven by a standalone
   worker process, never by a client-side timer or an open tab.
2. **A reply stops the sequence.** Detecting a human reply halts all future
   steps for that lead in that campaign, promptly and idempotently.
3. **We never send the same email twice.** Every send is idempotent under
   retry, worker restart, and concurrent workers.
4. **We never send outside the allowed window or over the daily cap.** Limits
   are enforced per mailbox, in the mailbox's/campaign's timezone.
5. **AI drafts; humans send.** AI never autonomously sends a substantive reply
   by default.
6. **Workspace isolation is absolute.** No query may return another
   workspace's data, regardless of what the client asks for.

---

## 2. Locked stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime / package manager | **Bun** (1.4.x) | also the test runner (`bun test`) |
| Framework | **Next.js (App Router)** + **React** | RSC-first |
| Language | **TypeScript**, `strict: true` | no `any` in committed code |
| Database | **PostgreSQL 16** | single primary, no sharding |
| ORM | **Prisma** | sole DB access path |
| Styling | **Tailwind CSS** | tokens via CSS variables |
| Components | **shadcn/ui**, restyled to our design system | vendored + owned, not a black box |
| Icons | **Lucide** | |
| Validation | **zod** | every trust boundary |
| Forms | **react-hook-form** + zod resolver | |
| E2E tests | **Playwright** | see justification below |

### Justified additions beyond the mandated stack

Only these. Anything further requires lead approval with a written reason.

- **zod** — required to satisfy the input-validation mandate; TypeScript types
  vanish at runtime, so a runtime validator is not optional.
- **react-hook-form** — accessible form state/error wiring; hand-rolling it
  reliably across ~20 forms is more code and worse a11y.
- **Playwright** — the mandated E2E suite needs a real browser driver. Bun's
  test runner cannot drive a browser.
- **googleapis** (official Google SDK) — hand-rolling Gmail OAuth token
  refresh and API pagination is security-sensitive, high-risk boilerplate.
- **@t3-oss/env-nextjs** *(optional, small)* — fail-fast typed env parsing.
  Acceptable to implement in ~40 lines of zod instead; implementer's call.

### Explicitly rejected

- **Redis / BullMQ / SQS** → the queue lives in Postgres (see §5). One
  datastore, transactional enqueue, no extra infrastructure.
- **Docker for local dev** → unavailable in this environment (no daemon, no
  root). Local Postgres runs as a user-space cluster on port **5433**.
- **NextAuth / Auth.js** → our login and our *mailbox OAuth* are distinct
  concerns, and Auth.js's account model fights the mailbox model. We own a
  small, auditable session layer instead (§6).
- **Microservices** → modular monolith with hard internal seams, extractable
  later.
- **A client-side data-fetching library** (TanStack Query, SWR) → RSC +
  server actions + `revalidatePath` cover our needs. Revisit only if the
  inbox demands it, with a written reason.

---

## 3. Repository layout

```
src/
  app/
    (marketing)/              # public landing
    (auth)/                   # login, register, accept-invite
    (app)/                    # authenticated shell — sidebar + header
      dashboard/  inbox/  leads/  campaigns/  mailboxes/
      crm/  analytics/  ai/  deliverability/  settings/
    api/
      oauth/google/           # mailbox connect + callback
      webhooks/gmail/         # Pub/Sub push notifications
      worker/tick/            # authenticated queue drain trigger
      leads/import|export/    # CSV streaming
  components/
    ui/                       # design-system PRIMITIVES (Button, Input, ...)
    patterns/                 # COMPOSITES (DataTable, EmailThread, ...)
  modules/                    # ← domain logic; the monolith's seams
    auth/ workspace/ mailboxes/ inbox/ leads/ campaigns/ sequences/
    sending/ replies/ crm/ analytics/ ai/ deliverability/ warmup/ jobs/
  lib/                        # cross-cutting: env, db, crypto, logger, errors, result, time
  server/                     # server-only: session, guards, action wrapper
worker/                       # standalone Bun worker entrypoint
prisma/                       # schema.prisma, migrations/, seed.ts
tests/                        # unit/ integration/ e2e/
docs/architecture/
scripts/                      # db.sh (user-space cluster), etc.
```

### Module anatomy — every folder in `src/modules/*` follows this shape

```
modules/<domain>/
  index.ts        # PUBLIC API. The only file outsiders may import.
  service.ts      # business logic, orchestration, invariants
  repo.ts         # the ONLY place Prisma is touched for this domain
  schema.ts       # zod schemas for this domain's inputs
  types.ts        # domain types (not Prisma types leaked outward)
```

### Import rules (enforced by lint + review)

1. `app/**` and `components/**` may import a module **only** via
   `modules/<d>/index.ts`. Never `service.ts`, never `repo.ts`.
2. **Prisma is importable only from `modules/*/repo.ts`, `prisma/`, and
   `lib/db.ts`.** No Prisma calls in route handlers, pages, or components.
3. `components/ui/**` is pure presentation: no data fetching, no module
   imports, no server-only code.
4. Modules may depend on other modules only through public APIs, and the
   dependency graph must stay acyclic. Shared low-level needs go to `lib/`.
5. Anything reading a secret must be server-only. Any file touching secrets
   imports `server-only` as a guard.

---

## 4. Multi-tenancy — the single most important invariant

```
Workspace ─┬─ WorkspaceMember ── User
           └─ every tenant-owned resource
```

**Rules, no exceptions:**

1. Every tenant-owned table carries a non-null `workspaceId`.
2. `workspaceId` is resolved **server-side** from the session. A
   `workspaceId` arriving in a request body, query string, or hidden form
   field is ignored — and treated as suspicious.
3. Every service entrypoint takes an auth context as its first parameter:
   ```ts
   type Ctx = { userId: string; workspaceId: string; role: Role };
   ```
4. Every repo read/write filters or sets `workspaceId` from that ctx. A repo
   function that can't name its workspace scope is a bug.
5. Cross-workspace access attempts return **404, not 403** — we do not
   confirm the existence of other tenants' resources.
6. Unique constraints on tenant data are scoped: `@@unique([workspaceId, …])`,
   never bare-global.

---

## 5. Background processing — locked design

**Postgres-backed queue.** A `Job` table drained by a standalone Bun worker
using `SELECT … FOR UPDATE SKIP LOCKED`.

Why: transactional enqueue (a job and the row that caused it commit together
— no dual-write drift), one datastore to operate, and durability by default.
The cost is polling latency, which is irrelevant for a system whose units of
work are minutes-to-days apart.

```
Campaign (active)
   → Scheduler tick    : materialises ScheduledEmail rows from sequence steps
   → Queue (Job table) : durable, delayed, deduplicated by idempotency key
   → Worker (Bun)      : leases with SKIP LOCKED, bounded concurrency
   → Provider adapter  : Gmail today; SMTP/Outlook later
   → EmailEvent        : append-only fact log powering analytics
```

Required properties, to be designed in detail by the jobs architecture doc:
durable delayed jobs, bounded retries with exponential backoff + jitter, a
dead-letter state, **idempotency keys**, per-mailbox rate limiting, global
concurrency control, daily caps, sending windows with timezone awareness,
lease expiry so a crashed worker's jobs recover, and structured observability.

The worker is a separate process (`bun run worker`) — deployable as its own
container/service. An authenticated `/api/worker/tick` endpoint exists so a
serverless cron can also drive it.

---

## 6. Authentication, authorization, security — locked baselines

- **Login:** email + password. Hashing via `Bun.password` (**argon2id**).
- **Sessions:** opaque 256-bit random token in an `httpOnly`, `SameSite=Lax`,
  `Secure` (prod), path-`/` cookie. Only a **SHA-256 hash** of the token is
  stored in Postgres. Sliding refresh with an absolute lifetime cap.
  Server-side revocation must be possible.
- **Authorization:** roles `OWNER | ADMIN | MEMBER`. Enforced server-side in
  service functions — never in the UI alone. The UI hides what a user cannot
  do; the server is what actually stops them.
- **Mailbox OAuth ≠ login.** Connecting a Gmail mailbox is a workspace
  resource action, not an identity action. Distinct flows, distinct tables.
- **Secrets at rest:** OAuth refresh tokens and SMTP passwords are encrypted
  with **AES-256-GCM** using `ENCRYPTION_KEY`, with a key-version column to
  permit rotation. Plaintext refresh tokens never leave the server, never
  appear in logs, and never reach a client component.
- **CSRF:** mutations go through Server Actions or same-origin POST with
  origin checks. State-changing GETs are forbidden.
- **OAuth CSRF:** signed, single-use, short-TTL `state` parameter.
- **Input validation:** zod at every boundary — actions, route handlers,
  webhooks, CSV rows.
- **Rate limiting:** login, invite, CSV import, AI calls, and OAuth start.
- **Audit log:** append-only record of security-relevant events (login,
  mailbox connect/disconnect, campaign launch, bulk delete, member changes).
- **File handling:** CSV imports are streamed with a size cap, a row cap, and
  formula-injection-safe export escaping.
- **Webhooks:** verified before trust; unauthenticated payloads are data, not
  instructions.

---

## 7. Design system — locked tokens

The aesthetic: **minimalist editorial SaaS with a premium, luxury feel.**
Off-white ground, deep-navy type, high-contrast serif headlines against clean
sans-serif UI, generous whitespace, hairline borders, soft shadows, pill
primary actions, Apple-like restraint.

It should read as *editorial publication meets premium SaaS* — never as a
generic startup dashboard, and never as a template with random charts.

### Typography

| Role | Family | Usage |
|---|---|---|
| Display / headline | **Instrument Serif** | page titles, big numbers, marketing |
| UI / body | **Inter** | all interface text, tables, forms |
| Mono | **JetBrains Mono** | technical values: DNS records, IDs, code |

Loaded via `next/font` (self-hosted, no layout shift). Three families is the
ceiling. Restrained weights: display 400 only; UI 400/500/600 — **no 700+ in
UI chrome.** Serif is for headlines and hero metrics, *not* for labels,
buttons, table headers, or dense UI.

### Colour — CSS variables, semantic names only

```css
--bg:            #FBFAF8;  /* warm off-white ground — never pure #FFF */
--bg-subtle:     #F5F3EF;  /* recessed areas, table header fills */
--surface:       #FFFFFF;  /* raised cards/panels ON the off-white ground */
--ink:           #0F1E37;  /* deep navy — primary text */
--ink-secondary: #43526B;  /* secondary text */
--ink-muted:     #7A879B;  /* meta, timestamps, placeholders */
--border:        #E6E2DA;  /* hairline, warm — the default separator */
--border-strong: #D2CCC1;
--accent:        #1B3A6B;  /* navy accent — primary actions */
--accent-hover:  #16305A;

/* status — muted, editorial, never neon */
--success: #2F6F4F;   --warning: #9A6B1F;
--danger:  #A03A32;   --info:    #2C5A8A;
```

Rules: components consume **semantic variables only**, never raw hex. No
gradients as decoration. No purple/blue "AI SaaS" gradient. No neon. Dark
mode is out of scope for v1 — but every token must be defined so it can be
added without touching components.

### Shape, depth, motion

- Radii: `sm 6px` · `md 10px` · `lg 14px` · `pill 999px`.
  Pill is for **primary actions and filter chips only**. Tables, inputs, and
  panels stay architectural. Do not round everything.
- Borders are hairline `1px` and do most of the separation work.
- Shadows are barely-there: `0 1px 2px rgb(15 30 55 / 0.04)` at rest,
  `0 4px 16px rgb(15 30 55 / 0.08)` for overlays. No glow, no coloured shadow.
- Spacing follows a 4px scale; **whitespace is a feature.** Page gutters are
  generous, tables breathe (44–52px rows), sections are separated by space
  before rules.
- Motion: 120–200ms, `ease-out`, opacity/transform only. Respect
  `prefers-reduced-motion`. Nothing bounces.

### Accessibility — a hard gate, not a nice-to-have

Semantic HTML first. Visible focus rings on every interactive element (never
`outline: none` without a replacement). Body text ≥ 4.5:1 contrast, large
text ≥ 3:1. Full keyboard operability including the sequence builder and
inbox. Correct labels, `aria-live` for async results, focus trapping and
restoration in dialogs. Icon-only buttons always carry an accessible name.
Never encode meaning in colour alone — pair it with text or an icon.

---

## 8. Frontend conventions

- **Server Components by default.** `"use client"` only for genuine
  interactivity, pushed as far down the tree as possible.
- **Mutations = Server Actions**, wrapped in a shared `action()` helper that
  authenticates, authorizes, validates with zod, and returns a typed result.
  No unvalidated action bodies.
- **No fake functionality.** A UI element that appears to work must work. If
  a feature is not built, render an honest empty/disabled state that says so.
- **Every async surface ships five states:** loading (skeleton, not a
  spinner-only screen), empty (with a next action), success, error (with
  retry), and unauthorized. Plus disconnected and rate-limited where they
  apply. A blank screen is a bug.
- **URL is state** for list views: filters, sort, page, and search live in
  search params so views are shareable and back/forward works.
- Tables are server-paginated. No unbounded client-side lists.
- Desktop-first (this is a productivity tool) but genuinely usable down to
  tablet; the inbox degrades to a list→detail push view on narrow screens.

---

## 9. Code conventions

- Files `kebab-case.ts`; React components `PascalCase` in `kebab-case.tsx`.
- Named exports; default exports only where Next.js requires them.
- Expected failures return a typed `Result<T, E>`; unexpected failures throw
  `AppError` subclasses. Never swallow an error into a bare `null`.
- Money-free domain, but all time is stored **UTC** and rendered in the
  viewer's or campaign's timezone. Never persist a local timestamp.
- Structured logging (`{ level, event, workspaceId, jobId, … }`) — no
  `console.log` in committed code, and **never log secrets or full email
  bodies**.
- Comment *why*, not *what*. Match surrounding density; no narration.
- Prisma migrations are committed, forward-only, and reviewed for locks.

---

## 10. Analytics & AI boundaries

- **`EmailEvent` is an append-only fact log** (`QUEUED, SENT, DELIVERED,
  BOUNCED, OPENED, CLICKED, REPLIED, UNSUBSCRIBED, FAILED, COMPLAINED`).
  All metrics derive from it. Counters on parent rows are caches, never truth.
- **Honesty in reporting.** Open tracking is pixel-based and blocked by many
  clients; it is labelled as indicative, never as fact. We make no claims
  about inbox-vs-spam placement, which we cannot observe.
- **No conclusions from tiny samples.** Comparative insights ("step 2
  underperforms step 1") require a minimum sample and are surfaced with the
  sample size attached. Suppress the claim rather than mislead.
- **AI is assistive.** Classification, summaries, draft replies,
  personalisation, lead scoring. Outputs are structured, validated, stored
  with model + version + confidence, and always attributed as AI-generated.
  A human approves before a substantive reply goes out.

---

## 11. Development strategy

**Build vertical slices.** Never build a page whose backend does not exist.
Each slice runs DB → module → API/actions → UI → tests, and is verified before
the next begins.

Order (dependency-driven, adjusted from the original brief so auth and the
design system land before anything that depends on them):

| Phase | Slice |
|---|---|
| 0 | Architecture *(this phase)* |
| 1 | Foundation: app, Prisma, auth, workspace, shell, design system |
| 2 | Mailboxes: Gmail OAuth, encrypted tokens, sync, message storage |
| 3 | Inbox: threads, messages, search, filters, reply, archive |
| 4 | Leads: CRUD, CSV import/export, lists, tags, filters, profiles |
| 5 | Campaigns: creation, lead assignment, sequence builder, personalisation |
| 6 | Sending engine: scheduler, queue, workers, limits, retries, idempotency |
| 7 | Reply automation: detection, association, sequence stop, timeline |
| 8 | Analytics: events, campaign/sequence/mailbox reporting |
| 9 | CRM: pipeline, opportunities, tasks, notes |
| 10 | AI: classification, summaries, suggestions, personalisation, scoring |
| 11 | Advanced: A/B testing, Outlook, SMTP, deliverability, warmup, API, billing |

### Definition of done — every phase

Type check clean · lint clean · tests pass · migrations apply from scratch ·
no secret committed · all five UI states present · workspace isolation
verified on new queries · reviewed · committed with a meaningful message ·
pushed. "It compiles" is not done.

---

## 12. Local environment (this machine)

No Docker daemon and no root, so:

- Postgres runs as a **user-space cluster** (`initdb`/`pg_ctl`) on port
  **5433**, managed by `scripts/db.sh`, with its data in `.pgdata/`
  (gitignored). Verified working.
- Bun is installed at `~/.bun/bin/bun`.
- Secrets live only in `.env` (gitignored). `.env.example` documents every
  variable by name with no values.
