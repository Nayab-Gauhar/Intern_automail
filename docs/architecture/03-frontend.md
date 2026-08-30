# 03 — Frontend Architecture

> **Status:** design. Subordinate to `00-product-brief.md`; where this document
> and the brief disagree, the brief wins and this document is the bug.
>
> **Scope:** the route tree, navigation model, the four hard surfaces
> (Dashboard, Inbox, Sequence Builder, Leads), the component inventory,
> URL-as-state, optimistic-update policy, responsive strategy, and the
> accessibility gate.
>
> **Out of scope:** the Prisma schema (owned by the data-model doc), the queue
> and scheduler (jobs doc), module service internals (domain docs). Where this
> document names a query it names the **module function** it calls; SQL is
> shown as *indicative* and the data-model doc is authoritative on table and
> column names.

---

## 1. Ground rules this document inherits

Restated because every section below depends on them:

1. **RSC by default.** `"use client"` appears only on a leaf that needs
   interactivity, state, or a browser API. A page is never a client component.
2. **Mutations are Server Actions** through the shared `action()` wrapper
   (auth → authorize → zod → typed `Result`). No `fetch()` from a component to
   our own API.
3. **No client data-fetching library.** RSC + actions + `revalidatePath` /
   `router.refresh()`. §12 states the one place this strains (inbox freshness)
   and what we do instead.
4. **Five states everywhere:** loading, empty, success, error, unauthorized —
   plus disconnected and rate-limited where they apply. A blank screen is a bug.
5. **URL is state** for every list view.
6. **No fake functionality.** A control that looks live is live, or it is
   visibly disabled with a reason.
7. **Server is the authority.** The UI hides what a role cannot do; hiding is a
   courtesy, not a control.

### Dependency note the lead must confirm (not a new decision — a consequence)

Vendoring shadcn/ui pulls `radix-ui` primitives, `class-variance-authority`,
`tailwind-merge`/`clsx`, and `cmdk` (the Command primitive behind the palette).
These are shadcn's own substrate, not additions beyond the locked stack, but
they will appear in `package.json` and should surprise nobody. See §16 for the
one genuine additional-dependency question (charts).

---

## 2. Route tree

### 2.1 Files

```
src/app/
├── layout.tsx                      # <html>, next/font, token stylesheet, <Toaster/>, aria-live region
├── globals.css                     # Tailwind layers + CSS variable tokens from brief §7
├── not-found.tsx                   # global 404 (unmatched URL)
├── global-error.tsx                # last-resort root error boundary (must render its own <html>)
│
├── (marketing)/
│   ├── layout.tsx                  # public chrome: thin header, footer, no session read
│   ├── error.tsx
│   ├── page.tsx                    # landing
│   ├── pricing/page.tsx
│   ├── unsubscribe/[token]/page.tsx
│   └── legal/
│       ├── privacy/page.tsx
│       └── terms/page.tsx
│
├── (auth)/
│   ├── layout.tsx                  # centred card, redirects to /dashboard if already signed in
│   ├── error.tsx
│   ├── login/page.tsx
│   ├── register/page.tsx
│   ├── forgot-password/page.tsx
│   ├── reset-password/page.tsx     # ?token=
│   └── accept-invite/[token]/
│       ├── page.tsx
│       ├── loading.tsx
│       └── error.tsx
│
├── (app)/
│   ├── layout.tsx                  # THE SHELL: requireSession() → sidebar + header + children
│   ├── loading.tsx                 # shell-level skeleton (page body only; chrome is static)
│   ├── error.tsx                    # in-shell error boundary, keeps nav usable
│   ├── not-found.tsx               # in-shell 404 — also the response for cross-workspace access
│   ├── onboarding/page.tsx         # first-run: name workspace → connect first mailbox
│   │
│   ├── dashboard/
│   │   ├── page.tsx
│   │   ├── loading.tsx
│   │   └── error.tsx
│   │
│   ├── inbox/
│   │   ├── layout.tsx              # folder rail (client, reads useSearchParams) + children
│   │   ├── [[...thread]]/page.tsx  # thread list + conversation; /inbox and /inbox/<id> same page
│   │   ├── loading.tsx
│   │   └── error.tsx
│   │
│   ├── leads/
│   │   ├── page.tsx                # lead table
│   │   ├── loading.tsx
│   │   ├── error.tsx
│   │   ├── [leadId]/
│   │   │   ├── page.tsx            # lead profile
│   │   │   ├── loading.tsx
│   │   │   └── not-found.tsx
│   │   ├── lists/
│   │   │   ├── page.tsx
│   │   │   └── [listId]/page.tsx
│   │   └── import/
│   │       ├── page.tsx            # step 1 — upload
│   │       └── [importId]/
│   │           ├── layout.tsx      # wizard stepper + guard (import must be DRAFT & in workspace)
│   │           ├── map/page.tsx    # step 2
│   │           ├── review/page.tsx # step 3 — validate + preview (one page, two panes)
│   │           ├── running/page.tsx# step 4 — commit progress
│   │           ├── loading.tsx
│   │           └── error.tsx
│   │
│   ├── campaigns/
│   │   ├── page.tsx                # campaign list
│   │   ├── loading.tsx
│   │   ├── error.tsx
│   │   ├── new/page.tsx
│   │   └── [campaignId]/
│   │       ├── layout.tsx          # campaign header + tab nav + launch/pause control
│   │       ├── page.tsx            # overview
│   │       ├── sequence/page.tsx   # SEQUENCE BUILDER
│   │       ├── leads/page.tsx
│   │       ├── schedule/page.tsx
│   │       ├── analytics/page.tsx
│   │       ├── settings/page.tsx
│   │       ├── loading.tsx
│   │       ├── error.tsx
│   │       └── not-found.tsx
│   │
│   ├── mailboxes/
│   │   ├── page.tsx
│   │   ├── loading.tsx
│   │   ├── error.tsx
│   │   ├── connect/page.tsx        # provider choice → starts OAuth
│   │   └── [mailboxId]/
│   │       ├── page.tsx
│   │       ├── loading.tsx
│   │       └── not-found.tsx
│   │
│   ├── crm/
│   │   ├── layout.tsx              # Pipeline | Opportunities | Tasks tabs
│   │   ├── page.tsx                # pipeline board
│   │   ├── loading.tsx
│   │   ├── error.tsx
│   │   ├── opportunities/
│   │   │   ├── page.tsx            # table view of the same data
│   │   │   └── [opportunityId]/page.tsx
│   │   └── tasks/page.tsx
│   │
│   ├── analytics/
│   │   ├── layout.tsx              # Overview | Campaigns | Steps | Mailboxes tabs + global date range
│   │   ├── page.tsx
│   │   ├── campaigns/page.tsx
│   │   ├── steps/page.tsx
│   │   ├── mailboxes/page.tsx
│   │   ├── loading.tsx
│   │   └── error.tsx
│   │
│   ├── ai/
│   │   ├── layout.tsx              # Insights | Personalisation | Usage tabs
│   │   ├── page.tsx                # insight feed
│   │   ├── personalisation/page.tsx
│   │   ├── usage/page.tsx
│   │   ├── loading.tsx
│   │   └── error.tsx
│   │
│   ├── deliverability/
│   │   ├── layout.tsx              # Overview | DNS | Warmup | Suppressions tabs
│   │   ├── page.tsx
│   │   ├── dns/page.tsx            # ?mailbox=<id>
│   │   ├── warmup/page.tsx
│   │   ├── suppressions/page.tsx
│   │   ├── loading.tsx
│   │   └── error.tsx
│   │
│   └── settings/
│       ├── layout.tsx              # settings sub-nav (vertical), role-filtered
│       ├── page.tsx                # redirect() → /settings/profile
│       ├── profile/page.tsx
│       ├── workspace/page.tsx
│       ├── members/page.tsx        # ADMIN+
│       ├── security/page.tsx       # password + active sessions
│       ├── api-keys/page.tsx       # ADMIN+
│       ├── audit-log/page.tsx      # ADMIN+
│       ├── billing/page.tsx        # OWNER — honest "not enabled" state in v1
│       ├── loading.tsx
│       └── error.tsx
│
└── api/
    ├── health/route.ts                     # GET  — liveness, no auth, no data
    ├── oauth/google/start/route.ts         # GET  — session-auth'd, signs state, 302 to Google
    ├── oauth/google/callback/route.ts      # GET  — verifies state, stores encrypted refresh token
    ├── webhooks/gmail/route.ts             # POST — Pub/Sub push, verified before trust
    ├── worker/tick/route.ts                # POST — bearer-token'd queue drain trigger
    ├── leads/import/route.ts               # POST — streamed multipart CSV upload
    ├── leads/export/route.ts               # GET  — streamed CSV download (filter in query)
    ├── tracking/o/[token]/route.ts         # GET  — 1x1 pixel, appends OPENED
    ├── tracking/c/[token]/route.ts         # GET  — 302 to target, appends CLICKED
    └── unsubscribe/route.ts                # POST — RFC 8058 one-click List-Unsubscribe-Post
```

**Documented exception to "no state-changing GETs".** The tracking and pixel
endpoints mutate on GET. They must: mail clients issue GETs and nothing else.
The brief's rule targets *session-authenticated* GETs, where CSRF applies.
These endpoints are unauthenticated, carry no cookies of consequence, are
keyed by a signed opaque token that identifies exactly one (message, link)
pair, and write only append-only `EmailEvent` rows. Any hostile party who can
replay the token can only fabricate an open/click — which is why §4 labels open
data as indicative. `SameSite=Lax` cookies are not sent on these cross-site
requests, so no session is in play.

### 2.2 Route annotations

`RSC` = server component, no client JS beyond shared chrome.
`RSC + client leaf` = server page, named client components inside.

#### (marketing)

| Route | Shows | Primary action | Data | Rendering |
|---|---|---|---|---|
| `/` | Positioning, the core loop, screenshots | "Start free" → `/register` | none (static) | RSC, static |
| `/pricing` | Plan table | "Start free" | none (static) | RSC, static |
| `/legal/privacy`, `/legal/terms` | Policy copy | none | none | RSC, static |
| `/unsubscribe/[token]` | Which list/sender, confirm control | "Confirm unsubscribe" (POST action) | `suppressions.describeToken(token)` | RSC + client leaf (confirm button) |

#### (auth)

| Route | Shows | Primary action | Data | Rendering |
|---|---|---|---|---|
| `/login` | Email + password | Sign in | none | RSC + client form |
| `/register` | Name, email, password, workspace name | Create account | none | RSC + client form |
| `/forgot-password` | Email field | Request reset link | none | RSC + client form |
| `/reset-password?token=` | New password ×2 | Set password | token validity pre-checked server-side | RSC + client form |
| `/accept-invite/[token]` | Workspace name, inviter, role; register-or-sign-in branch | Accept invite | `workspace.describeInvite(token)` | RSC + client form |

All four forms are `react-hook-form` + zod resolver + a server action.
`(auth)/layout.tsx` reads the session and `redirect("/dashboard")` if present,
so a signed-in user cannot land on `/login`.

#### (app) — shell

`(app)/layout.tsx`:

```ts
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();            // redirect("/login?next=…") if absent
  const ctx = await requireWorkspace(session);       // redirect("/onboarding") if no membership
  const [nav, workspaces] = await Promise.all([
    getNavBadges(ctx),                               // unread, mailbox warnings, due tasks
    workspace.listForUser(session.userId),
  ]);
  return (
    <AppShell ctx={ctx} nav={nav} workspaces={workspaces}>
      {children}
    </AppShell>
  );
}
```

`AppShell` is a **client component** — it owns the collapse state, the hotkey
provider, the command palette mount, and the mobile nav sheet. It receives
plain serialisable props. Its children stream in as server output. `getNavBadges`
is the only per-navigation query in the shell; it must stay under three indexed
counts (§3.5).

| Route | Shows | Primary action | Data | Rendering |
|---|---|---|---|---|
| `/onboarding` | Two steps: workspace name → connect mailbox (skippable) | Connect Gmail | `mailboxes.list(ctx)` | RSC + client stepper |
| `/dashboard` | Attention-first triage (§4) | Whatever the top attention item is | 7 module calls, parallel, separately suspended | RSC + client leaves |
| `/inbox/[[...thread]]` | Three-pane inbox (§5) | Reply | `inbox.listThreads`, `inbox.getThread` | RSC + heavy client leaves |
| `/leads` | Server-paginated lead table (§7) | Import leads / Add lead | `leads.list(ctx, filter)` | RSC + client table shell |
| `/leads/[leadId]` | Lead profile: fields, campaigns, threads, timeline, notes | Add to campaign | `leads.get`, `leads.timeline`, `crm.notesFor` | RSC + client tabs |
| `/leads/lists` | Lead lists with counts | New list | `leads.listLists(ctx)` | RSC |
| `/leads/lists/[listId]` | The lead table pre-filtered to the list | Add leads to list | same as `/leads` | RSC |
| `/leads/import` | Dropzone, format help, caps stated | Upload CSV | none | RSC + client uploader |
| `/leads/import/[importId]/map` | Detected headers ↔ lead fields | Continue | `leads.getImport` | RSC + client mapper |
| `/leads/import/[importId]/review` | Validation counts, first 20 mapped rows, duplicate policy | Start import | `leads.validateImport` | RSC + client leaf |
| `/leads/import/[importId]/running` | Progress, per-row errors, errors.csv link | Download errors | `leads.getImport` polled | RSC + client poller |
| `/campaigns` | Campaign cards/rows with health | New campaign | `campaigns.list(ctx, filter)` | RSC |
| `/campaigns/new` | Name, mailboxes, timezone, lead source | Create → `/sequence` | `mailboxes.listSendable(ctx)` | RSC + client form |
| `/campaigns/[id]` | Overview: status, funnel counts, next send, problems | Launch / Pause | `campaigns.get`, `analytics.campaignSummary` | RSC + client leaf |
| `/campaigns/[id]/sequence` | Sequence builder (§6) | Save step / Launch | `sequences.get`, `sequences.variableCoverage` | RSC + large client island |
| `/campaigns/[id]/leads` | Assigned leads with per-lead sequence position | Add leads | `campaigns.listLeads(ctx, id, filter)` | RSC |
| `/campaigns/[id]/schedule` | Sending window, days, timezone, per-mailbox caps, computed throughput | Save schedule | `campaigns.getSchedule`, `sending.capacityEstimate` | RSC + client form |
| `/campaigns/[id]/analytics` | Per-step and per-variant performance, sample-size gated | Change date range | `analytics.campaignBreakdown` | RSC + client chart leaf |
| `/campaigns/[id]/settings` | Tracking toggles, stop-on-reply, unsubscribe text, archive/delete | Save | `campaigns.get` | RSC + client form |
| `/mailboxes` | Mailbox cards: health, today's sent/cap, warmup, last sync | Connect mailbox | `mailboxes.list(ctx)` | RSC |
| `/mailboxes/connect` | Provider choice (Gmail live; SMTP/Outlook disabled with reason) | Connect Gmail → `/api/oauth/google/start` | none | RSC |
| `/mailboxes/[id]` | Detail: quota, sending window, signature, error log, reconnect, disconnect | Reconnect / Save | `mailboxes.get`, `mailboxes.recentErrors` | RSC + client form |
| `/crm` | Pipeline board by stage | New opportunity | `crm.board(ctx, filter)` | RSC + client board |
| `/crm/opportunities` | Table of the same records | New opportunity | `crm.listOpportunities` | RSC |
| `/crm/opportunities/[id]` | Opportunity detail, linked lead/thread, tasks, notes | Log activity | `crm.getOpportunity` | RSC + client tabs |
| `/crm/tasks` | Tasks grouped overdue/today/week/later | Complete task | `crm.listTasks(ctx, filter)` | RSC + client checkboxes |
| `/analytics` | Overview: sends, replies, positive replies, bounces + one trend chart | Change range | `analytics.overview` | RSC + client chart leaf |
| `/analytics/campaigns` | Campaign comparison table | Sort | `analytics.byCampaign` | RSC |
| `/analytics/steps` | Step/variant performance across campaigns, sample-gated | Filter campaign | `analytics.byStep` | RSC |
| `/analytics/mailboxes` | Per-mailbox volume, bounce, reply, cap utilisation | Filter range | `analytics.byMailbox` | RSC |
| `/ai` | Insight feed (cards), each with evidence + sample size | Act on insight | `ai.listInsights(ctx)` | RSC |
| `/ai/personalisation` | Bulk personalisation runs, cost, review queue | Start run / Approve | `ai.listRuns` | RSC + client leaf |
| `/ai/usage` | Token spend by feature and model, budget | Set budget | `ai.usage(ctx, range)` | RSC |
| `/deliverability` | Per-mailbox deliverability posture + honest caveat banner | Fix DNS | `deliverability.overview(ctx)` | RSC |
| `/deliverability/dns` | SPF/DKIM/DMARC records with copy buttons, last check | Re-check | `deliverability.dns(ctx, mailboxId)` | RSC + client copy leaf |
| `/deliverability/warmup` | Warmup schedules and ramp curve | Start/pause warmup | `warmup.list(ctx)` | RSC |
| `/deliverability/suppressions` | Global suppression list, search, add, import | Add suppression | `suppressions.list(ctx, filter)` | RSC |
| `/settings/profile` | Name, email, timezone, avatar | Save | `auth.me(ctx)` | RSC + client form |
| `/settings/workspace` | Name, slug, default timezone, sending defaults | Save | `workspace.get(ctx)` | RSC + client form |
| `/settings/members` | Members, roles, pending invites | Invite member | `workspace.listMembers(ctx)` | RSC + client leaves |
| `/settings/security` | Change password, active sessions, revoke | Revoke session | `auth.listSessions(ctx)` | RSC + client leaf |
| `/settings/api-keys` | Keys with last-used, create, revoke | Create key | `workspace.listApiKeys(ctx)` | RSC + client leaf |
| `/settings/audit-log` | Paginated audit events, filterable by actor/action | Filter | `audit.list(ctx, filter)` | RSC |
| `/settings/billing` | Honest "billing not enabled in this deployment" panel | none | none | RSC |

### 2.3 Why the inbox is one optional catch-all route

`/inbox/[[...thread]]` handles both `/inbox` and `/inbox/<threadId>`.

The reason is a hard Next.js constraint: **layouts do not receive
`searchParams`.** The thread list is driven entirely by search params
(`folder`, `q`, `mailbox`, `campaign`), so it cannot live in a layout without
losing URL-as-state. Splitting into `inbox/page.tsx` + `inbox/[threadId]/page.tsx`
duplicates the list on two routes. The optional catch-all keeps one list
implementation, one set of params, and gives us the mobile behaviour for free:
on a narrow screen `/inbox/<id>` *is* the detail view as its own page.

Cost: selecting a thread re-renders the page, which re-runs the list query.
That query is a bounded, indexed 50-row fetch — single-digit milliseconds — and
`<Link scroll={false}>` plus a stable tree shape preserves the list's scroll
position. Accepted. If measurement says otherwise, the escape hatch is to make
the list a client component fed by a server action, not to restructure routes.

The route validates `params.thread`: length 0 → no selection; length 1 → thread
id; anything longer → `notFound()`.

---

## 3. Navigation model

### 3.1 The sidebar as it will actually read

Fixed 240px, collapsible to 60px (icons only, tooltips on hover/focus).
Section labels are 11px Inter 500, uppercase, `--ink-muted`, tracked +0.06em.
Items are 14px Inter 400; the active item is 500 with a 2px `--accent` left
bar and a `--bg-subtle` fill — never colour alone (brief §7).

```
┌────────────────────────────┐
│  Instant Mail              │   wordmark, Instrument Serif 18px → /dashboard
│  ┌──────────────────────┐  │
│  │ ◆ Northwind Sales  ▾ │  │   workspace switcher (§3.3)
│  └──────────────────────┘  │
│                            │
│  ⌘K  Search or jump to…    │   command palette trigger (button, not input)
│                            │
│  WORK                      │
│  ▣  Dashboard              │
│  ✉  Inbox              12  │   badge = unread threads, capped "99+"
│  ⚑  Tasks               3  │   → /crm/tasks — overdue+today only
│                            │
│  AUDIENCE                  │
│  ⛁  Leads                  │
│  ◫  Lists                  │
│                            │
│  OUTREACH                  │
│  ➤  Campaigns              │
│  ✦  Sequences              │   → /campaigns?view=sequences
│  ⌸  Mailboxes           ▲  │   ▲ = amber dot, ≥1 mailbox needs attention
│                            │
│  REVENUE                   │
│  ◈  CRM                    │
│  ◱  Analytics              │
│                            │
│  SYSTEM                    │
│  ✧  AI                     │
│  ⛨  Deliverability         │
│  ⚙  Settings               │
│                            │
│  ─────────────────────────  │
│  ◑  Sending: 412 / 900     │   today's volume vs. today's capacity
│  ⟨  Collapse               │
└────────────────────────────┘
```

Icons are Lucide, resolved at implementation: `LayoutDashboard, Inbox,
CircleCheck, Users, ListFilter, Send, GitBranch, Mail, Target, ChartNoAxesColumn,
Sparkles, ShieldCheck, Settings, ChevronsLeft`.

Notes on the shape:

- **Five sections, thirteen items.** The brief's ten nav names all appear.
  Tasks, Lists, and Sequences are added as shortcuts into pages that exist
  anyway — they are the three destinations users reach most often and would
  otherwise need two clicks and a tab to find.
- **Only three badges**, all actionable: inbox unread, due tasks, mailbox
  warning. No badge on Campaigns or Analytics — a number there would be
  decoration, and a badge that never means "do something" trains people to
  ignore badges.
- The sending meter is the one ambient stat in the chrome. It answers "is the
  machine running?" without opening a page. It links to `/analytics/mailboxes`.
- Role filtering: `Settings` is always present; its sub-nav filters by role.
  A `MEMBER` sees no `api-keys`, `audit-log`, `members`, or `billing` entries.
  Server-side guards make direct URLs 404 regardless.

### 3.2 Header

Deliberately thin — 56px, `--surface`, hairline bottom border. Page-level
context lives in the page, not the chrome, so the header carries only what is
global:

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Leads ›  All leads              [ ⚠ 1 mailbox disconnected ]  ⌘K  ?  ⬤ NG │
└───────────────────────────────────────────────────────────────────────────┘
```

Left: breadcrumb, `<nav aria-label="Breadcrumb">`, max two levels, last crumb
`aria-current="page"`. On `/campaigns/[id]/*` the second crumb is the campaign
name and it is a link back to the overview.

Right, in order:
1. **System alert chip** — renders only when something is wrong: a mailbox is
   disconnected, the worker has not ticked in >15 minutes, or a campaign is
   stalled. One chip, highest severity, linking to the fix. Absent when healthy;
   this is not a permanent status widget.
2. **Search trigger** (`⌘K` / `Ctrl+K`) — same palette as the sidebar entry.
3. **Help** — docs link + keyboard-shortcut sheet (`?`).
4. **Account menu** — avatar button; profile, security, sign out. No theme
   control: dark mode is out of scope for v1, and a switch that does nothing is
   the fake functionality the brief forbids. Signing out is a POST server
   action, never a link.

Deliberately *not* in the header: a global "New" button (the primary action
belongs to the page), notification bell (the dashboard is the notification
surface — two competing inboxes is a design smell), or a date-range picker
(scoped to analytics, where it lives in that section's layout).

### 3.3 Workspace switcher

A `DropdownMenu` in the sidebar, above navigation.

- Lists every workspace the user belongs to, with role, current one checked.
- "Create workspace" and (ADMIN+) "Invite people" at the bottom.
- Switching calls a server action, which writes the active workspace onto the
  **session row server-side** and `redirect()`s to `/dashboard`.

Two decisions worth stating. First, active workspace lives on the session, not
in the URL — a `workspaceId` in the URL invites tampering, and the brief
requires the server to resolve tenancy from the session (§4.2). Second, we
always land on `/dashboard` after switching rather than staying on the current
path: `/leads/<id>` in the old workspace is meaningless in the new one, and
"switch then 404" is a bad first impression.

Single-workspace users still see the switcher (it is where "create workspace"
lives) but it renders as a static plate with a chevron, not a busy control.

### 3.4 Command palette scope

`cmdk`-based, `⌘K`/`Ctrl+K`, mounted once in `AppShell`. Four groups, ranked:

| Group | Contents | Source |
|---|---|---|
| **Actions** | New campaign, Import leads, Connect mailbox, Add lead, Compose reply (inbox only), Go to inbox unread | static, filtered by role and route |
| **Navigate** | Every sidebar destination + settings sub-pages | static list |
| **Search** | Leads (name/email/company), campaigns, mailboxes | server action, debounced 200ms, `LIMIT 5` per type |
| **Recent** | Last 5 visited leads/campaigns/threads | `localStorage`, this device only |

Rules:
- Static groups render on open with **zero network**. Search results append.
- Search is a single server action `search.quick(ctx, q)` returning
  `{ leads, campaigns, mailboxes }`, each `LIMIT 5`, `ILIKE` on indexed
  columns. Not full-text in v1 — trigram/FTS is a data-model decision and
  `ILIKE 'q%'` on an indexed prefix is genuinely enough for ≤5 suggestions.
- **Thread bodies are not searched here.** Inbox search is its own thing
  (§5.4) with its own semantics; blending them makes both worse.
- Actions the current role cannot perform are omitted, not shown disabled — a
  palette is for doing, and an unusable row is noise.
- Palette rows never mutate destructively. Nothing that deletes, sends, or
  launches is reachable from the palette; those need their page's confirmation.
  Only navigation and "open a creation form".

### 3.5 Nav badge query budget

`getNavBadges(ctx)` runs on every shell render. Hard budget: **three indexed
counts in one `Promise.all`, ~5ms total.** Indicative shape:

```sql
-- unread threads
SELECT count(*) FROM "Thread"
 WHERE "workspaceId" = $1 AND "isRead" = false AND "archivedAt" IS NULL;
-- tasks due
SELECT count(*) FROM "Task"
 WHERE "workspaceId" = $1 AND "completedAt" IS NULL AND "dueAt" < $2;
-- mailboxes needing attention
SELECT count(*) FROM "Mailbox"
 WHERE "workspaceId" = $1 AND "status" <> 'HEALTHY';
```

The sending meter reuses the dashboard's capacity query, cached with
`unstable_cache` for 60s keyed by workspace. If this budget is ever exceeded,
the fix is to drop a badge, not to add caching layers.

---

## 4. Dashboard — attention first

### 4.1 The thesis

The user opens this page to answer one question: **what needs me right now?**
Not "how are we trending?" A cold-email operator's day is triage — answer
replies, unstick campaigns, reconnect mailboxes — and every pixel spent on a
line chart is a pixel not spent on a reply waiting three days.

So: **the top 60% of the viewport contains only work items.** Trend data lives
below the fold, and there is exactly one chart on this page (§4.4).

### 4.2 Layout

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Good morning, Nayab                              Tue 31 Aug · 9:12 IST   │  ← Instrument Serif 32px
│                                                                           │
│  ╔═══════════════════════════════════════════════════════════════════╗   │
│  ║ ⚠  2 things need attention                                        ║   │  ← §4.3.1 Triage banner
│  ║    Mailbox nayab@northwind.io disconnected 4h ago    [Reconnect]  ║   │     (renders only when non-empty)
│  ║    "Q4 Outbound" paused — no sendable mailbox        [Fix]        ║   │
│  ╚═══════════════════════════════════════════════════════════════════╝   │
│                                                                           │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐               │
│  │ Replies     │ Interested  │ Follow-ups  │ Failed      │               │  ← §4.3.2 Action tiles
│  │     7       │     3       │     5       │     2       │               │     counts, not rates
│  │ 2 over 24h  │ new today   │ due today   │ last 24h    │               │
│  └─────────────┴─────────────┴─────────────┴─────────────┘               │
│                                                                           │
│  Needs a reply                                       View inbox →         │  ← §4.3.3
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │ ⬤ Sara Kaplan · Meridian Health      Interested   3d   Q4 Outbound│   │
│  │ ⬤ Tom Ide · Braid Logistics          Meeting      1d   Q4 Outbound│   │
│  │   Dana Ruiz · Vell Systems           Question     4h   Founder-led│   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  Campaign health                                    All campaigns →       │  ← §4.3.4
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │ Q4 Outbound       ● Active   412 sent  7.2% reply   next in 12m   │   │
│  │ Founder-led       ⏸ Paused   88 sent   4.1% reply   ⚠ no mailbox  │   │
│  │ Reactivation      ◌ Draft    —         —            0 leads       │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  Mailboxes                                          Manage →              │  ← §4.3.5
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │ nayab@northwind.io  ⛔ Disconnected  —          reconnect required│   │
│  │ sales@northwind.io  ● Healthy       312 / 400  warmup day 14      │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  ─────────────────────────────────────────────────────────────────────    │
│  Last 30 days                                       Analytics →           │  ← §4.4 the one chart
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │  sent ▁▂▃▅▆▅▃▂▃▅▆▇▆▅   replies ▁▁▂▂▁▂▃▂▂▁▂▃▃▂                    │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  Recent activity                                                          │  ← §4.5
│  ActivityTimeline, 15 items, "Load more"                                  │
└───────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Sections in order, with queries

Each section is its own `<Suspense>` boundary with its own skeleton, so a slow
section never blocks the fast ones. The page component is:

```tsx
export default async function DashboardPage() {
  const ctx = await requireWorkspace();
  return (
    <PageShell title={greeting()} subtitle={<LocalClock tz={ctx.timezone} />}>
      <Suspense fallback={<TriageBannerSkeleton />}><TriageBanner ctx={ctx} /></Suspense>
      <Suspense fallback={<TileRowSkeleton n={4} />}><ActionTiles ctx={ctx} /></Suspense>
      <Suspense fallback={<ListSkeleton rows={5} />}><NeedsReply ctx={ctx} /></Suspense>
      <Suspense fallback={<ListSkeleton rows={3} />}><CampaignHealth ctx={ctx} /></Suspense>
      <Suspense fallback={<ListSkeleton rows={2} />}><MailboxHealth ctx={ctx} /></Suspense>
      <Suspense fallback={<ChartSkeleton />}><ThirtyDayTrend ctx={ctx} /></Suspense>
      <Suspense fallback={<ListSkeleton rows={8} />}><RecentActivity ctx={ctx} /></Suspense>
    </PageShell>
  );
}
```

Each `<Section>` is an async server component that awaits exactly one module
call. Seven boundaries, seven queries, all parallel — the page's TTFB is the
slowest single query, not the sum.

#### 4.3.1 Triage banner — `dashboard.problems(ctx)`

Renders **only if non-empty**. Never a green "all good" card; an empty state
here is the absence of the component. Max 4 rows, then "+N more".

Problem sources, in severity order, each with a one-click fix:

| Problem | Detection | Fix action |
|---|---|---|
| Mailbox disconnected / token invalid | `Mailbox.status IN ('DISCONNECTED','AUTH_FAILED')` | Reconnect → OAuth start |
| Active campaign with no sendable mailbox | active campaign, zero `HEALTHY` linked mailboxes | Campaign → settings |
| Campaign active but nothing scheduled 24h | active, `count(ScheduledEmail future)=0` | Add leads / check schedule |
| Send failures spiking | ≥5 `FAILED` events in 24h for one mailbox | Mailbox detail → error log |
| Bounce rate above threshold | campaign bounce >5% with ≥50 sends | Campaign → leads (verify list) |
| Worker not ticking | `max(Job.updatedAt) < now() - 15min` with pending jobs | Ops runbook link |
| DNS missing | SPF or DKIM absent on a sending domain | `/deliverability/dns` |

```sql
-- indicative: unhealthy mailboxes
SELECT id, email, status, "statusChangedAt"
  FROM "Mailbox"
 WHERE "workspaceId" = $1 AND status <> 'HEALTHY'
 ORDER BY "statusChangedAt" DESC LIMIT 5;

-- indicative: active campaigns with nothing scheduled in the next 24h
SELECT c.id, c.name
  FROM "Campaign" c
 WHERE c."workspaceId" = $1 AND c.status = 'ACTIVE'
   AND NOT EXISTS (
     SELECT 1 FROM "ScheduledEmail" s
      WHERE s."campaignId" = c.id
        AND s.status = 'PENDING'
        AND s."scheduledAt" < now() + interval '24 hours'
   );
```

`dashboard.problems` returns a typed discriminated union so the UI cannot
render a fix button for a problem shape it does not understand:

```ts
export type Problem =
  | { kind: "mailbox_disconnected"; mailboxId: string; email: string; since: Date }
  | { kind: "campaign_no_mailbox";  campaignId: string; name: string }
  | { kind: "campaign_no_schedule"; campaignId: string; name: string }
  | { kind: "send_failures";        mailboxId: string; email: string; count: number }
  | { kind: "bounce_rate";          campaignId: string; name: string; rate: number; sends: number }
  | { kind: "worker_stalled";       lastTickAt: Date | null; pendingJobs: number }
  | { kind: "dns_missing";          domain: string; missing: ("SPF" | "DKIM" | "DMARC")[] };

export type ProblemList = { problems: Problem[]; severity: "none" | "warn" | "critical" };
```

#### 4.3.2 Action tiles — `dashboard.counts(ctx)`

Four tiles. Each is a **link into a filtered view**, each shows an absolute
count (Instrument Serif 36px) and one line of qualifying context. No
percentages, no sparklines, no deltas — a delta on "replies waiting" is
meaningless; you either have replies to answer or you do not.

| Tile | Count | Sub-line | Links to |
|---|---|---|---|
| Replies waiting | unread, non-archived threads with an inbound message | "N over 24h old" | `/inbox?folder=unread` |
| Interested leads | leads classified `INTERESTED`/`MEETING` with no opportunity yet | "N new today" | `/inbox?folder=interested` |
| Follow-ups due | tasks due ≤ today, incomplete | "N overdue" | `/crm/tasks?due=today` |
| Failed sends | `EmailEvent FAILED` in last 24h | "across N mailboxes" | `/analytics/mailboxes?status=failed` |

```sql
-- one round trip, four scalars
SELECT
  (SELECT count(*) FROM "Thread" t
    WHERE t."workspaceId"=$1 AND t."isRead"=false AND t."archivedAt" IS NULL
      AND t."lastInboundAt" IS NOT NULL)                                  AS replies_waiting,
  (SELECT count(*) FROM "Thread" t
    WHERE t."workspaceId"=$1 AND t."isRead"=false AND t."archivedAt" IS NULL
      AND t."lastInboundAt" < now() - interval '24 hours')                AS replies_stale,
  (SELECT count(*) FROM "Lead" l
    WHERE l."workspaceId"=$1 AND l."interestStatus" IN ('INTERESTED','MEETING')
      AND NOT EXISTS (SELECT 1 FROM "Opportunity" o WHERE o."leadId"=l.id)) AS interested,
  (SELECT count(*) FROM "Task"
    WHERE "workspaceId"=$1 AND "completedAt" IS NULL AND "dueAt" <= $2)   AS followups_due,
  (SELECT count(*) FROM "EmailEvent"
    WHERE "workspaceId"=$1 AND type='FAILED' AND "occurredAt" > now() - interval '24 hours') AS failed_sends;
```

Written as one `SELECT` of scalar subqueries because five round trips to render
four numbers is silly and Postgres plans this fine with the right partial
indexes. The data-model doc owns those indexes; this section is the reason they
exist:
`Thread(workspaceId, isRead, archivedAt, lastInboundAt)`,
`Task(workspaceId, completedAt, dueAt)`,
`EmailEvent(workspaceId, type, occurredAt)`.

#### 4.3.3 Needs a reply — `dashboard.needsReply(ctx, { limit: 5 })`

The most important list on the page. Five oldest unread inbound threads,
oldest first — **not newest first**, because the reply that has been waiting
longest is the one at risk.

Each row: unread dot, lead name, company, AI classification badge, relative age
(`3d`, red past 48h), campaign name. Whole row is a `<Link>` to
`/inbox/<threadId>`. Inline `Archive` on hover/focus (a keyboard user gets it
via focus, not hover only).

```sql
SELECT t.id, t."subject", t."lastInboundAt", t."aiCategory",
       l."firstName", l."lastName", l."companyName", c."name" AS campaign_name
  FROM "Thread" t
  JOIN "Lead" l     ON l.id = t."leadId"
  LEFT JOIN "Campaign" c ON c.id = t."campaignId"
 WHERE t."workspaceId" = $1
   AND t."isRead" = false AND t."archivedAt" IS NULL
   AND t."lastInboundAt" IS NOT NULL
 ORDER BY t."lastInboundAt" ASC
 LIMIT 5;
```

Empty state: "No replies waiting. Nice." + `View all conversations →`. This is
the one empty state that is genuinely good news, and it says so.

#### 4.3.4 Campaign health — `dashboard.campaignHealth(ctx)`

Up to five campaigns, ordered: problems first, then active by volume, then
paused, then drafts. Per row: name, status pill, sent count, reply rate
(suppressed as `—` under 20 sends, per brief §10), next scheduled send as a
relative time, and a problem chip if any.

Reply rate reads from cached counters on `Campaign` (`sentCount`,
`replyCount`), refreshed by the worker after each batch. `EmailEvent` remains
truth; the dashboard reads the cache because it must render in milliseconds,
and the analytics pages recompute from events. That divergence is deliberate
and stated in both places.

"Next send" needs the scheduler's view, not the cache:

```sql
SELECT "campaignId", min("scheduledAt") AS next_at
  FROM "ScheduledEmail"
 WHERE "workspaceId" = $1 AND status = 'PENDING'
 GROUP BY "campaignId";
```

#### 4.3.5 Mailboxes — `dashboard.mailboxHealth(ctx)`

One row per mailbox: address, status pill, `sentToday / dailyCap` with a thin
progress bar, warmup day if warming, last sync as relative time. Unhealthy
first. `Reconnect` inline where relevant.

Cap utilisation is honest about a real constraint: **the number shown is our
own counter, not Gmail's.** Gmail does not expose remaining daily quota. If
Google rejects on quota before our cap, the mailbox goes `RATE_LIMITED`, the
row says so, and the bar is capped visually with a note rather than pretending
the cap is authoritative.

### 4.4 Exactly one chart, and why

One 30-day dual-series area chart: sends and replies, daily buckets.

Chart count is capped at one because every additional chart on this page
competes with the triage lists above it for attention, and none of them changes
what the user does in the next minute. Trend analysis is a separate mode of
work with a whole section (`/analytics`) built for it. Rate metrics, funnels,
per-step breakdowns, and mailbox comparisons all live there.

The chart is below a horizontal rule, below the fold on a laptop, and labelled
"Last 30 days" with an "Analytics →" link. Data:

```sql
SELECT date_trunc('day', "occurredAt" AT TIME ZONE $3) AS day,
       count(*) FILTER (WHERE type = 'SENT')    AS sent,
       count(*) FILTER (WHERE type = 'REPLIED') AS replies
  FROM "EmailEvent"
 WHERE "workspaceId" = $1 AND "occurredAt" > now() - interval '30 days'
 GROUP BY 1 ORDER BY 1;
```

Days with no events must appear as zero, not as gaps — generate the series with
`generate_series` in SQL, not by patching arrays in JS, so the chart and any
CSV export agree.

Open rate is **not** on this chart. Putting an unreliable metric next to two
reliable ones invites people to read them as equally solid.

### 4.5 Recent activity — `dashboard.activity(ctx, { limit: 15 })`

`ActivityTimeline` over the union of recent facts: sends, replies, bounces,
classifications, campaign launches, imports, mailbox events. Cursor-paginated
by `(occurredAt, id)`. Read-only, but each item links to its subject.

This is last because it is the answer to "what happened?", and this page is
about "what should I do?"

### 4.6 Dashboard states

| State | Trigger | Render |
|---|---|---|
| Loading | initial nav | Seven independent skeletons matching final geometry. Greeting renders instantly (session data, no query) so the page is never fully blank. |
| Empty — new workspace | no mailboxes | Replace everything below the greeting with a three-step `EmptyState`: **Connect a mailbox** (primary) → Import leads → Create a campaign, with steps 2–3 disabled and labelled "after you connect a mailbox". Honest: no fake tiles, no zeroed charts. |
| Empty — set up, nothing running | mailboxes exist, no active campaign | Keep tiles (all zero, honestly). Replace Needs-a-reply with "No conversations yet". Campaign health shows the draft with CTA **Launch your first campaign**. |
| Empty — running, nothing to do | active campaigns, zero problems, zero unread | No triage banner. Tiles at zero. "No replies waiting." Campaign health and chart carry the page. This is the healthy steady state and must look *calm*, not broken. |
| Error | a section's query throws | Per-section `ErrorState` inside that Suspense boundary with **Retry** (`router.refresh()`). One failing section never blanks the page. |
| Unauthorized | no session / no membership | Never rendered — the shell redirected to `/login` or `/onboarding` first. |
| Disconnected | ≥1 mailbox unhealthy | Triage banner row + mailbox row + header alert chip. Sending is genuinely stopped for that mailbox and the copy says so. |
| Rate-limited | mailbox at cap or provider 429 | Mailbox row shows `Rate limited — resumes 09:00 IST`; not an error, and not styled as one. |

---

## 5. Inbox

The highest-interaction surface in the product. A user lives here for hours.
Design target: **answer a reply in under 10 seconds, keyboard only.**

### 5.1 Three-pane layout

```
┌──────────┬──────────────────────────┬─────────────────────────────────────────┐
│ FOLDERS  │ THREAD LIST              │ CONVERSATION                            │
│ 200px    │ 360px                    │ fluid, max 900px content column         │
├──────────┼──────────────────────────┼─────────────────────────────────────────┤
│ All   42 │ [ search ▾mailbox ▾camp ]│  Sara Kaplan                            │
│ Unread12 │ ┌──────────────────────┐ │  VP Ops · Meridian Health               │
│ ─────────│ │⬤ Sara Kaplan      3d │ │  sara@meridianhealth.com                │
│ Interest3│ │  Re: quick question  │ │  Q4 Outbound · step 2 · sales@northwind │
│ Followup5│ │  Thanks — can we…    │ │  ┌───────────────────────────────────┐  │
│ Meeting 1│ │  ◆Interested  Q4 Out │ │  │ ✦ AI summary                      │  │
│ Not int 8│ ├──────────────────────┤ │  │ Asking for pricing for 40 seats.  │  │
│ ─────────│ │  Tom Ide          1d │ │  │ Wants a call next week.           │  │
│ Snoozed2 │ │  Re: Braid ops       │ │  │ Interested · 0.91  [Draft reply]  │  │
│ Archive  │ │  ◆Meeting     Q4 Out │ │  └───────────────────────────────────┘  │
│ Sent     │ └──────────────────────┘ │                                         │
│ Bounced3 │        …50 rows…         │  ▸ You · 24 Aug 09:00   (collapsed)     │
│          │      [ Load more ]      │  ▾ Sara Kaplan · 28 Aug 14:22           │
│          │                          │    Thanks for reaching out — what does  │
│          │                          │    pricing look like for 40 seats?      │
│          │                          │    📎 org-chart.pdf (240 KB)            │
│          │                          │  ─────────────────────────────────────  │
│          │                          │  [ Reply ] [ Forward ]  ⌨ R to reply    │
│          │                          │                                         │
│          │                          │  Notes (2)                              │
│          │                          │  Timeline ▸                             │
└──────────┴──────────────────────────┴─────────────────────────────────────────┘
```

Panes are independently scrollable (`overflow-y-auto`, `min-h-0` on the flex
children — the classic bug). Widths are CSS-grid columns; the list/conversation
split is user-resizable and persisted in `localStorage`. The folder rail
collapses at ≤1280px into a select in the list header.

### 5.2 Component split

```
inbox/layout.tsx            RSC — folder counts, renders <FolderRail counts={…}/>
  FolderRail                client — reads useSearchParams to mark active
inbox/[[...thread]]/page.tsx  RSC — parses searchParams + params, two queries
  <InboxToolbar/>           client — search input, mailbox/campaign selects
  <ThreadList/>             client — selection, hotkeys, optimistic read/archive
  <Conversation/>           RSC (streamed in its own Suspense)
    <MessageBubble/>        RSC — sanitised HTML body
    <AiPanel/>              client — draft-reply request, collapse state
    <ReplyComposer/>        client — RHF + zod, server action submit
    <ThreadActions/>        client — archive/snooze/status/tag
    <ThreadNotes/>          client — add note, optimistic append
    <ThreadTimeline/>       RSC — events for this thread
```

`ThreadList` is a client component because it owns selection, hotkeys, and
optimistic mutation — but its **rows are rendered from server-supplied props**,
not fetched client-side. Server renders data; client owns interaction.

### 5.3 Folder / filter model

Folders are `?folder=` values, not tables. Each is a predicate over `Thread`:

| Folder | Predicate | Count badge |
|---|---|---|
| `all` | not archived | no |
| `unread` | `isRead=false`, not archived | yes |
| `interested` | `aiCategory='INTERESTED'`, not archived | yes |
| `follow_up` | `aiCategory='FOLLOW_UP'` OR an open task links the thread | yes |
| `meeting` | `aiCategory='MEETING_REQUEST'`, not archived | yes |
| `not_interested` | `aiCategory IN ('NOT_INTERESTED','UNSUBSCRIBE')` | yes |
| `snoozed` | `snoozedUntil > now()` | yes |
| `archived` | `archivedAt IS NOT NULL` | no |
| `sent` | outbound-only threads with no inbound yet | no |
| `bounced` | latest event for the thread is `BOUNCED` | yes |
| `ooo` | `aiCategory='OUT_OF_OFFICE'` | no |

Two rules that prevent the classic mess:

1. **Snoozed threads are hidden from every other folder** until `snoozedUntil`
   passes. A snooze that still shows the thread in `all` is not a snooze.
2. **`archived` is exclusive.** Archiving removes a thread from all live
   folders. Archiving is not deleting; nothing in the inbox deletes a thread.

Orthogonal filters, all `?`-params, all AND-composed with the folder:
`mailbox=<id>`, `campaign=<id>`, `q=<text>`, `status=<lead interest status>`,
`tag=<id>`, `unread=1`, `attachments=1`, `after=<iso>`.

Sort is fixed to `lastMessageAt DESC` in every folder except `unread`, which is
`lastInboundAt ASC` (oldest-waiting first, same reasoning as the dashboard).
Sort is not user-configurable — a triage queue with a user-chosen sort order is
a queue people lose things in.

Thread list query:

```sql
SELECT t.id, t.subject, t."lastMessageAt", t."lastInboundAt", t."isRead",
       t."aiCategory", t."aiConfidence", t."snoozedUntil", t."hasAttachments",
       t."messageCount", t.preview,
       l.id AS lead_id, l."firstName", l."lastName", l."companyName", l."interestStatus",
       c.id AS campaign_id, c.name AS campaign_name,
       m.email AS mailbox_email
  FROM "Thread" t
  JOIN "Lead" l          ON l.id = t."leadId"
  LEFT JOIN "Campaign" c ON c.id = t."campaignId"
  JOIN "Mailbox" m       ON m.id = t."mailboxId"
 WHERE t."workspaceId" = $1
   AND t."archivedAt" IS NULL
   AND (t."snoozedUntil" IS NULL OR t."snoozedUntil" <= now())
   AND ($2::uuid IS NULL OR t."mailboxId" = $2)
   AND ($3::uuid IS NULL OR t."campaignId" = $3)
   AND ($4::text IS NULL OR t."searchVector" @@ websearch_to_tsquery('english', $4))
 ORDER BY t."lastMessageAt" DESC
 LIMIT 51;                       -- 51 to know whether a next page exists
```

`t.preview` (first ~140 chars of the newest message, plain text) and
`messageCount` are denormalised onto `Thread` by the sync/reply pipeline.
Computing the preview by joining `Message` for 50 rows is the mistake that makes
inboxes slow.

**Pagination is a cursor, not an offset.** `?cursor=<lastMessageAt>_<id>`,
`LIMIT 51`, "Load more" appends. Offset pagination on a list that changes under
you duplicates and skips rows.

### 5.4 Search

Postgres full-text over a `Thread.searchVector` `tsvector` column, maintained by
trigger or by the reply pipeline, covering subject + lead name + lead email +
lead company + the concatenated plain-text bodies of the thread's messages.

- `websearch_to_tsquery('english', q)` — users get quoted phrases and `-`
  exclusion for free, and malformed input cannot throw.
- Debounced 300ms in `InboxToolbar`, pushed to the URL with
  `router.replace(..., { scroll: false })` so search is shareable and back works.
- Search **respects the current folder** (searching in Archived searches
  archived). A `Search all folders` link appears in the results header when the
  folder is not `all`.
- Empty result state names the query and offers `Clear search` +
  `Search all folders`.

Honest limits, stated in the UI's help text: search covers text we have synced;
it does not search attachment contents, and very old threads outside the sync
window are not indexed.

Why FTS and not `ILIKE`: `ILIKE '%q%'` over message bodies is a sequential scan
of the largest table in the system. This is the one place the extra column and
GIN index are unambiguously worth it. (Data-model doc owns the column; this is
the requirement.)

### 5.5 Conversation view contents, top to bottom

1. **Lead header** — name (link to `/leads/<id>`), title, company, email with
   copy button, lead interest status badge, tags.
2. **Context line** — campaign (link) · sequence step reached · sending mailbox ·
   "sequence stopped on reply" indicator when applicable. This tells the user
   *why this person is in their inbox*, which generic mail clients cannot.
3. **AI panel** — collapsible, collapsed by default after first read:
   - summary (2–3 sentences),
   - classification badge + confidence + model/version on hover,
   - `Draft reply` button (§5.7),
   - "AI-generated — check before sending" affordance, always present.
   If AI is unavailable or disabled, the panel renders an honest disabled state,
   not a spinner that never resolves.
4. **Message thread** — chronological, oldest first. Newest message and any
   unread message expanded; older ones collapsed to one line (sender · time ·
   snippet), click/Enter to expand. Outbound messages are visually distinct
   (indented, `--bg-subtle`) and labelled "Sent by <mailbox> · step 2".
   Timestamps: relative up to 7 days then absolute, `title`/`<time datetime>`
   carrying the full ISO value in the viewer's timezone.
5. **Attachments** — filename, type icon, size. Downloads stream through a
   server route that re-checks workspace ownership; we never expose a
   provider URL to the client.
6. **Composer** — collapsed to `[Reply] [Forward]` until invoked.
7. **Notes** — internal, never sent, visibly marked so. Author + timestamp.
8. **Timeline** — this thread's `EmailEvent` rows, collapsed by default:
   queued/sent/delivered/opened/clicked/replied/bounced with times. Open events
   labelled "indicative — open tracking is blocked by many mail clients."

#### Rendering inbound HTML safely

Inbound bodies are hostile input. Non-negotiable pipeline: sanitise
**server-side** with an allow-list (no `<script>`, `<style>`, `<iframe>`,
`<form>`, no `on*`, no `javascript:`), strip remote images behind a
"Show images" toggle (loading them leaks read receipts to the sender), rewrite
links to `rel="noopener noreferrer nofollow"` + `target="_blank"`, and render
into a scoped container that cannot inherit or override app styles. Prefer the
`text/plain` part when the HTML part sanitises to nothing meaningful.

### 5.6 Actions

| Action | Effect | Optimistic? | Undo |
|---|---|---|---|
| Reply | Composer → server action → queue outbound send | No | — |
| Reply all | Same, with Cc preserved | No | — |
| Forward | Composer with quoted body, empty To | No | — |
| Archive | `archivedAt = now()`, drop from list | **Yes** | Toast "Archived · Undo" 8s |
| Unarchive | clears `archivedAt` | Yes | Toast |
| Mark read/unread | toggles `isRead` | **Yes** | Toggle back |
| Snooze | `snoozedUntil`, hidden until then | **Yes** | Toast "Snoozed until Mon 9:00 · Undo" |
| Add note | appends `Note` | **Yes** (append, rollback on failure) | Delete note |
| Set lead status | writes `Lead.interestStatus` (human overrides AI) | Yes | Set again |
| Add/remove tag | `ThreadTag` join | Yes | Toggle |
| Create task | opens Drawer, prefilled from thread | No | — |
| Create opportunity | opens Drawer, prefilled from lead | No | — |
| Stop sequence for lead | cancels pending `ScheduledEmail` for this lead+campaign | **No — confirm** | — |
| Add to suppression list | global do-not-contact | **No — confirm** | Remove from list |
| Block sender / mark spam | suppression + archive | No — confirm | — |

Sends and cancellations are never optimistic: they have side effects outside our
database (an email leaves the building, a schedule is destroyed) and showing
success before the server agrees is lying. Everything else is local state we can
roll back.

**Reply composer specifics.** Plain-text-first with a minimal formatting
affordance (bold/italic/link/list); no rich-text kitchen sink, because cold
outreach replies that look hand-typed perform better and a full editor is weeks
of work and a11y risk for no benefit. Fields: To (locked to thread participant,
editable), Cc/Bcc (collapsed), Subject (prefilled `Re:`, editable), body,
signature auto-appended from the mailbox with a toggle. Sends via
`inbox.sendReply(ctx, { threadId, body, cc, bcc })` which enqueues an outbound
job with an idempotency key of `reply:<threadId>:<clientToken>` — the client
generates `clientToken` once per composer session, so a double-click or a retry
after a flaky response cannot double-send. Draft body is autosaved to
`sessionStorage` per thread every 2s so a misclick does not lose typing.

### 5.7 AI suggested reply

`Draft reply` calls `ai.suggestReply(ctx, threadId)`. It **never sends**. The
returned draft loads into the composer with the AI badge attached and the user
edits freely. The badge clears the moment the user types — an edited draft is
the user's text, and continuing to label it as AI is inaccurate.

Rate limited per workspace; when limited, the button disables with
"AI limit reached — resets in 12m" rather than failing on click. Latency is
seconds, so the button shows a determinate-feeling pending state and the result
is announced via `aria-live="polite"`.

### 5.8 Keyboard shortcuts

Registered by a single `useHotkeys` provider in `AppShell`, scoped by route, and
suppressed whenever focus is in a text field or a dialog is open (except `Esc`
and `⌘Enter`).

Global:

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette |
| `?` | Shortcut sheet |
| `g` then `i` / `d` / `l` / `c` / `m` | Go to Inbox / Dashboard / Leads / Campaigns / Mailboxes |
| `Esc` | Close overlay, else clear search, else blur |

Inbox list:

| Key | Action |
|---|---|
| `j` / `↓` | Next thread |
| `k` / `↑` | Previous thread |
| `Enter` / `o` | Open focused thread |
| `x` | Toggle selection |
| `e` | Archive (focused or selected) |
| `u` | Toggle read/unread |
| `s` | Snooze (opens picker) |
| `#` | Add to suppression (confirm) |
| `/` | Focus search |
| `1`–`6` | Jump to folder by position |
| `⌘A` | Select all on page |

Conversation:

| Key | Action |
|---|---|
| `r` | Reply (focus composer body) |
| `a` | Reply all |
| `f` | Forward |
| `n` | Add note |
| `t` | New task from thread |
| `i` | Toggle AI panel |
| `⌘Enter` | Send from composer |
| `Esc` | Close composer (keeps autosaved draft) |
| `[` / `]` | Previous / next thread without leaving the conversation pane |

Focus discipline: `j`/`k` move a **roving tabindex** through the list
(`role="listbox"`, rows `role="option"`, `aria-selected`), the focused row is
`scrollIntoView({ block: "nearest" })`, and opening a thread moves focus to the
conversation's `<h2>` (`tabIndex={-1}`) so a screen reader announces the new
context. `[`/`]` keep focus in the conversation. Archiving from the list moves
focus to the next row, never to `<body>` — losing focus to the document is the
single most common keyboard bug in inbox UIs.

### 5.9 Narrow-screen degradation

| Width | Behaviour |
|---|---|
| ≥1536px | Three panes, comfortable |
| 1280–1535px | Three panes, list 320px, folder labels only |
| 1024–1279px | Folder rail collapses to a `<select>` in the list header; two panes |
| <1024px | **List → detail push.** `/inbox` shows only the list; tapping a row navigates to `/inbox/<id>`, which shows only the conversation with a back link. Browser back returns to the list at its scroll position. |

This is why the route is `[[...thread]]`: the mobile pattern is the URL, so back
works natively and there is no client-side "which pane is showing" state.

Under 1024px: swipe gestures are **not** implemented in v1 (touch a11y and
undo affordances make them a project, not a flourish). Actions live in a visible
action bar at the bottom of the conversation and an overflow menu per row.

### 5.10 Freshness without a data-fetching library

The brief rejects TanStack Query. What the inbox actually needs is bounded:

1. **After a mutation**, the server action calls `revalidatePath("/inbox")` and
   the client applies its optimistic update immediately. Correct and cheap.
2. **New mail arriving while the user sits on the page** — we do not
   silently mutate the list under a triaging user. A lightweight server action
   `inbox.unreadSince(ctx, since)` is polled every **60 seconds** while the tab
   is visible (`document.visibilityState`), and when it returns > 0 we show a
   non-moving pill at the top of the list: **"3 new messages — refresh"**,
   which calls `router.refresh()`. User-initiated, no layout jump, one tiny
   indexed count per minute.

No websockets, no SSE, no query cache. If a customer ever demands live inbox
updates, that is a written revisit per brief §2, not a quiet dependency.

### 5.11 Inbox states

| Surface | State | Render |
|---|---|---|
| Thread list | Loading | 8 row skeletons at final row height (72px) |
| | Empty, no mailbox | `EmptyState`: "Connect a mailbox to see conversations" → **Connect mailbox** |
| | Empty, mailbox but no threads | "No conversations yet. Replies appear here once campaigns start sending." → **View campaigns** |
| | Empty, folder filtered | "Nothing in Interested." → **View all** |
| | Empty, search | "No results for \"pricing\"." → **Clear search** / **Search all folders** |
| | Error | `ErrorState` in the list pane, folders still usable, **Retry** |
| | Rate-limited (sync) | Banner: "Gmail sync is catching up — some messages may be missing." Non-blocking. |
| Conversation | Loading | Skeleton: header + 2 bubbles |
| | Empty (nothing selected, ≥1024px) | Quiet centred prompt: "Select a conversation" + top 3 shortcuts. Not an error. |
| | Error | `ErrorState` with **Retry**; list stays usable |
| | Not found / other workspace | `notFound()` → in-shell 404 (brief §4.5: 404, never 403) |
| | Disconnected mailbox | Amber bar above composer: "sales@… is disconnected. Replies cannot be sent until you reconnect." **Composer disabled** — a Send button that cannot send is fake functionality. |
| AI panel | Loading | Two shimmer lines inside the panel |
| | Unavailable | "AI features are not configured for this workspace." No button. |
| | Rate-limited | Disabled button + reset time |
| Composer | Sending | Button pending, fields disabled, `aria-busy` |
| | Error | Inline error above the composer, body preserved, **Try again** |

---

## 6. Sequence Builder

Route: `/campaigns/[campaignId]/sequence`. The hardest a11y surface in the
product, and the one most often built as an unusable drag-and-drop canvas.

### 6.1 The shape decision: a vertical list, not a canvas

A node-graph canvas (drag nodes, draw edges) is out. Three reasons: a cold-email
sequence is **linear with conditional skips**, not an arbitrary graph, so a
canvas models something we do not have; canvas UIs are close to impossible to
make keyboard- and screen-reader-operable; and free-positioned nodes create
layouts that mean nothing.

We build a **vertical step list** — an ordered document. That maps to a real
`<ol>`, works with arrow keys and a screen reader for free, and prints.

```
┌───────────────────────────────────────────────────────────────────────┐
│  Sequence · Q4 Outbound                    ⌨ Shortcuts   [ Preview ]  │
│  3 steps · 2 variants · est. 6 days to complete                       │
│                                                                       │
│  ╭─────────────────────────────────────────────────────────────────╮  │
│  │ 1  ✉ EMAIL                                    ⋮  ▲ ▼  ⌫        │  │
│  │    Subject  Quick question about {{companyName}}                │  │
│  │    ┌───────────────────────────────────────────────────────┐    │  │
│  │    │ A  40%  ─ open 41% · reply 6.2% (206 sent)            │    │  │
│  │    │ B  60%  ─ open 38% · reply 7.9% (208 sent)   ← active │    │  │
│  │    │ [+ Add variant]                                        │    │  │
│  │    └───────────────────────────────────────────────────────┘    │  │
│  │    Body                                                         │  │
│  │    ┌───────────────────────────────────────────────────────┐    │  │
│  │    │ Hi {{firstName}},                                      │    │  │
│  │    │                                                        │    │  │
│  │    │ I noticed {{companyName}} is hiring ops staff…          │    │  │
│  │    └───────────────────────────────────────────────────────┘    │  │
│  │    [{{ }} Insert variable]   ⚠ 12 of 480 leads lack companyName │  │
│  ╰─────────────────────────────────────────────────────────────────╯  │
│                              │                                        │
│  ╭─────────────────────────────────────────────────────────────────╮  │
│  │ 2  ⧗ WAIT      3 days                         ⋮  ▲ ▼  ⌫        │  │
│  ╰─────────────────────────────────────────────────────────────────╯  │
│                              │                                        │
│  ╭─────────────────────────────────────────────────────────────────╮  │
│  │ 3  ⑂ CONDITION  If opened previous email → continue, else stop  │  │
│  │    ⚠ Open-based conditions are unreliable. Why? ▸               │  │
│  ╰─────────────────────────────────────────────────────────────────╯  │
│                              │                                        │
│              [ + Email ]  [ + Wait ]  [ + Condition ]                 │
│                                                                       │
│  Sending stops automatically when a lead replies.                     │
└───────────────────────────────────────────────────────────────────────┘
```

### 6.2 Step model

```ts
export type StepId = string;

export type SequenceStep =
  | { id: StepId; kind: "email";     position: number; variants: EmailVariant[] }
  | { id: StepId; kind: "wait";      position: number; delay: Delay }
  | { id: StepId; kind: "condition"; position: number; condition: Condition };

export type EmailVariant = {
  id: string;
  label: string;                 // "A", "B", … assigned by position
  subject: string;
  bodyHtml: string;
  bodyText: string;              // derived; what we actually send as text/plain
  weight: number;                // integer percent, variants sum to 100
  isActive: boolean;             // paused variants keep their history
};

export type Delay = { amount: number; unit: "hours" | "days" | "businessDays" };

export type Condition =
  | { type: "replied";      then: "stop" }            // implicit, always on; shown read-only
  | { type: "opened";       stepRef: StepId; then: "continue" | "stop" | "jump"; jumpTo?: StepId }
  | { type: "clicked";      stepRef: StepId; then: "continue" | "stop" | "jump"; jumpTo?: StepId }
  | { type: "hasField";     field: LeadField; then: "continue" | "skipNext" }
  | { type: "inList";       listId: string;  then: "continue" | "stop" };
```

Rules enforced by zod in `sequences/schema.ts` **and** mirrored in the UI:

1. Step 1 must be `email`. A sequence starting with a wait is a bug users make
   and never intend.
2. Two consecutive `wait` steps are collapsed on save (summed) with a toast.
3. A `wait` cannot be last (nothing follows it); saving trims it.
4. Variant weights are integers summing to 100. The UI rebalances the others
   proportionally when one changes, and shows the arithmetic.
5. `stepRef` and `jumpTo` must reference an **earlier** step (no loops).
6. Minimum wait is 1 hour. Under that, sends look automated and deliverability
   suffers; we say that in the field's help text rather than silently allowing it.
7. Max 20 steps and 5 variants per step. Not a technical limit — a guardrail
   against sequences nobody can reason about.

### 6.3 Editing model: explicit save, per-step

**No global autosave.** Each step card is independently editable and saves on
its own. Reasons: a sequence is a live sending config, so a stray keystroke
autosaved into an active campaign changes what goes out; and per-step saves keep
conflicts small.

- Clicking into a card puts it in edit mode; `Save step` / `Cancel` appear.
- Save calls `sequences.upsertStep(ctx, { campaignId, step })`, zod-validated,
  returns the persisted step. `revalidatePath` refreshes the page's server data.
- A dirty card blocks navigation via `beforeunload` **and** an in-app confirm.
- Reorder and delete are **immediate** server actions (structural, unambiguous).
  Delete of an email step that has already sent asks for confirmation and
  explains that history is retained.
- **Editing an active campaign** shows a persistent notice: "This campaign is
  active. Changes apply to emails not yet sent; already-scheduled sends for the
  next hour may use the previous version." That last clause is true because the
  scheduler materialises `ScheduledEmail` rows ahead of time — the jobs doc owns
  the exact horizon; the UI must not claim changes are instant.

Concurrent edits: each step carries a `version`. `upsertStep` fails with
`STALE_STEP` if the version moved, and the UI shows "This step was changed by
someone else" with **Reload step** / **Overwrite**. Last-write-wins silently is
unacceptable on a config that sends mail to real people.

### 6.4 Variant (A/B) editing

- Variants are tabs inside the email card: `A` `B` `C` `+`, each with a weight
  input and, when data exists, its own stats line.
- **Stats are sample-gated** (brief §10): under 100 sends per variant, the line
  reads "not enough data (42 sends)" instead of a rate. No winner is declared
  under a configured minimum; the doc's default is 100 sends/variant and a
  visible difference, and even then the UI says "B is ahead" with the sample
  size, not "B wins".
- Adding a variant clones the active one (users iterate, they don't start blank)
  and gives it weight by splitting the largest existing weight.
- Deleting a variant with send history **archives** it (`isActive=false`) rather
  than deleting, so analytics stay honest. The UI says "archived — kept for
  reporting". Only zero-history variants delete outright.
- Weights: a11y-wise these are number inputs with steppers, not sliders. A
  slider cannot be operated precisely by keyboard or announced usefully.

### 6.5 Variables and the missing-variable problem

Supported tokens (v1): `{{firstName}}`, `{{lastName}}`, `{{fullName}}`,
`{{email}}`, `{{companyName}}`, `{{jobTitle}}`, `{{city}}`, `{{country}}`,
`{{website}}`, `{{industry}}`, `{{linkedinUrl}}`, `{{senderName}}`,
`{{senderFirstName}}`, `{{mailboxSignature}}`, `{{unsubscribeLink}}`, plus
`{{custom.<key>}}` for custom lead fields.

Fallback syntax: `{{firstName | there}}` — pipe, then literal default.
One level, no nesting, no expressions. A template language inside a template
field is a maintenance trap and a security surface.

**Insertion UX.** `[{{ }} Insert variable]` opens a popover (also `⌘/`) listing
tokens with live sample values from a chosen preview lead. Enter inserts at the
caret. Typing `{{` in the body opens the same list inline as a combobox
(`role="combobox"`, `aria-expanded`, `aria-activedescendant`) — no bare
`<div>` autocomplete.

**Missing-variable UX — three layers, because this is how campaigns embarrass
people:**

1. **Authoring time.** As soon as a body references a token, the card shows
   coverage against the campaign's actual assigned leads:
   `⚠ 12 of 480 leads lack companyName`, linking to
   `/campaigns/<id>/leads?missing=companyName`. Query:

   ```sql
   SELECT count(*) FROM "CampaignLead" cl
     JOIN "Lead" l ON l.id = cl."leadId"
    WHERE cl."campaignId" = $1 AND cl."workspaceId" = $2
      AND (l."companyName" IS NULL OR l."companyName" = '');
   ```
   Exposed as `sequences.variableCoverage(ctx, campaignId)` returning
   `Record<token, { total: number; missing: number }>`.

2. **Launch time — a hard gate.** `campaigns.launch` refuses if any step
   references a token with missing values and no fallback. The dialog lists each
   token, the missing count, and three resolutions: **Add a fallback**,
   **Exclude those leads**, **Fill the data** (deep link to the filtered lead
   table). No "launch anyway" for a token with no fallback — "Hi ," costs more
   than the friction saves.

3. **Send time — last defence.** The renderer treats an unresolved token as a
   fatal render error for that one email: the `ScheduledEmail` goes
   `RENDER_FAILED`, it is **not sent**, and it appears in the campaign's problem
   list. We never emit a literal `{{firstName}}` and never silently drop the
   token leaving mangled punctuation. Failing one email loudly beats sending 480
   broken ones.

Subject lines get one extra warning: a token in the *first three characters* of
a subject is flagged, since a missing value there produces visibly broken
preview text in the recipient's client.

### 6.6 Preview against a real lead

`[ Preview ]` opens a Drawer (not a modal — the user compares against the editor
behind it):

- **Lead picker** at the top: search, plus `Random assigned lead` and
  `Lead with most missing fields` (the useful adversarial case).
- Tabs: `Rendered` (sanitised HTML as the recipient sees it), `Plain text` (the
  `text/plain` part we actually send), `Variables` (a table of token → resolved
  value, missing ones highlighted).
- Renders **through the real send-time renderer** via
  `sequences.preview(ctx, { campaignId, stepId, variantId, leadId })`. A preview
  with its own template code drifts from production and lies. Same function,
  `dryRun: true`.
- Shows the resolved sending mailbox, the signature, the unsubscribe footer, and
  the **computed send time** for this lead ("would send Tue 2 Sep, 09:14 IST")
  — which surfaces schedule mistakes before launch.
- Spam-signal hints are advisory and labelled as such: all-caps subject, ≥3
  links, image-only body, spam-trigger words. We explicitly **do not** show a
  "spam score" — we cannot observe inbox placement (brief §10) and a fake score
  invites people to optimise a number that means nothing.

### 6.7 Full keyboard operability

This is the section implementers must not shortcut.

**Structure.** The step list is `<ol>`; each card is `<li>` containing a
`role="group"` with `aria-labelledby` pointing at its heading
("Step 1, Email"). Cards are in the natural tab order.

**Card-level navigation** (focus on a card's header, roving tabindex):

| Key | Action |
|---|---|
| `↓` / `↑` | Focus next / previous step |
| `Home` / `End` | First / last step |
| `Enter` | Enter edit mode, focus first field |
| `Esc` | Leave edit mode (prompts if dirty) |
| `Alt+↑` / `Alt+↓` | **Move this step up / down** |
| `Delete` / `Backspace` | Delete step (confirm dialog) |
| `⌘D` | Duplicate step |
| `e` / `w` / `c` | Insert Email / Wait / Condition **after** focused step |
| `⌘Enter` | Save step |
| `p` | Preview from this step |

**Reordering without a mouse is `Alt+↑`/`Alt+↓`, and that is the primary
mechanism** — drag-and-drop is the secondary one. Both call the same
`sequences.reorderSteps(ctx, campaignId, orderedIds)`. After a move: focus stays
on the moved card, and an `aria-live="assertive"` region announces
"Step moved to position 2 of 4."

**Drag and drop**, when present, is implemented with a keyboard-accessible
pattern (`aria-grabbed` is deprecated; use the roving-focus + `Alt+Arrow` model
above as the accessible path and treat pointer dragging as a pure enhancement).
Drop targets are the gaps between cards, each ≥16px tall with a visible
indicator. Under `prefers-reduced-motion` dragging still works; only the
animated reflow transitions are dropped.

**Within-card tab order** is strictly visual: variant tabs → subject → insert
variable → body → save/cancel. Variant tabs are a real
`role="tablist"`/`role="tab"` with `←`/`→` and `Home`/`End`, `aria-selected`,
and panels wired via `aria-controls`.

**The body editor.** A `contenteditable` rich editor is where keyboard a11y goes
to die. Decision: the body is a plain `<textarea>` with a small formatting
toolbar that inserts lightweight markup, plus the variable combobox. It is
labelled, resizable, announces character count via `aria-describedby`, and works
with every assistive technology on day one. If rich editing is demanded later it
is a scoped project with its own a11y budget, not a library dropped in.

**Announcements.** One `aria-live="polite"` region for save results ("Step 1
saved", "12 of 480 leads lack companyName") and one `aria-live="assertive"` for
structural changes (move, delete, add). Two regions, distinct urgency — a
single region makes routine saves interrupt screen-reader speech.

**Focus after destructive actions.** Deleting a step moves focus to the step
that took its position, or to the `+ Email` button if the list is now empty.
Never to `<body>`.

**Shortcut discoverability.** `⌨ Shortcuts` in the header, and `?` opens the
same sheet. Every shortcut here also exists as a visible control — keyboard is
an accelerator, never the only path.

### 6.8 Sequence builder states

| State | Render |
|---|---|
| Loading | Three card skeletons at real card height + the add-step row |
| Empty | Single centred card: "Start your sequence" with **Add first email** (only Email offered — rule 1 in §6.2) and one line on what a sequence is |
| Saving a step | That card only: `aria-busy`, fields disabled, others fully usable |
| Error (load) | `ErrorState` with **Retry**; campaign header/tabs stay usable |
| Error (save) | Inline in the card, edits preserved, **Try again**; never a toast alone — a toast that vanishes loses the only record of the failure |
| Stale | "Changed by someone else" with **Reload step** / **Overwrite** |
| Unauthorized | `MEMBER` role without campaign-edit permission gets the whole builder read-only, with a banner naming the reason. Fields are `readOnly`/`disabled`, not hidden — seeing the sequence is fine, editing is not |
| Active-campaign warning | Persistent notice per §6.3 |
| Launch blocked | Modal listing missing-variable problems and the three resolutions (§6.5) |

---

## 7. Leads

### 7.1 Table design

`/leads` is the workspace's densest data view. Row height 48px (brief §7 says
tables breathe; 48 is the compromise between air and seeing 15 rows on a laptop).

Default columns, left to right:

| Column | Content | Sortable | Default width |
|---|---|---|---|
| ☐ | selection checkbox | no | 40px |
| Name | `firstName lastName`, link to profile; falls back to email when nameless | yes (`lastName`) | 200px |
| Email | monospace, copy button on hover/focus | yes | 240px |
| Company | company name, link to website when present | yes | 180px |
| Title | job title, truncated with `title` attr | no | 160px |
| Status | `StatusBadge` — lead lifecycle (New, Contacted, Replied, Interested, Not interested, Bounced, Unsubscribed) | yes | 130px |
| Campaigns | up to 2 chips + "+N" | no | 160px |
| Last activity | relative time, `<time>` with absolute in `title` | yes | 130px |
| Tags | up to 2 chips + "+N" | no | 140px |
| ⋮ | row actions menu | no | 44px |

Optional columns, toggled via a column menu and persisted in `localStorage`
(a view preference, not shareable state — it does not belong in the URL):
`city`, `country`, `industry`, `linkedinUrl`, `phone`, `leadScore`, `source`,
`createdAt`, `verifiedAt`, `custom.<key>`.

Name, Email, and Status are pinned on (unhideable) — a lead table without them
is not a lead table. Name column is sticky-left at ≥1280px so horizontal
scrolling keeps identity visible.

Row actions: View profile, Add to campaign, Add to list, Add tags, Edit,
Copy email, Add to suppression list, Delete.

### 7.2 URL-driven server-side query

All list state lives in search params:

```
/leads?q=acme&status=REPLIED,INTERESTED&campaign=<id>&list=<id>&tag=<id>
      &sort=lastActivityAt&dir=desc&page=3&per=50&missing=companyName
```

Parsed once, server-side, with zod:

```ts
// modules/leads/schema.ts
export const leadListParams = z.object({
  q:        z.string().trim().max(200).optional(),
  status:   z.string().transform(csv).pipe(z.array(z.nativeEnum(LeadStatus))).optional(),
  campaign: z.string().uuid().optional(),
  list:     z.string().uuid().optional(),
  tag:      z.string().uuid().optional(),
  missing:  z.enum(LEAD_FIELDS).optional(),
  sort:     z.enum(["lastName","email","companyName","status","lastActivityAt","createdAt","leadScore"])
              .default("createdAt"),
  dir:      z.enum(["asc","desc"]).default("desc"),
  page:     z.coerce.number().int().min(1).max(10_000).default(1),
  per:      z.union([z.literal(25), z.literal(50), z.literal(100)]).default(50),
});
export type LeadListParams = z.infer<typeof leadListParams>;
```

Unknown or malformed params are **dropped, not rejected** — a stale bookmark
should show the default list, not an error. Only `page`/`per` clamp.

```ts
// modules/leads/index.ts
export function list(ctx: Ctx, params: LeadListParams): Promise<Page<LeadRow>>;

export type Page<T> = {
  rows: T[];
  total: number;          // exact; see note
  page: number;
  per: number;
  pageCount: number;
};
```

Sort is **always** `ORDER BY <col> <dir>, id ASC` — a non-unique sort key without
a tiebreak makes offset pagination non-deterministic and rows appear twice.

`total` is an exact `count(*)` over the same predicate. Leads are hundreds of
thousands at most per workspace, and an exact count on an indexed predicate is
acceptable; if a workspace ever crosses ~1M leads we switch that one number to
an estimate and label it `~`. Stated here so nobody "optimises" it prematurely.

Offset pagination (not cursor) for leads, deliberately: users jump to page 7,
the data changes slowly, and "select all matching" (§7.3) needs a stable notion
of a filtered set. The inbox is the opposite case and uses cursors (§5.3).

Filter changes reset `page` to 1. Every param write is
`router.replace(url, { scroll: false })` for filter/sort, `router.push` for page
changes — so back moves through pages, not through every keystroke of a search.
`q` is debounced 300ms.

### 7.3 Bulk selection across pages

Two distinct modes, never conflated:

```ts
type Selection =
  | { mode: "ids";     ids: Set<string> }                  // explicit rows
  | { mode: "matching"; excluded: Set<string>; total: number }; // the whole filtered set
```

- Header checkbox selects **the current page** → `mode: "ids"`.
- When a page is fully selected, a bar appears: *"50 selected · Select all 1,284
  matching this filter"* → switches to `mode: "matching"`. Unchecking a row then
  adds to `excluded`.
- The bar always states the mode in words: "50 leads selected" vs. "All 1,284
  leads matching the current filter selected (2 excluded)".
- Selection **clears when filters change**, with the count announced via
  `aria-live`. Silently carrying a selection across a filter change is how people
  bulk-delete the wrong 1,000 rows.
- Selection is client state only. It is not in the URL and does not survive a
  reload — an intentional choice, because a resurrected selection the user has
  forgotten about is dangerous.

Bulk actions submit the **selection descriptor, not 1,284 ids**:

```ts
export type BulkTarget =
  | { kind: "ids"; ids: string[] }                     // capped at 1000
  | { kind: "filter"; params: LeadListParams; excluded: string[] };

export function bulkAddToCampaign(ctx: Ctx, t: BulkTarget, campaignId: string): Promise<Result<{ affected: number }, BulkError>>;
export function bulkAddTags(ctx: Ctx, t: BulkTarget, tagIds: string[]): Promise<Result<{ affected: number }, BulkError>>;
export function bulkAddToList(ctx: Ctx, t: BulkTarget, listId: string): Promise<Result<{ affected: number }, BulkError>>;
export function bulkSuppress(ctx: Ctx, t: BulkTarget, reason: string): Promise<Result<{ affected: number }, BulkError>>;
export function bulkDelete(ctx: Ctx, t: BulkTarget): Promise<Result<{ affected: number }, BulkError>>;
```

The server re-derives the set from the filter under the session's workspace, so
a client cannot widen the blast radius by sending a bigger id list than it
displayed, and `filter` mode never needs a 1,284-element request body.

Above 500 affected rows the action is queued as a background job and the UI shows
"Working on 1,284 leads…" with progress, rather than holding a request open.

`bulkDelete` requires a typed confirmation (the exact count typed into a field)
and is `ADMIN+`. It writes an audit-log entry (brief §6).

### 7.4 CSV import wizard

Four steps, each its own URL so refresh and back work: `upload → map → review →
running`. The import is a **server-side resource** (`LeadImport` row) from the
first byte; wizard state is never held in the browser.

```
 upload ──────────► map ──────────► review ──────────► running ──────► done
   │                 │                │                   │
 POST /api/leads/    detect headers   validate all rows    queued job
 import (streamed)   → suggest map    → counts + 20 rows   → progress + errors.csv
```

**Step 1 — Upload** (`/leads/import`)

Dropzone + file input (both; a dropzone alone is not keyboard-accessible).
Streams to `POST /api/leads/import` — not a server action, because server
actions buffer the body and a 20MB CSV in memory is a denial-of-service on
ourselves. Limits stated **before** upload, not after rejection: max 20MB, max
50,000 rows, `.csv`/`.tsv`, UTF-8 (with BOM tolerated). The route detects the
delimiter, sniffs encoding, stores the file outside the DB, persists the header
row + first 50 data rows for the mapper, and returns `{ importId }`.

Rate limited per workspace (brief §6).

**Step 2 — Map columns** (`/leads/import/[importId]/map`)

Two-column layout: CSV header (with 3 sample values) ↔ lead field select.
Auto-mapping is normalised-name matching (`"Company Name"`, `company_name`,
`companyname` → `companyName`) plus an email-format sniff on the sample values.
Every mapping is user-overridable; nothing is silently guessed and hidden.

Unmapped columns get three options: **Ignore**, **Import as custom field**
(names the key), or map to an existing field. `email` is mandatory — Continue is
disabled with the reason shown, not just greyed.

Also on this step: duplicate policy (**Skip** / **Update existing** / **Create
anyway**, default Skip, matched on `(workspaceId, lower(email))`), optional
"add all to list", optional "add all to campaign", and a tag to apply.

**Step 3 — Review** (`/leads/import/[importId]/review`)

Server validates **every row** (streamed, not just the sample) and reports:

```ts
export type ImportValidation = {
  totalRows: number;
  valid: number;
  invalid: number;
  duplicatesInFile: number;
  duplicatesInWorkspace: number;
  suppressed: number;               // on the do-not-contact list — excluded, always
  errors: RowError[];               // capped at 100 for display; full set in errors.csv
  sample: MappedRow[];              // first 20 valid rows, exactly as they will be stored
};

export type RowError = {
  row: number;                      // 1-based, matching the CSV including header offset
  column: string | null;
  value: string;                    // truncated to 80 chars
  code: "MISSING_EMAIL" | "INVALID_EMAIL" | "DUPLICATE_IN_FILE"
      | "DUPLICATE_IN_WORKSPACE" | "SUPPRESSED" | "FIELD_TOO_LONG" | "INVALID_ENUM";
  message: string;
};
```

Displayed as: a count summary, then a table of errors with **row number, column,
offending value, and reason** — per-row reporting is the whole point; "312 rows
failed" with no detail is useless. `Download error report (CSV)` gives the full
set. Then the 20-row preview of what will actually be stored.

Invalid rows do not block the import: **valid rows import, invalid rows are
reported.** All-or-nothing on a 50k-row file with 3 bad emails is hostile.
Suppressed addresses are always excluded and the count says so.

CSV export escaping applies here too on the way out — cells beginning `=`, `+`,
`-`, `@`, tab, or CR are prefixed with `'` (brief §6, formula injection).

**Step 4 — Running** (`/leads/import/[importId]/running`)

Commit enqueues a job. The page shows a determinate progress bar
(`processed / total`), live counts of created/updated/skipped/failed, and the
error table as it fills. Polled every 2s by a client leaf calling
`leads.getImport(ctx, importId)` while status is `RUNNING`; polling stops on a
terminal state. **The user may navigate away** — the import is server-side, and
the page says so explicitly ("Safe to leave this page").

On completion: summary, `View imported leads` (deep-links to
`/leads?list=<id>` or `?source=import:<id>`), `Download error report`, and
`Import another file`.

Idempotency: the commit action carries the `importId` and the import row has a
unique `committedJobId`; double-clicking Start cannot enqueue two runs.

### 7.5 Lead profile

`/leads/[leadId]`. Two-column at ≥1280px, stacked below.

```
┌──────────────────────────────────────┬──────────────────────────────┐
│  Sara Kaplan                         │  Details                     │
│  VP Operations · Meridian Health     │  Email    sara@meridian…  ⧉  │
│  ● Interested   score 82             │  Phone    +1 415 …           │
│  [Add to campaign] [Email] [⋮]       │  Company  Meridian Health    │
│                                      │  Title    VP Operations      │
│  Tabs: Activity │ Conversations │    │  City     San Francisco      │
│        Campaigns │ Notes │ Fields    │  Industry Healthcare         │
│  ──────────────────────────────────  │  LinkedIn /in/sarakaplan  ↗  │
│  ActivityTimeline                    │  Source   import:8f2c        │
│   28 Aug  Replied to "Quick q…"      │  Added    12 Aug 2026        │
│   24 Aug  Email sent (step 2)        │  ─────────────────────────   │
│   21 Aug  Email opened  (indicative) │  Tags   [enterprise] [+]     │
│   20 Aug  Email sent (step 1)        │  Lists  Q4 ICP               │
│   12 Aug  Imported from leads.csv    │  ─────────────────────────   │
│                                      │  Opportunity                 │
│                                      │  Demo — Qualified  $—        │
└──────────────────────────────────────┴──────────────────────────────┘
```

- **Activity** — `ActivityTimeline` of `EmailEvent` + notes + status changes +
  CRM events. Open events labelled indicative.
- **Conversations** — threads for this lead, each linking into the inbox.
- **Campaigns** — every campaign membership with current sequence position,
  next scheduled send, and a per-campaign **Stop sequence** (confirm).
- **Notes** — internal notes, newest first, optimistic append.
- **Fields** — all standard + custom fields, inline-editable (click → input →
  Enter saves, Esc cancels), each save its own action.

Right rail is read-only summary + tags/lists/opportunity. `⋮` holds Delete lead
(confirm, ADMIN+), Add to suppression list, Export this lead.

Unsubscribed or suppressed leads show a prominent bar: "This lead unsubscribed
on 3 Aug. They cannot be added to campaigns." and **Add to campaign is
genuinely disabled** — the server refuses too.

### 7.6 Leads states

| Surface | State | Render |
|---|---|---|
| Lead table | Loading | 10 skeleton rows, real column widths, header live so sort is visible |
| | Empty, no leads at all | `EmptyState`: "No leads yet. Import a CSV or add one by hand." → **Import CSV** (primary) / **Add lead** |
| | Empty, filtered | "No leads match these filters." → **Clear filters** (never the import CTA — wrong action for the situation) |
| | Empty, search | "No leads matching \"acme\"." → **Clear search** |
| | Error | `ErrorState` replacing the table body; `FilterBar` stays usable, **Retry** |
| | Unauthorized | Not reachable; `(app)` layout redirects. Bulk delete for non-admins is hidden and server-refused |
| | Bulk in progress | Toolbar becomes a progress strip; table stays readable, actions disabled |
| Import step 1 | Error | Inline: file too large / wrong type / cannot parse — each with the actual limit |
| Import step 2 | Empty | "We could not detect any columns. Check the file has a header row." → **Upload a different file** |
| Import step 3 | All rows invalid | Start disabled + "No valid rows to import" + error table + **Fix and re-upload** |
| Import step 4 | Error | Partial-result summary (created/failed), error CSV, **Retry failed rows** |
| | Rate-limited | "Import limit reached — try again in 12 minutes", queued not lost |
| Lead profile | Loading | Header skeleton + right-rail skeleton; tabs render immediately |
| | Not found / other workspace | `notFound()` → in-shell 404 |
| | Error | `ErrorState` in the main column; right rail still shows what loaded |

---

## 8. The five-states rule, applied to every surface

Sections 4–7 covered Dashboard, Inbox, Sequence Builder, and Leads in detail.
This is the remaining set. Every row is a commitment, not a suggestion; a PR that
ships a surface missing a row here does not pass review.

Columns: **L**oading · **E**mpty (with its CTA) · **Er**ror · **U**nauthorized ·
**Extra** (disconnected / rate-limited / stale, where they apply).

### Campaigns

| Surface | L | E | Er | U | Extra |
|---|---|---|---|---|---|
| `/campaigns` | 4 card skeletons | "No campaigns yet." → **New campaign**. If no mailbox: "Connect a mailbox first" → **Connect mailbox** (correct first step, not a campaign form that cannot launch) | `ErrorState` + Retry | n/a (shell guards) | Banner if all mailboxes unhealthy: "Sending is paused — no healthy mailbox" |
| `/campaigns/new` | n/a (form) | Mailbox select empty → inline "No sendable mailbox" + **Connect mailbox**; Create disabled | Inline field errors + form-level error | `MEMBER` without create permission: 404 | — |
| `/campaigns/[id]` overview | Header skeleton + 4 stat skeletons | Draft with no leads/steps: checklist — Add leads · Build sequence · Set schedule · Launch, each linking to its tab, completed ones ticked | Per-section `ErrorState`; header/tabs stay | Read-only banner for restricted roles | Paused-by-system banner naming the cause + fix |
| `/campaigns/[id]/leads` | 10 row skeletons | "No leads in this campaign." → **Add leads** | `ErrorState` + Retry | Read-only | Warning when leads exceed remaining daily capacity, with the computed completion date |
| `/campaigns/[id]/schedule` | Form skeleton | n/a (always has defaults) | Inline + form-level | Read-only | "Window is 0 hours — nothing will send" hard warning; capacity estimate recomputes live |
| `/campaigns/[id]/analytics` | Chart + table skeletons | "No sends yet — analytics appear after the first email goes out." No zeroed charts | `ErrorState` + Retry | Read-only | Sample-size notice suppressing rates under threshold |
| `/campaigns/[id]/settings` | Form skeleton | n/a | Inline | Read-only; Delete hidden for non-admin | Editing an active campaign: §6.3 notice |

### Mailboxes

| Surface | L | E | Er | U | Extra |
|---|---|---|---|---|---|
| `/mailboxes` | 2 card skeletons | "No mailboxes connected. Campaigns need a real mailbox to send from." → **Connect Gmail** | `ErrorState` + Retry | n/a | **Disconnected**: card in amber with **Reconnect**. **Rate-limited**: "At daily cap — resumes 09:00 IST". **Sync failing**: last error + timestamp |
| `/mailboxes/connect` | n/a | n/a | OAuth error surfaced by code with plain-language meaning (access_denied, invalid_scope, redirect mismatch) + **Try again** | 404 for `MEMBER` if mailbox-connect is admin-only | Gmail scope warning: what we request and why, before redirect |
| `/mailboxes/[id]` | Header + form skeletons | Error log empty: "No send errors recorded." (good news, stated plainly) | `ErrorState` | Read-only | **Disconnected**: everything read-only except **Reconnect**. Quota panel states we cannot read Gmail's true remaining quota |

### CRM

| Surface | L | E | Er | U | Extra |
|---|---|---|---|---|---|
| `/crm` pipeline | Column skeletons per stage | "No opportunities yet. Positive replies can become opportunities from the inbox." → **New opportunity** | `ErrorState` + Retry | n/a | Drag-move failure rolls the card back with a toast |
| `/crm/opportunities` | 10 row skeletons | Same as pipeline | `ErrorState` | n/a | — |
| `/crm/opportunities/[id]` | Detail skeleton | Notes/tasks empty inline: "No notes yet" → **Add note** | `ErrorState` | n/a | 404 on cross-workspace |
| `/crm/tasks` | Grouped skeletons | "No open tasks." → **New task** | `ErrorState` | n/a | Overdue group is amber with a count, not red — overdue is normal, not an error |

### Analytics

| Surface | L | E | Er | U | Extra |
|---|---|---|---|---|---|
| `/analytics` overview | Stat + one chart skeleton | "No email activity yet." → **View campaigns** | `ErrorState` + Retry | n/a | Global banner: "Open and click tracking are indicative — many mail clients block them." Not dismissible on this section |
| `/analytics/campaigns` | Table skeleton | "No campaigns have sent yet." | `ErrorState` | n/a | Rates below sample threshold render `—` with a tooltip stating the threshold |
| `/analytics/steps` | Table skeleton | "No step data yet." | `ErrorState` | n/a | Comparative claims suppressed under minimum sample (brief §10) |
| `/analytics/mailboxes` | Table skeleton | "No mailbox activity yet." → **Connect mailbox** | `ErrorState` | n/a | Rate-limited mailboxes flagged in-row |

### AI

| Surface | L | E | Er | U | Extra |
|---|---|---|---|---|---|
| `/ai` insights | 3 card skeletons | "No insights yet — insights need at least a few hundred sends." Says the actual threshold | `ErrorState` + Retry | n/a | **AI not configured**: honest panel, no fake insights, links to settings. **Rate-limited**: "AI paused — budget reached", existing insights still readable |
| `/ai/personalisation` | Table skeleton | "No personalisation runs yet." → **Start a run** (disabled with reason if AI unconfigured) | `ErrorState` | `MEMBER` may view, not run | Cost estimate shown before starting; hard stop at workspace budget |
| `/ai/usage` | Chart + table skeleton | "No AI usage this period." | `ErrorState` | ADMIN+ for budget edit | Budget-exceeded banner naming which features are paused |

### Deliverability

| Surface | L | E | Er | U | Extra |
|---|---|---|---|---|---|
| `/deliverability` | Card skeletons | "Connect a mailbox to check deliverability." → **Connect mailbox** | `ErrorState` | n/a | Permanent caveat: "We cannot observe inbox vs. spam placement. These are configuration and engagement signals, not placement guarantees." |
| `/deliverability/dns` | Record skeletons | n/a | DNS lookup failure: "Could not resolve records for northwind.io" + **Re-check** + last successful check time | n/a | Records shown in JetBrains Mono with copy buttons; **Stale**: "Last checked 3 days ago" |
| `/deliverability/warmup` | Table skeleton | "No warmup schedules." → **Start warmup** | `ErrorState` | n/a | Warmup paused because mailbox unhealthy — stated on the row |
| `/deliverability/suppressions` | Table skeleton | "No suppressed addresses." → **Add suppression** / **Import list** | `ErrorState` | ADMIN+ to remove entries | — |

### Settings

| Surface | L | E | Er | U | Extra |
|---|---|---|---|---|---|
| `/settings/profile` | Form skeleton | n/a | Inline + form-level | n/a | Email change requires re-auth |
| `/settings/workspace` | Form skeleton | n/a | Inline | `MEMBER`: read-only with banner | — |
| `/settings/members` | Table skeleton | Invites empty: "No pending invites." → **Invite member** | Inline per row | `MEMBER`: 404 | Invite rate-limited: "Invite limit reached — try again in an hour" |
| `/settings/security` | Session-list skeleton | n/a (current session always exists) | Inline | n/a | Current session marked and not revocable from the list |
| `/settings/api-keys` | Table skeleton | "No API keys." → **Create key** | Inline | `MEMBER`: 404 | Key shown once on creation with an explicit "you will not see this again" |
| `/settings/audit-log` | 15 row skeletons | "No audit events for these filters." → **Clear filters** | `ErrorState` | `MEMBER`: 404 | — |
| `/settings/billing` | n/a | Honest panel: "Billing is not enabled in this deployment." No pricing table, no disabled Upgrade button pretending to exist | n/a | OWNER only | — |

### Auth and marketing

| Surface | L | E | Er | U | Extra |
|---|---|---|---|---|---|
| `/login`, `/register`, `/forgot-password`, `/reset-password` | Button pending state | n/a | Field errors + one form-level error. Login failure is deliberately generic ("Email or password is incorrect") — enumeration defence | Already signed in → redirect to `/dashboard` | **Rate-limited**: "Too many attempts. Try again in 5 minutes." with a real remaining time |
| `/accept-invite/[token]` | Skeleton card | n/a | Invalid/expired/used token each get a distinct, non-leaky message + **Go to sign in** | Signed in as the wrong user: "This invite is for other@x.com" + **Sign out and continue** | — |
| `/unsubscribe/[token]` | n/a | n/a | Invalid token: "This link is no longer valid." Never reveals whether the address exists | n/a | Already unsubscribed → idempotent success, not an error |
| `/onboarding` | Step skeleton | n/a | Inline | n/a | Skippable; skipping lands on a dashboard whose empty state carries the same steps |

### Global

| Case | Render |
|---|---|
| Unmatched URL, signed out | root `not-found.tsx` — marketing chrome, link home |
| Unmatched URL, signed in | `(app)/not-found.tsx` — **in the shell**, sidebar intact, "That page does not exist" + **Back to dashboard** |
| Cross-workspace resource | Same in-shell 404. Never 403, never "you do not have access" (brief §4.5) |
| Session expired mid-action | Server action returns `UNAUTHENTICATED`; client shows a modal "Your session expired" → **Sign in again**, preserving the current URL as `?next=`. Never a silent failure |
| Uncaught render error | Nearest `error.tsx`; root `global-error.tsx` as backstop with an error id to quote to support |
| Offline | Optimistic actions roll back with "You appear to be offline — change not saved." Detected on action failure, not by trusting `navigator.onLine` alone |

---

## 9. Component inventory

Two folders, one rule: **`components/ui/**` is pure presentation** — no module
imports, no data fetching, no server-only code (brief §3, rule 3).
`components/patterns/**` composes primitives into product-shaped pieces and may
accept module *types* as props, but still never fetches. **Data comes from server
components in `app/**` and is passed down as props.**

### 9.1 `components/ui/` — primitives

Vendored from shadcn/ui, restyled to the brief's tokens, then owned by us.

| File | Notes on our restyle |
|---|---|
| `button.tsx` | variants `primary` (pill, `--accent`) · `secondary` (hairline border, `md` radius) · `ghost` · `danger` · `link`; sizes `sm/md/lg/icon`. Icon-only buttons **require** `aria-label` (enforced by a discriminated prop type, §9.4) |
| `input.tsx`, `textarea.tsx` | `md` radius, hairline border, visible focus ring, `aria-invalid` wiring |
| `select.tsx`, `combobox.tsx`, `multi-select.tsx` | Radix Select / cmdk-backed combobox |
| `checkbox.tsx`, `radio-group.tsx`, `switch.tsx` | switch only for instant-effect settings |
| `label.tsx`, `field.tsx` | `field` binds label + description + error to one control (`aria-describedby`, `aria-invalid`) — the single reason our forms are accessible by default |
| `badge.tsx` | neutral chip; `StatusBadge` (pattern) adds semantics |
| `card.tsx` | `--surface` on `--bg`, hairline border, rest shadow |
| `table.tsx` | semantic `<table>` primitives, sticky header, `--bg-subtle` header fill, 48px rows |
| `tabs.tsx` | Radix Tabs, arrow-key navigation |
| `dialog.tsx`, `sheet.tsx`, `drawer.tsx`, `popover.tsx`, `dropdown-menu.tsx`, `tooltip.tsx`, `context-menu.tsx` | Radix; focus trap + restore for free. Tooltips never carry information available nowhere else |
| `toast.tsx` (+ `toaster.tsx`) | `aria-live="polite"`, 8s default, supports an Undo action |
| `skeleton.tsx` | shimmer honours `prefers-reduced-motion` (becomes a static fill) |
| `progress.tsx` | determinate only; indeterminate work uses `LoadingState` |
| `avatar.tsx`, `separator.tsx`, `scroll-area.tsx`, `kbd.tsx`, `copy-button.tsx`, `relative-time.tsx`, `pagination.tsx`, `breadcrumb.tsx`, `alert.tsx`, `command.tsx`, `resizable.tsx`, `visually-hidden.tsx` | `relative-time.tsx` is the only place relative formatting exists — it renders `<time dateTime>` with the absolute value in `title` |

Two primitives worth calling out:

- **`copy-button.tsx`** — used for emails, DNS records, IDs. Announces "Copied"
  via `aria-live`; never a silent icon flip.
- **`relative-time.tsx`** — a client component because it needs the viewer's
  timezone, but it accepts a server-formatted absolute string as a fallback so
  SSR output is not empty and hydration cannot mismatch.

### 9.2 `components/patterns/` — composites

```
patterns/
  data-table/      data-table.tsx  columns.ts  bulk-bar.tsx  column-menu.tsx
  filter-bar/      filter-bar.tsx  filter-chip.tsx  saved-views.tsx
  status-badge.tsx
  email-thread/    email-thread.tsx  message-bubble.tsx  attachment-list.tsx
  lead-table.tsx
  lead-profile/    lead-profile.tsx  lead-fields.tsx
  campaign-card.tsx
  campaign-stats.tsx
  sequence-builder/ sequence-builder.tsx  step-card.tsx  variant-tabs.tsx
                    variable-menu.tsx  preview-drawer.tsx
  mailbox-card.tsx
  activity-timeline.tsx
  analytics-chart.tsx
  ai-insight-card.tsx
  empty-state.tsx  loading-state.tsx  error-state.tsx
  page-shell.tsx   section.tsx
  command-palette.tsx
  app-shell/       app-shell.tsx  sidebar.tsx  header.tsx  workspace-switcher.tsx
  confirm-dialog.tsx
```

#### Props contracts

```ts
// ─── DataTable ────────────────────────────────────────────────────────────
// Generic, presentational, URL-driven. Does NOT fetch and does NOT sort —
// the server already did both. It renders and it emits intent.
export type Column<T> = {
  id: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  sortKey?: string;             // present => header is a sort button
  width?: number | string;
  align?: "left" | "right";
  sticky?: "left";
  hideable?: boolean;           // default true; false pins the column on
  defaultHidden?: boolean;
};

export type DataTableProps<T> = {
  rows: T[];
  columns: Column<T>[];
  getRowId: (row: T) => string;
  page: { page: number; per: number; total: number; pageCount: number };
  sort?: { key: string; dir: "asc" | "desc" };
  selection?: {
    value: Selection;                               // §7.3
    onChange: (next: Selection) => void;
    totalMatching: number;
    enableSelectAllMatching?: boolean;
  };
  rowHref?: (row: T) => string;                     // whole row becomes a link
  rowActions?: (row: T) => MenuItem[];
  onRowFocus?: (id: string) => void;
  emptyState: React.ReactNode;                      // caller decides — filtered vs. truly empty
  isLoading?: boolean;                              // renders skeleton rows, keeps header
  error?: { message: string; onRetry: () => void };
  density?: "comfortable" | "compact";
  caption: string;                                  // required: <caption> for screen readers
};

// ─── FilterBar ────────────────────────────────────────────────────────────
export type FilterDef =
  | { kind: "search";      key: string; placeholder: string }
  | { kind: "select";      key: string; label: string; options: Opt[] }
  | { kind: "multiselect"; key: string; label: string; options: Opt[] }
  | { kind: "dateRange";   key: string; label: string; presets?: DatePreset[] }
  | { kind: "toggle";      key: string; label: string };

export type FilterBarProps = {
  filters: FilterDef[];
  values: Record<string, string | string[] | undefined>;  // from searchParams
  onChange: (key: string, value: string | string[] | undefined) => void; // writes URL
  onClearAll: () => void;
  resultCount?: number;                             // "1,284 leads"
  actions?: React.ReactNode;                        // page primary action slot
};
// Active filters render as removable pill chips beneath the controls, so the
// current filter state is legible without opening every dropdown.

// ─── StatusBadge ──────────────────────────────────────────────────────────
export type StatusKind =
  | "lead"        // NEW CONTACTED REPLIED INTERESTED NOT_INTERESTED BOUNCED UNSUBSCRIBED
  | "campaign"    // DRAFT ACTIVE PAUSED COMPLETED ARCHIVED
  | "mailbox"     // HEALTHY WARMING RATE_LIMITED DISCONNECTED AUTH_FAILED ERROR
  | "job"         // PENDING RUNNING SUCCEEDED FAILED DEAD_LETTER
  | "aiCategory"  // INTERESTED MEETING_REQUEST QUESTION NOT_INTERESTED
                  // UNSUBSCRIBE OUT_OF_OFFICE WRONG_PERSON AUTO_REPLY BOUNCE
  | "opportunity";// NEW QUALIFIED PROPOSAL WON LOST

export type StatusBadgeProps = {
  kind: StatusKind;
  value: string;
  size?: "sm" | "md";
  confidence?: number;        // AI only; renders "0.91" and a tooltip with model+version
  showIcon?: boolean;         // default true
};
// One central map from (kind, value) -> { label, tone, Icon }. Tone drives colour;
// label and icon carry the meaning, so colour is never the only signal (brief §7).
// An unknown value renders neutral with the raw string — never blank.

// ─── EmailThread ──────────────────────────────────────────────────────────
export type ThreadMessage = {
  id: string;
  direction: "inbound" | "outbound";
  from: { name: string | null; email: string };
  to: string[]; cc: string[];
  subject: string;
  sanitizedHtml: string | null;   // sanitised SERVER-side; never raw provider HTML
  text: string;
  sentAt: string;                 // ISO UTC
  attachments: Attachment[];
  hasRemoteImages: boolean;       // drives the "Show images" toggle
  sequenceStep?: { position: number; variantLabel: string | null };
  mailboxEmail?: string;
};

export type EmailThreadProps = {
  messages: ThreadMessage[];
  expandedIds?: string[];         // default: newest + all unread
  viewerTimezone: string;
  onExpandChange?: (ids: string[]) => void;
  onDownloadAttachment: (messageId: string, attachmentId: string) => void;
};

// ─── LeadTable ────────────────────────────────────────────────────────────
// A thin, opinionated wrapper: it owns the lead column set and URL param names,
// and delegates everything else to DataTable.
export type LeadTableProps = {
  page: Page<LeadRow>;
  params: LeadListParams;
  visibleColumns?: string[];
  selection: Selection;
  onSelectionChange: (s: Selection) => void;
  bulkActions: BulkAction[];
  context?: { campaignId?: string; listId?: string };  // changes available bulk actions
};

// ─── LeadProfile ──────────────────────────────────────────────────────────
export type LeadProfileProps = {
  lead: LeadDetail;
  campaigns: LeadCampaignMembership[];
  threads: ThreadSummary[];
  timeline: TimelineItem[];
  notes: Note[];
  opportunity: OpportunitySummary | null;
  canEdit: boolean;
  canDelete: boolean;
  activeTab: "activity" | "conversations" | "campaigns" | "notes" | "fields";
};

// ─── CampaignCard ─────────────────────────────────────────────────────────
export type CampaignCardProps = {
  campaign: {
    id: string; name: string; status: CampaignStatus;
    leadCount: number; sentCount: number;
    replyRate: number | null;     // null => below sample threshold, renders "—"
    nextSendAt: string | null;
    mailboxes: { id: string; email: string; status: MailboxStatus }[];
    stepCount: number;
  };
  problems?: Problem[];           // renders an inline amber strip with a fix link
  onLaunch?: () => void;          // absent => control not rendered (role or state)
  onPause?: () => void;
  href: string;
};

// ─── CampaignStats ────────────────────────────────────────────────────────
export type Metric = {
  label: string;
  value: number | null;           // null => suppressed
  format: "count" | "percent";
  sampleSize?: number;            // shown when suppressed or when < threshold
  reliability?: "measured" | "indicative";  // "indicative" => open/click, adds caveat
  delta?: { value: number; direction: "up" | "down"; period: string };
  href?: string;
};

export type CampaignStatsProps = {
  metrics: Metric[];              // max 6 — beyond that nobody reads them
  funnel?: { sent: number; delivered: number; opened: number | null;
             replied: number; positive: number };
};
// Any metric with reliability:"indicative" renders a superscript marker resolving
// to "Open tracking is blocked by many mail clients." Non-negotiable (brief §10).

// ─── SequenceBuilder ──────────────────────────────────────────────────────
export type SequenceBuilderProps = {
  campaignId: string;
  campaignStatus: CampaignStatus;
  steps: SequenceStep[];
  coverage: Record<string, { total: number; missing: number }>;  // §6.5
  variantStats?: Record<string, { sent: number; opened: number | null; replied: number }>;
  previewLeads: { id: string; name: string; email: string }[];
  minSampleForStats: number;      // gate value, rendered in the UI, not hardcoded in copy
  readOnly: boolean;
  actions: {
    upsertStep:  (step: SequenceStep) => Promise<Result<SequenceStep, StepError>>;
    deleteStep:  (id: StepId) => Promise<Result<void, StepError>>;
    reorder:     (orderedIds: StepId[]) => Promise<Result<void, StepError>>;
    preview:     (a: { stepId: StepId; variantId: string; leadId: string })
                   => Promise<Result<RenderedEmail, RenderError>>;
  };
};

// ─── MailboxCard ──────────────────────────────────────────────────────────
export type MailboxCardProps = {
  mailbox: {
    id: string; email: string; displayName: string | null;
    provider: "GMAIL" | "OUTLOOK" | "SMTP";
    status: MailboxStatus;
    statusMessage: string | null;          // the actual provider error, plain-language
    sentToday: number; dailyCap: number;
    warmup: { day: number; targetPerDay: number } | null;
    lastSyncAt: string | null;
    campaignCount: number;
  };
  onReconnect?: () => void;
  onDisconnect?: () => void;               // absent for non-admins
  href: string;
};

// ─── ActivityTimeline ─────────────────────────────────────────────────────
export type TimelineItem = {
  id: string;
  at: string;                              // ISO UTC
  kind: "email_sent" | "email_delivered" | "email_opened" | "email_clicked"
      | "email_replied" | "email_bounced" | "email_failed" | "unsubscribed"
      | "lead_imported" | "status_changed" | "note_added" | "task_created"
      | "task_completed" | "opportunity_created" | "stage_changed"
      | "ai_classified" | "campaign_launched" | "sequence_stopped";
  title: string;
  detail?: string;
  actor?: { kind: "user" | "system" | "ai"; name: string };
  href?: string;
  reliability?: "measured" | "indicative";
};

export type ActivityTimelineProps = {
  items: TimelineItem[];
  viewerTimezone: string;
  groupBy?: "day" | "none";                // default "day"
  onLoadMore?: () => void;
  hasMore?: boolean;
  emptyMessage: string;
};

// ─── AnalyticsChart ───────────────────────────────────────────────────────
export type Series = {
  key: string; label: string;
  points: { x: string; y: number }[];      // x = ISO date; gaps filled server-side
  reliability?: "measured" | "indicative";
};

export type AnalyticsChartProps = {
  kind: "line" | "area" | "bar" | "stackedBar";  // FOUR kinds. No pie, no donut, no radar.
  series: Series[];                              // max 4
  xLabel: string; yLabel: string;
  yFormat: "count" | "percent";
  height?: number;                               // default 240
  annotations?: { x: string; label: string }[];  // e.g. "campaign launched"
  tableFallback: { headers: string[]; rows: (string | number)[][] };  // REQUIRED
};
// tableFallback is required, not optional: it renders inside a <details>
// ("View as table") beneath every chart. That is our chart accessibility story —
// no ARIA-annotated SVG gymnastics, just the numbers, available to everyone.
// No pie/donut: every question this product asks is "how much over time" or
// "how do these compare", and bars answer both better.

// ─── AIInsightCard ────────────────────────────────────────────────────────
export type AIInsightCardProps = {
  insight: {
    id: string;
    kind: "step_performance" | "subject_performance" | "timing" | "lead_quality"
        | "deliverability" | "copy_suggestion";
    headline: string;
    body: string;
    evidence: { label: string; value: string }[];
    sampleSize: number;
    confidence: number;
    model: string; modelVersion: string;
    generatedAt: string;
  };
  minSampleSize: number;              // below this the card is NOT rendered at all
  action?: { label: string; href: string };
  onDismiss?: () => void;
  onFeedback?: (v: "useful" | "not_useful") => void;
};
// Every card shows "AI-generated · <model> · n = <sampleSize>" in its footer.
// Attribution is structural, not decorative (brief §10).

// ─── EmptyState / LoadingState / ErrorState ───────────────────────────────
export type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;                      // states the situation
  description?: string;               // one or two sentences, no marketing voice
  action?: { label: string; href?: string; onClick?: () => void; disabled?: boolean;
             disabledReason?: string };   // disabledReason is REQUIRED when disabled
  secondaryAction?: { label: string; href?: string; onClick?: () => void };
  size?: "sm" | "md";                 // sm for in-panel, md for full page
};

export type LoadingStateProps =
  | { variant: "table"; rows?: number; columns: number }
  | { variant: "cards"; count?: number }
  | { variant: "list"; rows?: number }
  | { variant: "detail" }
  | { variant: "chart"; height?: number }
  | { variant: "form"; fields?: number };
// Skeletons only. There is no "spinner" variant for page-level loading — a
// centred spinner tells the user nothing about what is coming (brief §8).

export type ErrorStateProps = {
  title?: string;                     // default "Something went wrong"
  message: string;                    // plain language, never a stack trace
  errorId?: string;                   // correlation id, monospace, copyable
  onRetry?: () => void;
  action?: { label: string; href: string };
  size?: "sm" | "md";
};

// ─── Drawer / Modal ───────────────────────────────────────────────────────
export type DrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "right" | "bottom";          // right on desktop, bottom under 768px
  width?: "sm" | "md" | "lg";         // 400 / 560 / 720
  title: string;                      // required — it is the accessible name
  description?: string;
  footer?: React.ReactNode;           // sticky action row
  children: React.ReactNode;
  dismissible?: boolean;              // false for unsaved-changes guards
};

export type ModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  size?: "sm" | "md" | "lg";
  children?: React.ReactNode;
  confirm?: {
    label: string;
    onConfirm: () => void | Promise<void>;
    tone?: "default" | "danger";
    requireTypedConfirmation?: string; // e.g. "1284" or the campaign name
  };
  cancelLabel?: string;
};
// Rule: Drawer for inspecting or editing alongside context (preview, task,
// opportunity). Modal for a decision that must block (confirm delete, launch
// gate, session expired). Never a modal for a form the user might need to
// cross-reference against the page behind it.

// ─── CommandPalette ───────────────────────────────────────────────────────
export type CommandGroup = {
  heading: string;
  items: {
    id: string; label: string; hint?: string;
    icon?: LucideIcon; keywords?: string[];
    href?: string; onSelect?: () => void;
    shortcut?: string[];
  }[];
};

export type CommandPaletteProps = {
  staticGroups: CommandGroup[];                          // rendered with zero network
  onSearch: (q: string) => Promise<CommandGroup[]>;      // server action, debounced 200ms
  recent?: CommandGroup;                                 // localStorage
  open: boolean;
  onOpenChange: (open: boolean) => void;
};
```

#### PageShell and Section

Two small patterns that make the five-states rule cheap to obey:

```ts
export type PageShellProps = {
  title: string;                       // Instrument Serif
  subtitle?: React.ReactNode;
  breadcrumb?: { label: string; href?: string }[];
  actions?: React.ReactNode;           // primary action lives HERE, not in the header
  tabs?: { label: string; href: string; active: boolean }[];
  children: React.ReactNode;
};

export type SectionProps = {
  title?: string;
  action?: { label: string; href: string };   // the "View all →" affordance
  children: React.ReactNode;
};
```

Every page uses `PageShell`. That is how the header stays thin and page titles
stay consistent (§3.2).

### 9.3 Server/client boundaries per pattern

| Pattern | Boundary | Why |
|---|---|---|
| `StatusBadge`, `EmptyState`, `LoadingState`, `Section`, `PageShell`, `MessageBubble`, `AttachmentList` | **Server** | Pure rendering. Keeping them server-side keeps them out of the bundle |
| `ErrorState` | Client | Needs `onRetry` |
| `DataTable`, `FilterBar`, `LeadTable` | Client | Selection, debounce, URL writes |
| `EmailThread` | Server shell + client expand toggle | Bodies are large; keep them out of the client payload |
| `SequenceBuilder`, `CommandPalette`, `Drawer`, `Modal`, `AppShell`, `AnalyticsChart`, `ActivityTimeline` (load-more only) | Client | Genuine interactivity |
| `CampaignCard`, `MailboxCard`, `AIInsightCard` | Server, with client action buttons as leaves | The card is data; only its buttons need JS |

The pattern to follow: a server component renders the markup and embeds a small
client component for the interactive control, rather than marking the whole card
`"use client"`.

### 9.4 Two enforced prop-type tricks

```ts
// Icon-only buttons cannot omit an accessible name — a type error, not a review note.
type ButtonBase = { variant?: Variant; size?: Size; loading?: boolean };
export type ButtonProps =
  | (ButtonBase & { children: React.ReactNode; "aria-label"?: string })
  | (ButtonBase & { children?: never; "aria-label": string; icon: LucideIcon });

// A disabled action must say why.
type Action =
  | { label: string; disabled?: false; onClick: () => void }
  | { label: string; disabled: true;  disabledReason: string };
```

These two types kill the most common a11y and honesty defects in this codebase
at compile time.

---

## 10. URL-as-state conventions

### 10.1 What goes in the URL, and what does not

| In the URL (shareable, back/forward, bookmarkable) | Not in the URL |
|---|---|
| Filters, search text, sort key + direction, page, page size | Selected rows (§7.3 — a resurrected selection is dangerous) |
| Selected inbox thread (it is a route segment) | Column visibility, pane widths, sidebar collapsed (device preferences → `localStorage`) |
| Active tab on a tabbed detail page (a route segment) | Draft composer text (`sessionStorage`) |
| Date range on analytics | Open/closed state of a modal or drawer that has no deep link |
| Wizard step (`/import/[id]/map`) | Toast state, hover state, focus |
| Deep-link drawers that must be shareable: `?opportunity=<id>`, `?lead=<id>` | Anything containing a secret or a token |

**`workspaceId` is never in the URL.** It comes from the session, server-side
(brief §4.2). A `workspaceId` param is ignored and logged as suspicious.

### 10.2 Naming

Fixed vocabulary across every list, so muscle memory transfers:

| Param | Meaning | Format |
|---|---|---|
| `q` | free-text search | string, trimmed, ≤200 chars |
| `sort` | sort key | enum per surface |
| `dir` | direction | `asc` \| `desc` |
| `page` | 1-based page | int ≥1 |
| `per` | page size | `25` \| `50` \| `100` |
| `cursor` | cursor page token (inbox) | `<isoTimestamp>_<id>` |
| `folder` | inbox folder | enum (§5.3) |
| `status` | status filter | CSV of enum values |
| `campaign`, `mailbox`, `list`, `tag`, `owner` | entity filters | uuid |
| `from`, `to` | date range | `YYYY-MM-DD` |
| `range` | date preset | `7d` \| `30d` \| `90d` \| `custom` |
| `view` | alternate presentation of the same data | e.g. `board` \| `table` |

Multi-value filters are **comma-separated single params** (`status=A,B`), not
repeated keys. Shorter URLs, one parse path, and `URLSearchParams.get` behaves
predictably.

### 10.3 The one helper everyone uses

```ts
// lib/search-params.ts  — pure, no React, unit-testable
export function setParams(
  current: URLSearchParams,
  patch: Record<string, string | string[] | number | null | undefined>,
  opts?: { resetPage?: boolean },   // default true for anything except `page`
): string;
```

Rules it enforces: `null`/`undefined`/`""` deletes the key (no `?q=` litter);
setting any filter resets `page`; params are emitted in a stable order so two
identical states produce byte-identical URLs (which makes them cacheable and
makes tests deterministic).

Client usage:

```ts
const router = useRouter();
const pathname = usePathname();
const params = useSearchParams();

const update = (patch: Parameters<typeof setParams>[1], mode: "push" | "replace" = "replace") =>
  router[mode](`${pathname}?${setParams(params, patch)}`, { scroll: false });
```

`replace` for filter/sort/search (typing should not fill history); `push` for
page changes and navigation (back should page back). `scroll: false` always on
list views — jumping to the top after changing a filter loses the user's place.

### 10.4 Parse once, server-side

Every list page parses its params with a zod schema at the top of the page
component and passes a typed object down. Components receive typed values, never
raw `searchParams`. Invalid values are dropped to defaults (§7.2).

---

## 11. Optimistic update policy

### 11.1 The rule

**Optimistic if the change is a local flag we can roll back. Pessimistic if the
change has an effect outside our database.**

Sending email, cancelling scheduled sends, launching or pausing a campaign,
connecting or disconnecting a mailbox, deleting anything, and starting an import
all wait for the server. Everything else can be optimistic.

### 11.2 The table

| Action | Mode | Rollback / confirmation |
|---|---|---|
| Mark thread read/unread | Optimistic | Revert flag, toast on failure |
| Archive / unarchive thread | Optimistic | Row returns, toast with **Undo** (8s) |
| Snooze thread | Optimistic | Row returns; toast states the snooze time |
| Add/remove tag (thread, lead) | Optimistic | Chip reverts |
| Set lead status | Optimistic | Badge reverts |
| Add note | Optimistic append (greyed until confirmed) | Item removed, text restored to the input |
| Complete task | Optimistic | Checkbox reverts |
| Move opportunity between pipeline stages | Optimistic | Card animates back |
| Reorder sequence steps | Optimistic | List order reverts, `aria-live` announces the revert |
| Toggle column visibility, resize pane, collapse sidebar | Local only | n/a — never hits the server |
| Save sequence step | **Pessimistic** | Card `aria-busy`, inline error keeps edits |
| Send reply / forward | **Pessimistic** | Composer stays open, body preserved |
| Launch / pause campaign | **Pessimistic** | Button pending; confirm dialog first for launch |
| Add leads to campaign (bulk) | **Pessimistic** | Progress, then result summary |
| Delete anything | **Pessimistic** + confirm | — |
| Connect / disconnect mailbox | **Pessimistic** | Full page redirect through OAuth |
| Start import | **Pessimistic** + idempotency key | — |

### 11.3 Mechanics

`useOptimistic` for list-local flags, paired with a server action that returns a
typed `Result`. Shape every optimistic action follows:

```tsx
const [optimistic, apply] = useOptimistic(threads, threadReducer);

async function archive(id: string) {
  apply({ type: "archive", id });                       // 1. instant
  const res = await archiveThreadAction({ threadId: id }); // 2. server
  if (!res.ok) {
    apply({ type: "unarchive", id });                   // 3a. roll back
    toast.error(messageFor(res.error));
    return;
  }
  toast.success("Archived", { action: { label: "Undo", onClick: () => unarchive(id) } });
}
```

Three non-negotiables:

1. **Every optimistic action has a rollback path that is written before the
   happy path.** An optimistic update without a rollback is a lie that never
   gets corrected.
2. **Failures are announced, not swallowed.** A toast with the plain-language
   reason, and `aria-live` so a screen-reader user learns the change reverted.
3. **Never optimistically update a count the user could act on** — the inbox
   unread badge and the dashboard tiles come from the server. An optimistically
   decremented "7 replies waiting" that rolls back is worse than a one-second
   delay.

`revalidatePath` after every mutation keeps server data authoritative;
`useOptimistic` state is discarded when fresh server data lands, so there is
exactly one source of truth and no manual cache reconciliation.

### 11.4 Undo, and where it is not offered

Undo is offered for archive, snooze, and note-add. It is **not** offered for
sends (the email has left), deletes (confirm dialog serves that role instead), or
campaign launches (pause is the real control, and it is not the same as undo —
already-sent emails stay sent, and the UI says so).

---

## 12. Responsive strategy

Desktop-first. This is a tool people use for hours on a laptop, and pretending
otherwise produces a mobile app nobody wanted and a desktop app that wastes half
its screen.

### 12.1 Breakpoints

Tailwind defaults, with our intent per band:

| Band | Width | Intent |
|---|---|---|
| `base` | <768px | **Read and triage only.** Sidebar becomes a sheet. Tables become card lists. Inbox is list→detail. Sequence builder is read-only with an explicit notice. |
| `md` | 768–1023px | Tablet: full navigation via sheet, tables scroll horizontally with a sticky first column, inbox two panes (list + detail as a route) |
| `lg` | 1024–1279px | Sidebar visible (collapsed by default), inbox three panes with a compact folder rail |
| `xl` | 1280–1535px | The design target. Everything at its intended size |
| `2xl` | ≥1536px | Content columns cap out (`max-w-[1440px]`, prose `max-w-[72ch]`); extra width goes to the inbox conversation pane and table columns, never to stretched text |

### 12.2 Per-surface degradation

| Surface | ≥1280px | 1024–1279px | 768–1023px | <768px |
|---|---|---|---|---|
| Shell | Sidebar 240px | Sidebar collapsed to icons | Sheet nav, hamburger in header | Sheet nav; bottom-safe padding |
| Dashboard | 4-up tiles, full lists | 2×2 tiles | 2×2 tiles, chart full width | 1-up tiles, chart hidden below a `<details>` — a 30-day chart on a phone is unreadable |
| Inbox | 3 panes | 3 panes, compact rail | 2 panes (rail → select) | list→detail via route (§5.9) |
| Leads table | Full columns | Sticky name column, horizontal scroll | Same | **Card list**: name, email, status, last activity, tap for profile. Bulk selection unavailable — announced, not silently missing |
| Sequence builder | Full editing | Full editing | Full editing, narrower cards | **Read-only** with "Editing a sequence needs a wider screen." Honest, not a broken editor |
| CSV import | Full wizard | Full wizard | Mapping table scrolls | Upload + progress only; mapping says "continue on a larger screen" |
| Analytics | Charts + tables | Charts + tables | Charts stack | Table fallback promoted over charts |
| CRM pipeline | Board | Board, scrollable | Board, scrollable | Table view (`?view=table`) — a drag board on a phone is not a feature |
| Settings | Two-column | Two-column | Stacked | Stacked |

### 12.3 Rules

- **No horizontal page scroll at any width.** Tables scroll inside their own
  container, not the document.
- Touch targets ≥44×44px below `md`. Hover-only affordances (row action buttons,
  copy buttons) become always-visible below `md`, because there is no hover.
- Text never below 14px in UI, 16px in body copy on mobile (iOS zooms inputs
  under 16px, which breaks layouts).
- **Where a feature is unavailable at a width, say so.** A missing bulk-select
  checkbox with no explanation reads as a bug; "Bulk actions need a wider
  screen" reads as a decision. This is the responsive form of "no fake
  functionality."
- The layout is CSS grid/flex driven; we do not branch on `window.innerWidth` in
  JS for layout. The two exceptions where JS must know the width — the inbox
  pane count and the drawer's side — use a single `useMediaQuery` hook with a
  server-safe default matching the desktop layout.

---

## 13. Accessibility

Brief §7 makes a11y a hard gate. This section says what that means per surface
and what a PR must satisfy.

### 13.1 Baseline that applies everywhere

- **Semantic HTML first.** `<button>` for actions, `<a>` for navigation, real
  `<table>` for tabular data, real `<ol>` for the sequence, real `<form>` for
  forms. ARIA is a patch for what HTML cannot express, not a substitute.
- **Landmarks, once per page:** `<header>`, `<nav aria-label="Main">`, `<main>`,
  and a **skip link** as the first focusable element ("Skip to content" → `#main`).
- **Visible focus.** A 2px `--accent` ring with 2px offset on every interactive
  element. `outline: none` without a replacement is a review block.
- **Contrast.** `--ink` on `--bg` is 13.9:1; `--ink-secondary` 7.4:1;
  `--ink-muted` on `--bg` is ~4.0:1 — therefore **`--ink-muted` is only for
  text ≥18.66px or bold ≥14px**, i.e. timestamps and meta at their designed
  size, never for 12px labels. Status colours are used on `--surface` with text
  labels, and every status token is verified ≥4.5:1 as text.
- **Colour is never the only signal.** Every `StatusBadge` carries a label and
  an icon. Chart series get distinct shapes/dash patterns plus a table fallback.
- **Motion.** All transitions 120–200ms opacity/transform; under
  `prefers-reduced-motion: reduce` transitions drop to 0 and skeleton shimmer
  becomes a static fill.
- **Zoom/reflow.** Usable at 200% zoom and at 320px CSS width without
  two-dimensional scrolling (WCAG 1.4.10) on every surface except the ones §12.2
  explicitly degrades with a stated message.
- **Forms.** Every control has a programmatic label. Errors are text (not colour),
  tied via `aria-describedby`, `aria-invalid` on the field, and focus moves to
  the first invalid field on submit. A form-level error summary appears above the
  form with links to each field.
- **Async results announced.** One `aria-live="polite"` region per page for
  results (save confirmations, result counts, copy confirmations), one
  `aria-live="assertive"` reserved for destructive/structural changes. Toasts
  render inside a polite region.
- **Dialogs.** Radix handles focus trap and restore; we must supply the title
  (accessible name), close on `Esc`, return focus to the trigger, and never
  nest a dialog inside a dialog.
- **Icon-only buttons** always have an accessible name — enforced by the
  `ButtonProps` union in §9.4.
- **Images.** Decorative `alt=""`; avatars use the person's name; the tracking
  pixel is never rendered in our own UI.

### 13.2 Per-surface commitments

| Surface | Specific commitments |
|---|---|
| **Shell / sidebar** | `<nav aria-label="Main">`; sections as `<ul>` groups with `aria-labelledby` on the section label; active item `aria-current="page"`; badges read as text ("Inbox, 12 unread") via `<span class="sr-only">`; collapse control is a `<button aria-expanded>` and collapsed items keep names via `aria-label`, not title-only |
| **Command palette** | `cmdk` gives `role="dialog"` + `role="listbox"`/`option` with `aria-activedescendant`; result counts announced politely; `Esc` closes and restores focus; reachable by a visible button, never keyboard-only |
| **Dashboard** | Each section is `<section aria-labelledby>`; triage banner is `role="region" aria-label="Needs attention"` and **not** `role="alert"` (it is present on load, not an interruption); tiles are links with text names, and their big numerals carry an `aria-label` including the noun ("7 replies waiting"); the chart ships its table fallback |
| **Inbox list** | `role="listbox"`, rows `role="option"` with `aria-selected`, roving tabindex, `j`/`k` and arrows both work; each row's accessible name is "Sara Kaplan, Meridian Health, Interested, 3 days ago, unread"; unread is conveyed by the word "unread", not the dot alone; folder counts read as text; "3 new messages" pill is `role="status"` |
| **Conversation** | `<article>` per message with `aria-labelledby` (sender + time); collapsed messages are `<button aria-expanded>`; `<time datetime>` everywhere; opening a thread moves focus to the `<h2>` (`tabIndex={-1}`); the "Show images" toggle explains why images are blocked; sanitised HTML is rendered in a container that cannot introduce its own landmarks or headings above `<h3>` |
| **Composer** | Labelled fields, `⌘Enter` documented in the visible hint, send state via `aria-busy` + polite announcement, error text inline and focusable, draft-autosave never announced (it would be noise) |
| **Sequence builder** | The full §6.7 contract: `<ol>`/`<li>`, `role="group"` per card with `aria-labelledby`, roving focus, `Alt+Arrow` reorder with assertive announcement, real `tablist` for variants, `<textarea>` body (no `contenteditable`), variable insertion as a proper `role="combobox"` with `aria-activedescendant`, focus never lost after delete, every shortcut duplicated as a visible control |
| **Leads table** | `<table>` with `<caption>` (visually hidden), `<th scope="col">`, sortable headers as `<button>` inside `<th>` with `aria-sort` on the `<th>`; selection checkboxes named per row ("Select Sara Kaplan"); the header checkbox is a tri-state with an accurate name; selection changes announced ("50 leads selected"); bulk bar is `role="region" aria-label="Bulk actions"` |
| **CSV import** | Stepper is `<ol>` with `aria-current="step"`; the mapping UI pairs each CSV header with a labelled `<select>`; validation results announced politely with counts; error table has proper headers and row numbers as `<th scope="row">`; progress is `role="progressbar"` with `aria-valuenow/min/max` and a text percentage |
| **Charts** | Every chart has an accessible name and a required `<details><summary>View as table</summary>` fallback (§9.2). We do not attempt to make the SVG itself explorable |
| **CRM board** | Drag is enhancement only: each card has a "Move to…" menu that is the accessible path; stage columns are `<section aria-labelledby>` with counts in text; moves announced assertively |
| **Settings** | Sub-nav is `<nav aria-label="Settings">`; destructive sections are `<section>` with a heading and a described-by warning; the API key reveal is announced once and the "you will not see this again" text is programmatically tied to the field |
| **Auth** | Autocomplete tokens set correctly (`email`, `current-password`, `new-password`); errors announced assertively; rate-limit countdown is text, not colour; caps-lock and password-visibility toggles are labelled buttons |

### 13.3 What we deliberately do not do

- **No `role="application"`** anywhere. It suppresses assistive-technology
  browse mode and every surface here works better without it.
- **No custom scrollbars** that lose keyboard scrolling.
- **No focus stealing on page load** — except the two justified cases: after a
  route-level error we focus the `ErrorState` heading, and inside a dialog we
  focus its first control.
- **No tooltip-only information.** Anything in a tooltip exists in text
  elsewhere, because tooltips are unreachable on touch and awkward with screen
  readers.
- **No infinite scroll** on primary lists. "Load more" is a button.

### 13.4 The a11y checklist a PR must pass

Copy this into the PR template. Every box is either ticked or explicitly marked
N/A with a reason.

**Keyboard**
- [ ] Every interactive element is reachable by `Tab` in visual order.
- [ ] Nothing is reachable by mouse only; nothing is reachable by keyboard only.
- [ ] Focus is visible on every element, including inside dialogs and tables.
- [ ] `Esc` closes every overlay and restores focus to the trigger.
- [ ] After a destructive action, focus lands somewhere sensible, never `<body>`.
- [ ] New shortcuts are documented in the `?` sheet and duplicated as visible controls.
- [ ] Shortcuts do not fire while focus is in a text input.

**Semantics**
- [ ] Correct element for the job (`button` vs `a` vs `div`).
- [ ] One `<h1>` per page; heading levels do not skip.
- [ ] Tables use `caption`, `th`, `scope`, and `aria-sort` when sortable.
- [ ] Lists are lists; the sequence is an `<ol>`.
- [ ] Landmarks present and not duplicated; skip link works.

**Names and descriptions**
- [ ] Every input has a programmatic label (not placeholder-only).
- [ ] Every icon-only button has an accessible name.
- [ ] Row-level controls name their row ("Archive conversation with Sara Kaplan").
- [ ] Decorative icons are `aria-hidden`.

**State and feedback**
- [ ] Async results announced via the appropriate live region.
- [ ] Errors are text, tied with `aria-describedby`, with `aria-invalid` set.
- [ ] Loading uses skeletons and `aria-busy`; no unlabelled spinners.
- [ ] Disabled controls state why (`disabledReason`).
- [ ] All five states implemented and manually verified for this surface.

**Visual**
- [ ] Body text ≥4.5:1; large text ≥3:1; `--ink-muted` used only at permitted sizes.
- [ ] No meaning conveyed by colour alone.
- [ ] Usable at 200% zoom and 320px width, or the degradation is stated in the UI.
- [ ] `prefers-reduced-motion` respected.
- [ ] Touch targets ≥44px below `md`.

**Verification (evidence required in the PR description)**
- [ ] Keyboard-only walkthrough of the primary flow, described in one paragraph.
- [ ] `axe` (via `@axe-core/playwright`) passes with zero serious/critical
      violations on the changed routes; the E2E suite fails the build otherwise.
- [ ] One screen-reader pass per *new surface* (VoiceOver or NVDA) — not per PR,
      but no surface ships without one.

The axe check is automated in the Playwright suite so this checklist does not
depend purely on discipline. Automated tooling catches roughly a third of real
issues, which is why the keyboard walkthrough is also mandatory.

---

## 14. Real-world constraints that shape this UI

Stated plainly, because each one has already changed a design decision above.

1. **Gmail API quotas are per-project and per-user.** Gmail does not expose
   remaining daily send quota, so our `sentToday / dailyCap` bar is *our* counter,
   not Google's. When Google rejects first, the mailbox goes `RATE_LIMITED` and
   the UI says the cap is our estimate (§4.3.5). We never claim to know the
   provider's remaining quota.

2. **Open tracking is unreliable.** Apple Mail Privacy Protection, Gmail image
   proxying, and corporate scanners produce both false positives (proxy prefetch)
   and false negatives (images blocked). Every open metric carries
   `reliability: "indicative"` and renders a caveat (§9.2 `CampaignStats`). Open
   rate is absent from the dashboard chart entirely (§4.4). Open-based sequence
   conditions carry an inline warning (§6.1 diagram).

3. **Click tracking rewrites links,** which slightly harms deliverability and
   breaks if the tracking domain is unhealthy. It is a per-campaign toggle, off
   by default for plain-text-style campaigns, and the settings page says what the
   tradeoff is.

4. **We cannot observe inbox vs. spam placement.** No provider tells us. The
   deliverability section shows configuration signals (SPF/DKIM/DMARC, bounce
   rate, reply rate, volume ramp) and states the limit permanently (§8).
   No "spam score", no placement gauge (§6.6).

5. **Timezones and DST.** All timestamps are UTC in the database and rendered in
   the viewer's timezone, except campaign schedules, which are evaluated in the
   *campaign's* timezone. The schedule editor states which timezone it is using
   and shows a worked example ("9:00–17:00 Asia/Kolkata — next window opens Mon
   09:00, which is 03:30 UTC"). DST transitions mean a window can be 23 or 25
   hours long; the UI never promises an exact send minute, only "would send Tue
   2 Sep, around 09:14 IST".

6. **Duplicate sends are the worst failure mode.** The UI's contribution: every
   send-triggering control is pessimistic, disabled while pending, and carries a
   client-generated idempotency token (§5.6, §7.4). No optimistic send, ever.

7. **Deliverability limits shape defaults, not just warnings.** New mailboxes
   default to a low daily cap with warmup ramping, minimum wait between steps is
   1 hour (§6.2 rule 6), and the campaign schedule page shows computed throughput
   so a user sees "480 leads × 3 steps at 40/day = 36 days" *before* launching
   rather than discovering it later.

8. **Reply detection is heuristic at the margins.** Auto-replies,
   out-of-office, and bounce-backs can look like human replies. The inbox has
   `ooo` and `auto_reply` categories and the sequence-stop rule uses the
   classifier's judgement — so the conversation view always shows the
   classification and lets a human override it (§5.5, §5.6). The UI never hides
   the fact that a stop decision was automated.

---

## 15. Deliberately not built, and things I am calling over-engineered

Cut from this design on purpose. Each would be a plausible feature and each
would cost more than it returns in v1.

| Cut | Why |
|---|---|
| Node-graph sequence canvas | Models a graph we do not have; near-impossible to make keyboard-accessible (§6.1) |
| Rich-text (`contenteditable`) email body editor | Weeks of a11y risk; plain-text-style outreach performs better anyway (§6.7) |
| Live inbox via websockets/SSE | A 60s visibility-gated count and a user-clicked refresh solves the actual need (§5.10) |
| Client-side query cache (TanStack/SWR) | Rejected by the brief; RSC + actions + `revalidatePath` covers this app |
| Saved views / shared filter presets | The URL already is a shareable view. Revisit when users ask |
| Drag-and-drop everywhere | Kept only for the CRM board and sequence reorder, both with keyboard-first alternates |
| Swipe gestures on mobile inbox | Undo affordances and touch a11y make it a project, not a flourish (§5.9) |
| Dark mode | Out of scope per brief §7; tokens are defined so it can be added without touching components |
| Virtualised lists | 50-row server-paginated pages do not need windowing. Adding it now buys complexity and breaks keyboard focus management |
| Dashboard layout customisation | Two users, twelve widget arrangements, and no one's triage improves |
| A notification bell | The dashboard is the notification surface; two inboxes compete (§3.2) |
| Onboarding product tour | Honest empty states with a single next action beat a tour nobody finishes |
| Pie/donut/radar charts | Four chart kinds cover every question this product asks (§9.2) |
| Real-time collaborative editing on sequences | Optimistic-concurrency with a stale-version prompt is the right size (§6.3) |

**Things in this document I consider the highest risk of gold-plating**, flagged
so the lead can cut them:

1. **Per-step version/stale-conflict handling in the sequence builder** (§6.3).
   Correct, but for a single-operator workspace it is machinery nobody exercises.
   Cheaper v1: last-write-wins plus an "edited 2 minutes ago by X" line. I kept
   the version check because the failure it prevents (two admins editing a live
   campaign's copy) sends wrong emails to real people, and that is expensive to
   discover. **Lead's call.**
2. **`Selection = { mode: "matching" }`** (§7.3). Needed only above a few hundred
   leads. Simplify to id-based selection with a 1,000-row cap if Phase 4 needs to
   ship faster; the `BulkTarget` union already allows adding `filter` mode later
   without changing call sites.
3. **`Thread.searchVector` FTS** (§5.4). Justified, but it is a data-model cost.
   If Phase 3 needs to ship first, `ILIKE` on subject + lead name is acceptable
   *temporarily*, provided the UI says search does not cover message bodies yet.
   Never ship `ILIKE '%q%'` over bodies.
4. **The `[[...thread]]` optional catch-all** (§2.3). If it fights streaming or
   scroll restoration in practice, the fallback is two routes with a shared list
   component. Not worth defending if it hurts.

---

## 16. Open questions for the lead engineer

1. **Charting library.** `AnalyticsChart` needs one, and none is in the locked
   stack. Options: (a) hand-rolled SVG — no dependency, ~300 lines for line/area/
   bar, full control of tokens and a11y, but we own axis/tick math; (b) `recharts`
   — the shadcn-ecosystem default, ~100KB gzipped, opinionated styling to fight;
   (c) `visx`/`d3-scale` only — scales and shapes from d3, SVG by hand, ~15KB.
   **My recommendation: (c).** `d3-scale` + `d3-shape` gives us the maths and
   nothing else, which fits four chart kinds, the token system, and the required
   table fallback. Needs your approval as a justified addition per brief §2.

2. **Command-palette search scope.** §3.4 excludes message bodies from the
   palette and gives the inbox its own FTS search. Confirm that split, or say the
   palette should reach threads too (which makes it depend on the same
   `searchVector` and blurs "jump to a thing" with "find text").

3. **Sequence step versioning** — item 1 in §15. Keep the optimistic-concurrency
   check, or ship last-write-wins in Phase 5 and add it later?

4. **Who may connect a mailbox?** §8 assumes ADMIN+ for
   `/mailboxes/connect`, `MEMBER` read-only. The brief's role table does not say.
   Confirm, since it changes both the nav filter and the server guard.

5. **`Thread` denormalised fields** (`preview`, `messageCount`, `lastInboundAt`,
   `aiCategory`, `aiConfidence`, `hasAttachments`, `searchVector`, `snoozedUntil`,
   `archivedAt`, `isRead`) are load-bearing for §5.3's single-query thread list.
   The data-model doc owns them — please confirm they are in the schema, since
   without them the inbox needs joins per row and will not hold up.

6. **`dashboard.*` module placement.** §4 calls `dashboard.problems`,
   `dashboard.counts`, `dashboard.needsReply`, `dashboard.campaignHealth`,
   `dashboard.mailboxHealth`, `dashboard.activity`. These cross domains
   (mailboxes + campaigns + inbox + jobs). The brief's module list has no
   `dashboard` module. Two options: add `modules/dashboard/` as a read-only
   aggregator that calls other modules' public APIs (my preference — it keeps the
   cross-domain query knowledge in one place and the dependency graph acyclic
   since nothing depends on it), or scatter these across the six owning modules
   and have the page call all six. **Needs a decision before Phase 1 ends.**

7. **`analytics.*` naming** used in §2.2 (`overview`, `byCampaign`, `byStep`,
   `byMailbox`, `campaignSummary`, `campaignBreakdown`) is provisional. The
   analytics doc owns these; align names there and I will follow.
