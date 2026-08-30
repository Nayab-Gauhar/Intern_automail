# Instant Mail — Database Architecture

> **Status:** authoritative for the data layer. Subordinate to
> `00-product-brief.md`; where this doc adds detail, the brief still wins on
> principle. This document **describes the committed schema**, it does not
> propose one. Every model, field, enum member, and index name below was read
> out of `prisma/schema.prisma` and cross-checked against generated DDL.

**Verified against live PostgreSQL 16.** DDL generated with
`prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
and applied to a scratch database with `ON_ERROR_STOP=1`:

| Object | Count |
|---|---|
| Models / tables | **42** |
| Enums | **35** |
| Indexes (36 unique + 144 plain + 42 primary key) | **222** |
| Foreign keys | **123** |

Of 42 models, **only four lack `workspaceId`** — `User`, `Session`,
`PasswordResetToken` (identity-scoped) and `Workspace` (the tenant root).
All 123 FK-owning relations declare an explicit `onDelete`: **81 `Cascade`,
42 `SetNull`**. No deletion behaviour is left to the ORM's default.

### Prisma 7: there is no URL in the schema

The `datasource` block carries **`provider` only**. Prisma 7 removed both `url`
and `directUrl` from schema files.

```prisma
datasource db {
  provider = "postgresql"
}
```

| Consumer | Where the connection comes from |
|---|---|
| Migrate / introspection CLI | `datasource.url` in **`prisma.config.ts`** (prefers `DIRECT_DATABASE_URL`, falls back to `DATABASE_URL`) |
| `PrismaClient` at runtime | the **`@prisma/adapter-pg` driver adapter** in `src/lib/db.ts` — a `PrismaPg` instance, not a URL string |

Two CLI flag changes bite scripts written against Prisma ≤6:
`migrate diff --to-schema <path>` (not `--to-schema-datamodel`), and
`db push --skip-generate` no longer exists — passing it makes the command a
**silent no-op**. Any doc or script showing a `url` in `schema.prisma`
describes a different product version and is wrong here.

---

## 1. ER overview by subsystem

`═▶` one-to-many · `─1─` one-to-one · `┈▶` nullable / attribution-only link.
Every box except `User`, `Session`, `PasswordResetToken` and `Workspace`
carries `workspaceId`.

### Identity & tenancy

```
        ┌──────┐                            ┌───────────┐
        │ User │ (global — a person, not a  │ Workspace │ (tenant root)
        └──┬───┘  tenant resource)          └─────┬─────┘
           │                                      │
           ├═▶ Session ┈──── activeWorkspaceId ───┤
           ├═▶ PasswordResetToken                 │
           │                                      │
           └═════▶ WorkspaceMember ◀══════════════┤   role: OWNER|ADMIN|MEMBER
                   WorkspaceInvite ◀══════════════┤   tokenHash, PENDING→ACCEPTED
                   AuditLog        ┈◀═════════════┘   append-only, workspaceId NULLABLE
```

### Mailboxes & deliverability

```
Workspace
   ├═▶ Domain ═════════════════▶ EmailAccount        (SPF/DKIM/DMARC/MX cache)
   ├═▶ EmailAccount ─1─ SyncState                    (historyId / deltaToken cursor)
   │        ├═▶ MailboxDailyStat  (emailAccountId, localDate) ← the daily-cap counter
   │        ├═▶ WarmupPoolMember ◀══ WarmupPool
   │        ├═▶ EmailThread ═▶ EmailMessage
   │        ├═▶ ScheduledEmail
   │        └═▶ WebhookEvent ┈  (raw Pub/Sub payload, providerEventId unique)
   └═▶ WarmupPool
```

### Leads

```
Workspace
   ├═▶ Lead  ◀══ LeadListMembership ══▶ LeadList
   │      ◀══ LeadTagLink        ══▶ LeadTag
   │      ┈▶ LeadImport            (provenance: every imported Lead carries leadImportId)
   │      ┈▶ User (ownerUserId)
   ├═▶ CustomFieldDefinition        (the SCHEMA for Lead.customFields JSONB)
   └═▶ Suppression                  (scope EMAIL|DOMAIN, checked pre-enroll AND pre-send)
```

### Campaigns & sequences

```
Workspace
   └═▶ Campaign ─1─ Sequence ═▶ SequenceStep ═▶ SequenceStepVariant
          │                          │  (EMAIL|WAIT|CONDITION)   (A/B content)
          ├═▶ CampaignMailbox ══▶ EmailAccount        (rotation set, weighted)
          ├═▶ CampaignLeadListSource ══▶ LeadList     (provenance only)
          ├═▶ Experiment ═▶ ExperimentArm ══▶ SequenceStepVariant
          └═▶ CampaignLead ══▶ Lead                   ← THE enrollment / program counter
                   │  state, currentStepId, lastCompletedPosition, nextStepAt
                   ├┈▶ EmailThread (primaryThreadId)
                   └═▶ ScheduledEmail
```

### Sending

```
CampaignLead ═▶ ScheduledEmail ═▶ Job                (SEND_SCHEDULED_EMAIL)
                     │  state: SCHEDULED→SENDING→SENT|FAILED|CANCELLED|BOUNCED
                     │  dedupeKey UNIQUE · (campaignLeadId, sequenceStepId) UNIQUE
                     ├┈▶ EmailThread   (follow-ups reply into step 1's thread)
                     ├═▶ EmailMessage  (the stored copy of what we sent)
                     ├═▶ EmailEvent
                     └── TrackingLink  (token → 302; NOT an FK, deliberately)
```

### Threads, messages, events

```
EmailAccount ═▶ EmailThread ═▶ EmailMessage
                  │  providerThreadId, rootMessageId, normalizedSubject
                  │  hasHumanReply, lastMessageAt, participants[]
                  │             │  rfcMessageId, inReplyTo, references[]
                  │             │  direction, classification, bounceType
                  │             └┈▶ ScheduledEmail · CampaignLead   (attribution)
                  └┈▶ Lead · Campaign · CampaignLead

EmailEvent  ← append-only fact log; the source of truth for EVERY metric.
   Denormalised dimensions, all nullable SetNull FKs:
   campaignId · campaignLeadId · sequenceStepId · variantId · leadId
   emailAccountId · scheduledEmailId · threadId · emailMessageId
```

### CRM

```
Workspace ═▶ Opportunity ══▶ Lead          stage: NEW…WON|LOST, Decimal(14,2)
                 ├═▶ Task                  status: OPEN…DONE|CANCELLED
                 ├═▶ Note
                 └═▶ Activity              human-readable timeline (derived, lossy)
   Task/Note also attach to Lead, EmailThread, EmailMessage.
```

### Analytics / AI / infrastructure

```
EmailEvent ──rollup──▶ cached *Count columns on
      Campaign · SequenceStep · SequenceStepVariant · CampaignLead
      Lead · EmailAccount · MailboxDailyStat · ExperimentArm
      (all caches — rebuildable, never truth)

AIAnalysis   ┈▶ EmailMessage · EmailThread · Lead · Campaign · CampaignLead
             (targetType, targetId, kind, promptVersion) UNIQUE
WebhookEvent ┈▶ EmailAccount      providerEventId UNIQUE  (redelivery = no-op)
Job          ══▶ Workspace, ┈▶ ScheduledEmail
             dedupeKey UNIQUE · SELECT … FOR UPDATE SKIP LOCKED
```

### The loop, in table terms

```
Lead ─enroll─▶ CampaignLead ─scheduler tick─▶ ScheduledEmail ─enqueue─▶ Job
                                                                          │
                                                                     worker leases
                                                                          ▼
   EmailEvent ◀─ EmailMessage ◀─ EmailThread ◀─ Gmail ◀─ ScheduledEmail(SENDING→SENT)
        │                             ▲
        │                        inbound reply
        ▼                             │
   Analytics rollups         AIAnalysis ─▶ CampaignLead.state = REPLIED
                                        └▶ Opportunity + Task + Activity
```

---

## 2. Model catalogue

42 models. Owner column: **W** = workspace-scoped (non-null `workspaceId`),
**W?** = nullable `workspaceId` (documented exception), **G** = global.

### Identity & tenancy (7)

| Model | Owner | What it is | Key relations |
|---|---|---|---|
| `User` | **G** | A login identity. Global so one person can hold several memberships with one password. `passwordHash` nullable (invited-but-unaccepted). Soft-deleted via `deletedAt`. | `sessions`, `memberships`, `passwordResets`, plus authorship on `Note`/`Task`/`Activity`/`AuditLog` |
| `Session` | **G** | Server-side session. Stores only `tokenHash` (SHA-256 of the cookie). `expiresAt` slides, `absoluteExpiresAt` never does, `revokedAt` kills it instantly. | → `User` (Cascade), ┈`activeWorkspace` (SetNull) |
| `PasswordResetToken` | **G** | Single-use reset token, hashed at rest. `usedAt` burns it. | → `User` (Cascade) |
| `Workspace` | **G** | The tenant root. Owns `slug` (global unique — it is in URLs), default `timezone`, `dailySendLimit`, `trackOpensDefault`/`trackClicksDefault`, `unsubscribeFooterHtml`. Soft-deleted. | parent of 40 models |
| `WorkspaceMember` | **W** | The join carrying `role` and `status`. **Authorization reads this, never a column on `User`.** | → `Workspace`, `User` (both Cascade) |
| `WorkspaceInvite` | **W** | Pending invitation: `email`, `role`, `tokenHash`, `status`, `expiresAt`. | → `Workspace` (Cascade), ┈`invitedBy` (SetNull) |
| `AuditLog` | **W?** | Append-only security log. `BigInt` id. `action` is a dotted string, not an enum, because the vocabulary grows every phase. `metadata` is redacted. | ┈`Workspace`, ┈`actorUser` (both SetNull) |

### Mailboxes & deliverability (6)

| Model | Owner | What it is | Key relations |
|---|---|---|---|
| `EmailAccount` | **W** | A connected mailbox: the unit of OAuth credentials, rate limiting, and inbox sync. Holds `encryptedRefreshToken`/`encryptedAccessToken`/`encryptedSmtpPassword` (AES-256-GCM) with `encryptionKeyVersion` for rotation, `grantedScopes` to tell "needs reconsent" from "revoked", and the send governor: `dailySendLimit` (default 50), `minSecondsBetweenSends` (90), `sendJitterSeconds` (120), `timezone`, `sendWindowStartMinute`/`EndMinute`, `sendWindowDays Int[]`. Soft-deleted. | → `Workspace` (Cascade), ┈`Domain`, ┈`connectedBy` (SetNull); parent of `SyncState`, `EmailThread`, `EmailMessage`, `ScheduledEmail`, `MailboxDailyStat` |
| `Domain` | **W** | Sending domain with cached DNS auth: `spfStatus`/`dkimStatus`/`dmarcStatus`/`mxStatus` plus the **raw records verbatim** and `dkimSelector`, so the UI shows what we saw and not only our verdict. | ═▶ `EmailAccount` |
| `SyncState` | **W** | Per-mailbox provider cursor, split off `EmailAccount` so a per-tick write does not contend with config reads. Gmail `historyId`, `deltaToken`, `watchExpiresAt` (Gmail watches expire in ≤7 days), backfill progress. | ─1─ `EmailAccount` (Cascade) |
| `MailboxDailyStat` | **W** | Per-mailbox, per-**local**-day counters. `localDate` is `@db.Date`. Exists so the daily-cap check is one indexed read inside the claiming transaction rather than a `COUNT` over `ScheduledEmail`. | → `EmailAccount` (Cascade) |
| `WarmupPool` | **W** | Our-own-mailboxes warmup config: `startDailyVolume`, `maxDailyVolume`, `rampIncrement`, `replyRate`, `spamRescueRate`. No third-party network. | ═▶ `WarmupPoolMember` |
| `WarmupPoolMember` | **W** | A mailbox in a pool with its `rampDay`. | → `WarmupPool`, `EmailAccount` (both Cascade) |

### Leads (8)

| Model | Owner | What it is | Key relations |
|---|---|---|---|
| `Lead` | **W** | A contactable person. `email` is the workspace dedup key; `emailRaw` keeps what the customer actually uploaded; `emailDomain` is extracted on write so domain suppression is an exact lookup, never a `LIKE`. `customFields` is JSONB. `score Int?` (integer — decimals here are false confidence). Engagement caches: `sentCount`, `openCount`, `clickCount`, `replyCount`, `lastContactedAt`, `lastRepliedAt`, `lastOpenedAt`. Soft-deleted. | → `Workspace` (Cascade), ┈`owner`, ┈`leadImport` (SetNull); parent of `CampaignLead`, `Opportunity`, `Task`, `Note`, `Activity` |
| `LeadList` | **W** | A **static** named collection. Static by design: dynamic segments are saved filters (see §10). Caches `leadCount`. Soft-deleted. | ═▶ `LeadListMembership`, `CampaignLeadListSource` |
| `LeadListMembership` | **W** | Lead↔list join. `workspaceId` is denormalised from both parents **as a real FK** so membership queries are workspace-safe with no join. | → `LeadList`, `Lead` (both Cascade) |
| `LeadTag` | **W** | A tag with `colorToken` — a semantic design-system token name, never a hex value. | ═▶ `LeadTagLink` |
| `LeadTagLink` | **W** | Lead↔tag join. | → `LeadTag`, `Lead` (both Cascade) |
| `CustomFieldDefinition` | **W** | Declares a custom field's `key`, `label`, `type`, `options[]`, `required`, `defaultValue`, `position`. The **values** live in `Lead.customFields`; this is their schema. `key` is immutable after creation — renaming it would silently break every sequence body using `{{key}}`. | → `Workspace` (Cascade) |
| `LeadImport` | **W** | One CSV run, so a bad import is auditable and undoable: `columnMap`, row counters, `errorSample` (capped at 100 entries). Reuses `JobState` for `state` rather than inventing a second vocabulary. | ┈`uploadedBy` (SetNull); ═▶ `Lead` |
| `Suppression` | **W** | Do-not-contact list. `scope` EMAIL or DOMAIN with **one** `value` column, not two nullable ones, so the pre-send check is two exact lookups. Plus-addressing is stripped, so `a+news@x.com` unsubscribing also suppresses `a@x.com`. | → `Workspace` (Cascade). `sourceCampaignId`/`sourceLeadId`/`sourceMessageId` are plain columns, not FKs — an imported suppression has no provenance rows to point at |

### Campaigns & sequences (7)

| Model | Owner | What it is | Key relations |
|---|---|---|---|
| `Campaign` | **W** | The run unit. Schedule (`timezone`, `sendWindow*`) **intersects** each mailbox's window — the narrower wins, so a campaign can never push a mailbox outside its own limits. Stop policy: `stopOnReply` (default true), `stopOnReplyAnyCampaign` (false — surprising if silently on), `stopOnClick`, `stopOnOpen`. `skipIfInOtherCampaign` (true), `threadFollowUps` (true). Analytics caches incl. both `openedCount` (events) and `uniqueOpenedCount` (distinct leads) — one is a volume, the other a rate denominator. Soft-deleted. | ─1─ `Sequence`; ═▶ `CampaignLead`, `CampaignMailbox`, `ScheduledEmail`, `Experiment` |
| `CampaignMailbox` | **W** | Which mailboxes a campaign rotates through, with `weight`. Rotation stops one mailbox absorbing all of a campaign's reputation risk. | → `Campaign`, `EmailAccount` (both Cascade) |
| `CampaignLeadListSource` | **W** | Provenance only: this campaign drew from that list. Enrollment is materialised into `CampaignLead`, so editing the list later does not mutate a running campaign. | → `Campaign`, `LeadList` (both Cascade) |
| `Sequence` | **W** | The ordered step container, 1:1 with `Campaign`. `version` is bumped on every structural edit; `ScheduledEmail.sequenceVersion` records what it was materialised from, making a mid-flight edit detectable. | ─1─ `Campaign` (Cascade); ═▶ `SequenceStep` |
| `SequenceStep` | **W** | One node: `type` EMAIL / WAIT / CONDITION, 1-based `position`, `delayMinutes` (minutes only — "3 days" is 4320, and one unit beats two columns), condition operands, `enabled` to skip without losing history. | → `Sequence` (Cascade); ═▶ `SequenceStepVariant`; ◀┈ `CampaignLead.currentStepId` |
| `SequenceStepVariant` | **W** | The **content** of an EMAIL step: `subject`, `bodyHtml`, `bodyText` (required — HTML-only cold email is a spam signal), `label` ("A"/"B"), `weight`. Content lives here, never on the step, so "add a B variant" is an insert. | → `SequenceStep` (Cascade); ═▶ `ScheduledEmail`, `ExperimentArm` |
| `CampaignLead` | **W** | **The enrollment — the sequence's program counter for one lead.** `state`, `currentStepId`, `lastCompletedPosition` (survives step deletion, unlike `currentStepId`), `nextStepAt` (the scheduler's primary predicate), `assignedEmailAccountId` (chosen once and kept, so follow-ups come from the same address in the same thread), `primaryThreadId`, `stopReason`/`stoppedAt`. | → `Campaign`, `Lead` (both Cascade); ┈`currentStep`, ┈`primaryThread` (SetNull); ═▶ `ScheduledEmail`, `EmailEvent`, `Activity` |

### Sending (2)

| Model | Owner | What it is | Key relations |
|---|---|---|---|
| `ScheduledEmail` | **W** | The materialised intent to send exactly one email — and where "never send twice" is enforced by the database. `kind` CAMPAIGN_STEP / WARMUP / MANUAL. **Content is frozen at materialisation** (`subject`, `bodyHtml`, `bodyText`, `toEmail`) so what ships is exactly what the preview showed and a template edit cannot rewrite a pending send. Threading: `threadId`, `inReplyToMessageId`, `referencesHeader`. `rfcMessageId` is generated **by us before the send**, so dedup and threading survive a lost provider response. `claimedAt`/`claimedBy` mark the won race; `permanentFailure` suppresses retry. | → `EmailAccount` (Cascade), ┈`sequenceStep`, ┈`variant`, ┈`thread` (SetNull); ═▶ `EmailMessage`, `EmailEvent`, `Job` |
| `TrackingLink` | **W** | A rewritten outbound link. `token` is globally unique because the redirect endpoint has no session and therefore no workspace context — the token *is* the lookup key. `scheduledEmailId` is deliberately **not** an FK relation: if the send is purged, an old click still 302s instead of 404ing in a recipient's browser. | → `Workspace` (Cascade) |

### Threads, messages, events (3)

| Model | Owner | What it is | Key relations |
|---|---|---|---|
| `EmailThread` | **W** | A conversation **as one mailbox sees it**. One provider thread visible in two connected mailboxes is **two rows** — each has its own read state and provider ids; merging them would be wrong. `providerThreadId` is the primary association key; `rootMessageId` and `normalizedSubject` are fallbacks. `participants String[]` lets the inbox filter without a join. `hasHumanReply`/`firstReplyAt` are denormalised so the "replies" filter is an index lookup. | → `EmailAccount` (Cascade); ┈`Lead`, ┈`Campaign`, ┈`CampaignLead` (SetNull) |
| `EmailMessage` | **W** | One email, inbound or outbound. `rfcMessageId` normalised (brackets stripped, lowercased); `inReplyTo` single-valued (last wins = immediate parent); `references String[]` so a reply matches **any** of our sent Message-IDs by array overlap — necessary because forwarding and lists reorder and truncate chains. `headers Json?` keeps only the load-bearing ones (Auto-Submitted, X-Autoreply, Precedence, List-Unsubscribe, Return-Path, Authentication-Results). `bouncedRecipient` is the address from the DSN **body**, not the DSN's From (which is mailer-daemon) — that distinction is the whole trick to bounce attribution. `sentAt` is the provider timestamp, not the forgeable `Date` header. Attachment **bytes are not stored**. | → `EmailAccount`, `EmailThread` (Cascade); ┈`scheduledEmail`, ┈`campaignLead` (SetNull) |
| `EmailEvent` | **W** | **Append-only fact log; the source of truth for every metric.** `BigInt` id — highest-volume table, only appended and aggregated, never fetched by a shared id. Every analytics dimension is denormalised onto the row (nine nullable SetNull FKs) so a rollup joins nothing and the facts survive a campaign edit or mailbox soft-delete. `isBot` flags scanner/prefetch opens; `isFirstForSend` makes unique-open rates a filtered `COUNT` instead of a `DISTINCT`; `dedupeKey` is nullable — set for redeliverable provider facts, left null for opens/clicks which are legitimately repeatable. | ┈ everything |

### CRM (4)

| Model | Owner | What it is | Key relations |
|---|---|---|---|
| `Task` | **W** | `title`, `status`, `priority`, `dueAt`. Local calendar intent ("due Tuesday") stored as an instant computed in the assignee's timezone — a naive date breaks the moment someone travels. | ┈`assignee`, ┈`createdBy`, ┈`thread`, ┈`emailMessage` (SetNull); → `Lead`, `Opportunity` (Cascade) |
| `Note` | **W** | Free text against a lead, thread, or opportunity. | ┈`author` (SetNull); → `Lead`, `Opportunity` (Cascade) |
| `Opportunity` | **W** | A deal. `value Decimal(14,2)` — **never Float**, money must not accumulate binary rounding error. `currency` ISO 4217 with **no FX conversion**; totals report per currency. `probability Int`. `position` for drag-and-drop. | → `Lead` (Cascade, required); ┈`owner`, ┈`campaign`, ┈`campaignLead`, ┈`thread` (SetNull) |
| `Activity` | **W** | Human-facing timeline. **Derived and presentational — not an audit trail and not an analytics source.** `summary` is pre-rendered so the timeline needs no joins and stays readable after the referenced row is gone. Allowed to be lossy. | ┈`actor`, ┈`campaignLead` (SetNull); → `Lead`, `Opportunity` (Cascade) |

### Experiments (2)

| Model | Owner | What it is | Key relations |
|---|---|---|---|
| `Experiment` | **W** | A/B test over the variants of **one** email step. Deliberately narrow: multi-variate testing over a whole sequence needs traffic a cold campaign does not have. `primaryMetric` defaults to `"reply"` because open rates are unreliable. `minSamplePerArm` (100) gates any comparative claim. `winnerVariantLabel` is set by a human — **we do not auto-promote.** | → `Campaign`, `SequenceStep` (Cascade) |
| `ExperimentArm` | **W** | Cached per-arm counters, recomputed from `EmailEvent`. `pValue Decimal(6,5)`, null until both arms clear `minSamplePerArm`. | → `Experiment`, `SequenceStepVariant` (Cascade) |

### AI & infrastructure (3)

| Model | Owner | What it is | Key relations |
|---|---|---|---|
| `AIAnalysis` | **W** | One inference, stored with `model`, `promptVersion`, `output` (zod-validated), `confidence Decimal(4,3)`, token counts, `latencyMs`. Polymorphic `(targetType, targetId)` **plus** typed nullable FKs for the targets we query by, so common lookups stay indexed while the table stays open. `acceptedByHuman` and `humanCorrection` record human judgment — the UI prefers `humanCorrection` over `classification`. | → `EmailMessage`, `EmailThread`, `Lead`, `Campaign`, `CampaignLead` (all Cascade) |
| `WebhookEvent` | **W?** | Raw provider notification persisted **before** any processing, because Gmail Pub/Sub has an aggressive ack deadline and redelivers freely: record durably, ack fast, process from a job. `providerEventId` globally unique — it is the provider's namespace, and it makes redelivery a no-op. Payload is untrusted **data, never instructions.** | ┈`Workspace` (Cascade), ┈`emailAccount` (SetNull) |
| `Job` | **W** | The durable queue row. `type`, small `payload` (ids, not bodies), `state`, `priority` (sends outrank rollups so an analytics backlog cannot delay a send), `runAt` (the delay mechanism and the backoff deadline), `leaseExpiresAt`/`lockedBy`/`lockedAt`, `attempt`/`maxAttempts`, `dedupeKey` (unique, non-null), `failedAt`, `replayCount` (distinguishes system retry from a human pressing retry), `durationMs`. | → `Workspace` (Cascade), ┈`scheduledEmail` (Cascade) |

---

## 3. Tenancy

### The rule

Every tenant-owned table carries a non-null `workspaceId` with an index, and
`workspaceId` is resolved **server-side from the session**. A `workspaceId`
arriving in a request body, query string, or hidden field is ignored and treated
as suspicious. Cross-workspace access returns **404, not 403** — we do not
confirm that another tenant's resource exists.

### The four models without `workspaceId`, and why each is legitimate

| Model | Why it has no `workspaceId` |
|---|---|
| `User` | A `User` is **a person, not a tenant resource.** One human may belong to several workspaces with one password and one session. Attaching a workspace to the identity row would force duplicate accounts per tenant, which breaks password reset, session revocation, and "switch workspace". Tenant scope lives in `WorkspaceMember`, which is where authorization reads it. |
| `Session` | A session authenticates **the person**, not the tenancy. It carries a *nullable* `activeWorkspaceId` — the workspace the user is currently "in" — which is nullable because a freshly registered user has no membership yet. Making the session workspace-scoped would mean re-authenticating on every workspace switch. |
| `PasswordResetToken` | Belongs to the identity for the same reason. A reset is an identity operation; scoping it to a tenant would make a multi-workspace user's reset link ambiguous. |
| `Workspace` | It **is** the tenant. A self-referential `workspaceId` would be noise. |

Two further models carry a **nullable** `workspaceId` — a deliberate, documented
exception rather than a gap:

| Model | Why nullable |
|---|---|
| `AuditLog` | Some auditable events happen **before any workspace is known** — a failed login for an unknown email address is exactly the event a security log must capture, and there is no tenant to attribute it to. `onDelete: SetNull`, so purging a workspace does not erase its security history. |
| `WebhookEvent` | An **unmatched** payload (mailbox disconnected, wrong Google project) genuinely has no workspace. `WebhookState.UNMATCHED` exists for it and the row is kept for forensics. |

Everything else — all 36 remaining models — is non-null workspace-scoped.

### Workspace-scoped uniqueness

> Unique constraints on tenant data are scoped. **There are no bare-global
> uniques on tenant natural keys.**

Scoping is achieved two ways, both acceptable:

**Directly**, with `workspaceId` leading:

```prisma
@@unique([workspaceId, email])            // Lead, EmailAccount
@@unique([workspaceId, name])             // Campaign, Domain, LeadList, LeadTag, WarmupPool
@@unique([workspaceId, key])              // CustomFieldDefinition
@@unique([workspaceId, scope, value])     // Suppression
@@unique([workspaceId, userId])           // WorkspaceMember
```

**Transitively**, through a leading column that is itself a workspace-scoped FK.
`campaignId` cannot name two workspaces, so `(campaignId, leadId)` is already
tenant-scoped and adding `workspaceId` would only widen the index:

```prisma
@@unique([campaignId, leadId])                    // CampaignLead
@@unique([campaignId, emailAccountId])            // CampaignMailbox
@@unique([campaignId, leadListId])                // CampaignLeadListSource
@@unique([sequenceId, position])                  // SequenceStep
@@unique([sequenceStepId, label])                 // SequenceStepVariant
@@unique([campaignLeadId, sequenceStepId])        // ScheduledEmail
@@unique([emailAccountId, providerThreadId])      // EmailThread
@@unique([emailAccountId, providerMessageId])     // EmailMessage
@@unique([emailAccountId, localDate])             // MailboxDailyStat
@@unique([leadListId, leadId])                    // LeadListMembership
@@unique([leadTagId, leadId])                     // LeadTagLink
@@unique([warmupPoolId, emailAccountId])          // WarmupPoolMember
@@unique([experimentId, variantId])               // ExperimentArm
```

### The global uniques, and why each is not a tenancy leak

Global uniques exist, and every one is defensible. They fall into three classes,
none of which is tenant natural-key data:

| Constraint | Class | Justification |
|---|---|---|
| `User.email` | identity handle | The login handle. Identity is global by design (§3). |
| `Workspace.slug` | tenant address | Appears in URLs; the tenant namespace is global by definition. |
| `Session.tokenHash`, `PasswordResetToken.tokenHash`, `WorkspaceInvite.tokenHash`, `TrackingLink.token` | **unguessable secret** | These are looked up by endpoints with **no session and therefore no workspace context**. The token *is* the lookup key. A workspace-scoped constraint would be unenforceable at the only point it matters. |
| `ScheduledEmail.dedupeKey`, `EmailEvent.dedupeKey`, `Job.dedupeKey` | **idempotency key** | Global on purpose — see §5. The whole point is that the second insert fails no matter which code path attempts it. Each key embeds workspace-scoped ids, so collision across tenants is not reachable. |
| `WebhookEvent.providerEventId` | foreign namespace | The provider's id space, not ours. Global uniqueness is what makes redelivery a no-op. |
| `Sequence.campaignId`, `SyncState.emailAccountId` | 1:1 enforcement | These are the `@unique` half of a one-to-one relation on an already-scoped FK. |
| `AIAnalysis.(targetType, targetId, kind, promptVersion)` | scoped by cuid | `targetId` is a cuid for a workspace-scoped row, so the tuple cannot span tenants. |

---

## 4. State machines

Every state in this system is an enum column, never a string. What follows are
the **real enums** from `prisma/schema.prisma` — all members, the legal
transitions, the trigger for each, and the terminal set.

### 4.1 `CampaignStatus` — the campaign lifecycle

```
                      ┌──────────────────────────────┐
                      │                              │
   ┌─────────┐  launch   ┌───────────┐  first tick  ┌─▼──────┐
   │  DRAFT  │──────────▶│ SCHEDULED │─────────────▶│ ACTIVE │
   └────┬────┘           └─────┬─────┘              └─┬───┬──┘
        │                      │                      │   │
        │                      │ pause                │   │ all enrollments
        │                      ▼         pause        │   │ terminal
        │                 ┌────────┐◀─────────────────┘   │
        │                 │ PAUSED │                      │
        │                 └────┬───┘─── resume ───────────┤
        │                      │                          ▼
        │                      │                   ┌───────────┐
        └──────────────────────┴──────────────────▶│ COMPLETED │
                     archive          archive      └─────┬─────┘
                        │                                │
                        ▼                                ▼
                   ┌──────────┐ ◀───────────────────────┘
                   │ ARCHIVED │  (terminal)
                   └──────────┘
```

| Transition | Trigger |
|---|---|
| `DRAFT → SCHEDULED` | Human presses launch. Sets `launchedAt`. Scheduler has not yet materialised anything. |
| `SCHEDULED → ACTIVE` | First `SCHEDULER_TICK` job runs and materialises the first batch. |
| `ACTIVE → PAUSED` · `SCHEDULED → PAUSED` | Human pause, or an automatic guard (mailbox `DISCONNECTED`, bounce-rate circuit breaker). Sets `pausedAt`. |
| `PAUSED → ACTIVE` | Human resume. |
| `ACTIVE → COMPLETED` | Every `CampaignLead` reached a terminal `EnrollmentState`. Sets `completedAt`. System-triggered. |
| `* → ARCHIVED` | Human archive. Hides from lists; retains all data. |

**Terminal:** `ARCHIVED`. `COMPLETED` is terminal for sending but a human can
still archive it. `DRAFT` is the only status from which the sequence may be
edited freely.

### 4.2 `EnrollmentState` — `CampaignLead`, the program counter

10 members. This is the most important state machine in the product.

```
  enroll
    │
    ▼
┌─────────┐  step 1 materialised   ┌────────┐  WAIT step / out of window  ┌─────────┐
│ PENDING │──────────────────────▶ │ ACTIVE │◀───────────────────────────▶│ WAITING │
└────┬────┘                        └───┬────┘        window opens         └────┬────┘
     │                                 │                                      │
     │        pause (human or campaign)│                                       │
     │                                 ▼                                       │
     │                            ┌────────┐                                   │
     └───────────────────────────▶│ PAUSED │◀──────────────────────────────────┘
                                  └────┬───┘
                                       │ resume → ACTIVE | WAITING
     ┌─────────────────────────────────┴─────────────────────────────────┐
     │                                                                   │
     ▼ last step sent, no reply        ▼ inbound HUMAN_REPLY             ▼
┌───────────┐                    ┌─────────┐                      ┌─────────┐
│ COMPLETED │                    │ REPLIED │                      │ STOPPED │
└───────────┘                    └─────────┘                      └─────────┘
                                                                  stopReason set
     ▼ hard bounce / soft limit       ▼ unsubscribe                ▼ no mailbox,
┌─────────┐                     ┌──────────────┐                    invalid address
│ BOUNCED │                     │ UNSUBSCRIBED │                  ┌────────┐
└─────────┘                     └──────────────┘                  │ FAILED │
                                                                  └────────┘
        ── all six above are TERMINAL: nextStepAt = NULL, currentStepId = NULL ──
```

| Transition | Trigger |
|---|---|
| `→ PENDING` | Enrollment created. `nextStepAt` set to the campaign start. |
| `PENDING → ACTIVE` | Scheduler materialises the first `ScheduledEmail`. |
| `ACTIVE ⇄ WAITING` | A WAIT step, or the send window / daily cap pushing the next step out. Scheduler-driven. |
| `* → PAUSED` | Human pause, or campaign-level pause cascading down. |
| `→ COMPLETED` | Last step sent and no reply arrived. Sets `completedAt`. |
| `→ REPLIED` | Inbound message classified `HUMAN_REPLY`. **The invariant "a reply stops the sequence."** |
| `→ BOUNCED` | `HARD` bounce, or `SOFT` bounces exceeding the limit. |
| `→ UNSUBSCRIBED` | Unsubscribe click or `UNSUBSCRIBE_REQUEST` classification. Also writes a `Suppression`. |
| `→ STOPPED` | Anything else that halts early; `stopReason` records which. |
| `→ FAILED` | Could not send at all — no eligible mailbox, invalid address, suppressed at materialisation. |

**Terminal set:** `COMPLETED`, `STOPPED`, `REPLIED`, `BOUNCED`, `UNSUBSCRIBED`,
`FAILED`. Entering any of them sets `stoppedAt` (or `completedAt`) and nulls
`nextStepAt`, which is what removes the row from the scheduler's index.

`EnrollmentStopReason` — 13 members, the *why* behind `STOPPED` and friends:
`HUMAN_REPLY`, `HARD_BOUNCE`, `SOFT_BOUNCE_LIMIT`, `UNSUBSCRIBED`, `SUPPRESSED`,
`SPAM_COMPLAINT`, `MANUAL`, `CAMPAIGN_DELETED`, `CONDITION_EXIT`,
`LEAD_DISQUALIFIED`, `NO_ELIGIBLE_MAILBOX`, `INVALID_EMAIL`,
`DUPLICATE_ENROLLMENT`. It is reused as `ScheduledEmail.cancelledReason`, so a
cancelled send and the enrollment that cancelled it speak one vocabulary.

### 4.3 `ScheduledEmailState` — one send

```
                          ┌── reply / unsubscribe / pause / campaign edit ──┐
                          │                                                 ▼
   materialise      ┌───────────┐   conditional UPDATE      ┌───────────┐  ┌───────────┐
   ───────────────▶ │ SCHEDULED │ ────────────────────────▶ │  SENDING  │  │ CANCELLED │
                    └───────────┘  WHERE state='SCHEDULED'  └─────┬─────┘  └───────────┘
                                   (exactly one worker wins)      │
                                                     ┌────────────┴────────────┐
                                            provider │ accepted    rejected /  │
                                                     ▼             retries out ▼
                                                ┌────────┐              ┌────────┐
                                                │  SENT  │              │ FAILED │
                                                └───┬────┘              └────────┘
                                                    │ DSN arrives
                                                    ▼
                                               ┌─────────┐
                                               │ BOUNCED │
                                               └─────────┘
```

| Transition | Trigger |
|---|---|
| `→ SCHEDULED` | Scheduler materialises the row, content already rendered and frozen, `scheduledAt` already adjusted into the window. |
| `SCHEDULED → SENDING` | A worker wins a conditional `UPDATE … WHERE state='SCHEDULED'`. Sets `claimedAt`, `claimedBy`. |
| `SENDING → SENT` | Provider accepted. Sets `sentAt`, `providerMessageId`, `providerThreadId`. |
| `SENDING → FAILED` | Permanent rejection (`permanentFailure = true`) or retries exhausted. |
| `SCHEDULED → CANCELLED` | Superseded before claim: reply, unsubscribe, pause, campaign edit. Sets `cancelledAt`, `cancelledReason`. |
| `SENT → BOUNCED` | Reply/bounce processing parsed a DSN for this send. |

**Terminal:** `SENT`, `FAILED`, `CANCELLED`, `BOUNCED`.

**`SENDING` is never automatically retried.** A `SENDING` row older than the
lease bound means a worker died with a provider call possibly in flight — the
message may already be on its way to a human. Blindly retrying it is precisely
the double-send the whole design exists to prevent. Recovery is: look for our
own `rfcMessageId` in the mailbox (we generated it before the send, so it is
findable), then resolve to `SENT` or back to `SCHEDULED` deliberately. A
`CANCELLED` row is only reachable from `SCHEDULED`, never from `SENDING`.

`ScheduledEmailKind` — `CAMPAIGN_STEP`, `WARMUP` (never counted in campaign
analytics), `MANUAL` (a one-off inbox send that still needs queueing and limits).

### 4.4 `JobState` — the queue

```
  enqueue
     │
     ▼
┌─────────┐                        ┌─────────┐   handler returns   ┌───────────┐
│ PENDING │ ──── lease ──────────▶ │ RUNNING │ ──────────────────▶ │ SUCCEEDED │
└─────────┘                        └────┬────┘                     └───────────┘
     ▲                                  │
     │ lease expired                    │ throws
     │ (sweeper)                        ▼
     │                        ┌──────────────────┐
     │                        │ attempt < max ?  │
     │                        └───┬──────────┬───┘
     │                        yes │          │ no
┌────┴─────┐  runAt <= now()      │          ▼
│ RETRYING │◀─────────────────────┘     ┌──────┐
└──────────┘  backoff + jitter          │ DEAD │  failedAt set, dead-letter UI
     │                                  └───┬──┘
     └──── lease (RETRYING is leasable) ─────┘ operator replay → replayCount++

  ┌───────────┐
  │ CANCELLED │  campaign paused / ScheduledEmail cancelled, before RUNNING
  └───────────┘
```

| Transition | Trigger |
|---|---|
| `PENDING/RETRYING → RUNNING` | Worker's `FOR UPDATE SKIP LOCKED` lease. Sets `leaseExpiresAt`, `lockedBy`, `lockedAt`, `startedAt`, increments `attempt`. |
| `RUNNING → SUCCEEDED` | Handler returned. Sets `completedAt`, `durationMs`. |
| `RUNNING → RETRYING` | Handler threw and `attempt < maxAttempts`. `runAt` = now + exponential backoff + jitter. |
| `RUNNING → DEAD` | Retries exhausted, or a permanent error. Sets `failedAt`, `lastError`, `lastErrorStack`. |
| `RUNNING → PENDING` | **Lease expiry sweeper**: `leaseExpiresAt < now()` means the worker died. |
| `DEAD → PENDING` | Operator replay; `replayCount` increments so "the system retried" is distinguishable from "a human pressed retry". |
| `→ CANCELLED` | Enqueued work no longer wanted. |

**Terminal:** `SUCCEEDED`, `CANCELLED`, and `DEAD` (terminal until a human
replays it). `PENDING` and `RETRYING` are both **leasable** — they differ only
for observability, which is why the lease predicate is `state IN
('PENDING','RETRYING')` rather than an equality test.

A job row is **intent, not a guarantee of once-only execution.** At-least-once
delivery is the contract. Exactly-once *effect* comes from the target row's own
state guard (`ScheduledEmail.state`) plus `Job.dedupeKey` — see §5.

### 4.5 `OpportunityStage`

```
┌─────┐   ┌─────────────┐   ┌────────────────┐   ┌──────────┐   ┌─────────────┐   ┌─────┐
│ NEW │──▶│ QUALIFYING  │──▶│ MEETING_BOOKED │──▶│ PROPOSAL │──▶│ NEGOTIATION │──▶│ WON │
└──┬──┘   └──────┬──────┘   └───────┬────────┘   └────┬─────┘   └──────┬──────┘   └─────┘
   │             │                  │                 │                │
   └─────────────┴──────────────────┴─────────────────┴────────────────┴──────▶ ┌──────┐
                        LOST is reachable from any stage                        │ LOST │
                                                                                └──────┘
```

Trigger: **human only**, by drag-and-drop on the pipeline board or an edit. The
forward path is the happy path but stages are not enforced to be sequential —
skipping and moving backwards are both legal, because real deals do that and a
database that forbids it just makes people lie to it. Entering `WON` or `LOST`
sets `closedAt`; `LOST` additionally wants `lostReason`. Every stage change
writes an `Activity` (`OPPORTUNITY_STAGE_CHANGED`, `OPPORTUNITY_WON`,
`OPPORTUNITY_LOST`).

**Terminal:** `WON`, `LOST` — soft-terminal; a human may reopen.

### 4.6 `TaskStatus`

```
┌──────┐──────▶┌─────────────┐──────▶┌──────┐
│ OPEN │       │ IN_PROGRESS │       │ DONE │  completedAt set
└──┬───┘◀──────└──────┬──────┘       └──────┘
   │                  │
   └──────────┬───────┘
              ▼
        ┌───────────┐
        │ CANCELLED │
        └───────────┘
```

Human-triggered throughout, except that `DONE` may also be set by automation
when a task was created to chase a reply that has now arrived. `OPEN → DONE`
directly is legal — `IN_PROGRESS` is optional. **Terminal:** `DONE`,
`CANCELLED`. `TaskPriority` (`LOW`, `NORMAL`, `HIGH`, `URGENT`) is orthogonal
and has no transitions.

### 4.7 `MessageDirection`

```
   ┌──────────┐              ┌─────────┐
   │ OUTBOUND │              │ INBOUND │
   └──────────┘              └─────────┘
    we sent it                someone sent it to us
```

**Immutable — no transitions at all.** Set once at insert: `OUTBOUND` when the
row is created from a `ScheduledEmail` we sent, `INBOUND` when the sync sees a
message whose `fromEmail` is not the mailbox address. It is a fact about the
message, not a state, and it is the field the inbound-processing scan filters on
(`EmailMessage_workspaceId_direction_classification_sentAt_idx`).

### 4.8 `EmailEventType` — the append-only fact vocabulary

10 members. `EmailEvent` rows are **immutable**: there are no transitions
*within* a row. The "state machine" is the legal *sequence of rows* for one
`scheduledEmailId`:

```
 QUEUED ──▶ SENT ──┬──▶ DELIVERED   (provider-confirmed only)
    │              ├──▶ OPENED ⟳    (repeatable; isBot filters scanners)
    │              ├──▶ CLICKED ⟳   (repeatable)
    │              ├──▶ REPLIED
    │              ├──▶ BOUNCED
    │              ├──▶ UNSUBSCRIBED
    │              └──▶ COMPLAINED
    └──▶ FAILED    (never left QUEUED)
```

| Event | Written by |
|---|---|
| `QUEUED` | Scheduler, on materialising the `ScheduledEmail`. |
| `SENT` | Worker, after the provider accepts. |
| `DELIVERED` | **Only when the provider actually tells us.** The Gmail API does not, so this is mostly absent for `GMAIL` and **must not be presented as a metric we have for every send.** |
| `OPENED` | Tracking-pixel request. Repeatable. `isBot` marks scanner/prefetch hits, which are excluded from headline rates. |
| `CLICKED` | `TrackingLink` redirect. Repeatable. `metadata = { url }`. |
| `REPLIED` | Inbound processing, on `HUMAN_REPLY` classification. |
| `BOUNCED` | DSN parsing. `metadata = { code, dsn }`. |
| `UNSUBSCRIBED` | Unsubscribe endpoint or `UNSUBSCRIBE_REQUEST` classification. |
| `COMPLAINED` | Spam complaint (feedback loop, or `SPAM_COMPLAINT` classification). |
| `FAILED` | Worker, on permanent failure or exhausted retries. `metadata = { reason }`. |

`isFirstForSend` is set on the first event of its type per send, which turns
unique-open/click rates into a filtered `COUNT` rather than a `DISTINCT` over the
largest table in the system.

**Honesty constraints that are part of the model, not a UI preference:** opens
are pixel-based and blocked by many clients, so they are labelled *indicative*;
we make **no claim** about inbox-versus-spam placement, which we cannot observe;
and comparative claims are suppressed below `Experiment.minSamplePerArm` rather
than shown with a caveat nobody reads.

### 4.9 Classification: `MessageClassification` and `BounceType`

`EmailMessage.classification` — 8 members. Starts `UNCLASSIFIED`; a
deterministic header/pattern pass runs first, and AI only runs on what survives.
`classifiedByAi` records which decided, so AI can be re-run without re-running
deterministic decisions.

```
                     ┌──────────────┐
                     │ UNCLASSIFIED │  (insert default)
                     └──────┬───────┘
        deterministic pass  │  (headers: Auto-Submitted, Precedence,
        classifiedByAi=false│   X-Autoreply, List-Unsubscribe, Return-Path)
         ┌──────────────────┼──────────────────┬─────────────────────┐
         ▼                  ▼                  ▼                     ▼
    ┌─────────┐   ┌────────────────┐  ┌───────────────────────┐  ┌────────────────────────┐
    │ BOUNCE  │   │ OUT_OF_OFFICE  │  │      AUTO_REPLY       │  │ AUTOMATED_NOTIFICATION │
    └─────────┘   └────────────────┘  └───────────────────────┘  └────────────────────────┘
         │  everything not decided deterministically → AI_CLASSIFY_MESSAGE job
         │  classifiedByAi = true
         ├──────────────────┬─────────────────────┬────────────────────┐
         ▼                  ▼                     ▼                    ▼
   ┌─────────────┐  ┌─────────────────────┐  ┌────────────────┐  ┌──────────────┐
   │ HUMAN_REPLY │  │ UNSUBSCRIBE_REQUEST │  │ SPAM_COMPLAINT │  │ (unchanged)  │
   └──────┬──────┘  └──────────┬──────────┘  └───────┬────────┘  └──────────────┘
          │                    │                      │
          ▼                    ▼                      ▼
  CampaignLead→REPLIED   →UNSUBSCRIBED          →STOPPED
  EmailEvent REPLIED     + Suppression          + Suppression
  thread.hasHumanReply   EmailEvent UNSUBSCRIBED  EmailEvent COMPLAINED
```

`HUMAN_REPLY` is the **only** label that stops a sequence. That is the point of
the enum: an out-of-office bounce-back must not look like engagement, and an
auto-acknowledgement must not silently halt a campaign.

**Human correction wins.** `AIAnalysis.humanCorrection` is a
`MessageClassification?`, and the UI shows it **in preference to**
`classification`. It is also the training signal.

`AIAnalysis.sentiment` (`SentimentLabel`: `POSITIVE`, `NEUTRAL`, `NEGATIVE`) is
orthogonal — a `HUMAN_REPLY` can be negative, and a `POSITIVE` one is what
prompts an `Opportunity`.

`BounceType` — 5 members, set alongside a `BOUNCE` classification:

```
NONE ──▶ HARD     5.x.x — address does not exist. Suppress permanently.
     ├─▶ SOFT     4.x.x — mailbox full / temporary defer. Retry.
     ├─▶ BLOCKED  reputation/policy block. A DELIVERABILITY signal, NOT a bad address.
     └─▶ UNKNOWN  recognised as a DSN, status code unparseable.
```

`BLOCKED` is separated from `HARD` deliberately: suppressing an address because
a receiver throttled our IP would destroy a customer's list over our reputation
problem. It raises a deliverability alert instead.

### 4.10 Remaining enums, briefly

| Enum | Members | Notes |
|---|---|---|
| `Role` | `OWNER`, `ADMIN`, `MEMBER` | On `WorkspaceMember`. Server-enforced. |
| `MemberStatus` | `ACTIVE`, `SUSPENDED` | `SUSPENDED` blocks access without deleting authorship. |
| `InviteStatus` | `PENDING` → `ACCEPTED` \| `REVOKED` \| `EXPIRED` | All three terminal. |
| `EmailProvider` | `GMAIL`, `OUTLOOK`, `SMTP` | Only `GMAIL` is implemented; the others are Phase 11. |
| `EmailAccountStatus` | `CONNECTING` → `ACTIVE` ⇄ `PAUSED` \| `THROTTLED` \| `DISCONNECTED` \| `ERROR` | `CONNECTING` is **not eligible to send** (backfill running). `PAUSED` pauses sending but keeps syncing. `THROTTLED` is automatic with `throttledUntil`; `ERROR` needs a human. |
| `WarmupStatus` | `DISABLED` → `RAMPING` → `COMPLETE`, ⇄ `PAUSED` | |
| `DnsRecordStatus` | `UNKNOWN`, `PASS`, `WARN`, `FAIL`, `LOOKUP_ERROR` | `LOOKUP_ERROR` ≠ `FAIL`: "we could not tell" is not "misconfigured". |
| `SyncStatus` | `IDLE`, `BACKFILLING`, `INCREMENTAL`, `CURSOR_EXPIRED`, `ERROR` | `CURSOR_EXPIRED` exists because Gmail 404s a `historyId` older than ~a week, requiring a bounded re-backfill. |
| `LeadStatus` | `NEW`, `CONTACTED`, `ENGAGED`, `REPLIED`, `UNSUBSCRIBED`, `BOUNCED`, `DISQUALIFIED`, `CUSTOMER` | Lead-level rollup across campaigns; `DISQUALIFIED` is a human excluding the lead from all future campaigns. |
| `VerificationStatus` | `UNVERIFIED`, `VALID`, `RISKY`, `INVALID`, `UNKNOWN` | No verification provider wired yet. |
| `CustomFieldType` | `TEXT`, `NUMBER`, `BOOLEAN`, `DATE`, `URL`, `SELECT` | Validates `Lead.customFields` at the service boundary. |
| `SequenceStepType` | `EMAIL`, `WAIT`, `CONDITION` | |
| `ConditionKind` | `HAS_OPENED_ANY`, `HAS_CLICKED_ANY`, `HAS_REPLIED`, `LEAD_FIELD_EQUALS`, `LEAD_HAS_TAG`, `LEAD_IN_LIST` | |
| `ConditionOutcome` | `CONTINUE`, `SKIP_NEXT`, `STOP` | What happens when the predicate is **false**. `STOP` yields `STOPPED` / `CONDITION_EXIT`. |
| `SuppressionScope` | `EMAIL`, `DOMAIN` | |
| `SuppressionReason` | `UNSUBSCRIBED`, `HARD_BOUNCE`, `SPAM_COMPLAINT`, `MANUAL`, `IMPORTED`, `POLICY` | `POLICY` is the competitor/partner/customer exclusion list. |
| `ActivityType` | 20 members, `LEAD_CREATED` … `MANUAL_EMAIL_SENT` | Presentational only. |
| `AIAnalysisTarget` | `EMAIL_MESSAGE`, `EMAIL_THREAD`, `LEAD`, `CAMPAIGN`, `CAMPAIGN_LEAD` | |
| `AIAnalysisKind` | `REPLY_CLASSIFICATION`, `THREAD_SUMMARY`, `DRAFT_REPLY`, `LEAD_SCORE`, `PERSONALISATION`, `CAMPAIGN_INSIGHT` | |
| `JobType` | 15 members, `SCHEDULER_TICK` … `MAINTENANCE` | |
| `WebhookState` | `RECEIVED` → `PROCESSING` → `PROCESSED` \| `UNMATCHED` \| `FAILED` | |

---

## 5. The invariant table

**This is the most important section in the document.**

Every invariant below is enforced by a **named database object**. Application
code is the first line of defence and the database is the last, and the order
matters: application checks are advisory because they race, and a check that
races is not a guarantee. A unique index is evaluated by one process holding one
lock — it cannot race with itself.

The general argument, before the specifics: **we run N concurrent workers, jobs
are delivered at-least-once, providers redeliver webhooks, and processes die
mid-transaction.** Under those four conditions every "check then act" in
application code has a window between the check and the act. `SELECT` then
`INSERT` is two statements; two workers can both pass the `SELECT`. The only
constructs that close that window are a unique index (the second `INSERT` fails
with `23505`) and a conditional `UPDATE` (the second update matches zero rows).
Both are used here, deliberately, and both are in the schema rather than in a
service so that a *future* code path — a backfill script, an admin action, a
migration, a bug — cannot bypass them.

| # | Invariant | Enforcing object | Kind |
|---|---|---|---|
| 1 | One email per lead per step | `ScheduledEmail_campaignLeadId_sequenceStepId_key` | UNIQUE |
| 2 | No double send under retry | `ScheduledEmail_dedupeKey_key` | UNIQUE |
| 3 | No double-counted analytics | `EmailEvent_dedupeKey_key` | UNIQUE |
| 4 | No duplicate enrollment | `CampaignLead_campaignId_leadId_key` | UNIQUE |
| 5 | Queue leasing | `Job_state_runAt_priority_idx` + `FOR UPDATE SKIP LOCKED` | INDEX + lock |
| 6 | Dead-worker recovery | `Job_state_leaseExpiresAt_idx` | INDEX |
| 7 | Idempotent enqueue | `Job_dedupeKey_key` | UNIQUE |
| 8 | Sync re-run is a no-op | `EmailMessage_emailAccountId_providerMessageId_key` | UNIQUE |
| 9 | One thread row per provider thread per mailbox | `EmailThread_emailAccountId_providerThreadId_key` | UNIQUE |
| 10 | Webhook redelivery is a no-op | `WebhookEvent_providerEventId_key` | UNIQUE |
| 11 | AI cannot burn tokens twice | `AIAnalysis_targetType_targetId_kind_promptVersion_key` | UNIQUE |
| 12 | Daily cap is atomic | `MailboxDailyStat_emailAccountId_localDate_key` | UNIQUE |
| 13 | Exactly one worker sends | `UPDATE … WHERE state = 'SCHEDULED'` | conditional UPDATE |

### 1. One email per lead per step

```
ScheduledEmail_campaignLeadId_sequenceStepId_key
  UNIQUE ("campaignLeadId", "sequenceStepId")
```

```prisma
@@unique([campaignLeadId, sequenceStepId])
```

**How it enforces.** A scheduler tick that runs twice, a `SCHEDULER_TICK` job
delivered twice, or two schedulers racing all attempt the same insert. The first
commits; every other one fails with `23505 unique_violation`. The scheduler
treats `23505` on this constraint as **success** — the row it wanted exists.

**Why the database and not application logic.** The scheduler's natural shape is
"find enrollments where `nextStepAt <= now()`, then insert a `ScheduledEmail` for
each". Between the `SELECT` and the `INSERT` a second tick can run the identical
`SELECT` and see the identical rows, because nothing has changed yet. A
`SELECT … WHERE NOT EXISTS` guard does not help: both transactions evaluate
`NOT EXISTS` as true before either inserts. Only the index, which serialises on
the key itself, resolves it.

**If it were removed:** two `ScheduledEmail` rows for the same step. Both are
independently valid, both get their own `Job`, both send. **The lead receives
the same email twice** — the single most damaging failure this product can have,
because it is visible to the recipient, it is unrecoverable, and it reads as
spam. Note that nullable columns make this constraint inert for `WARMUP` and
`MANUAL` rows (Postgres treats `NULL` as distinct), which is exactly why #2
exists as well.

### 2. No double send under retry

```
ScheduledEmail_dedupeKey_key
  UNIQUE ("dedupeKey")
```

Key format: `"campaign_step:<campaignLeadId>:<stepId>:v<sequenceVersion>"`.

**How it enforces.** `dedupeKey` is `String` — **non-null** — and globally
unique. Where #1 goes inert on `NULL` (warmup and manual sends have no
`campaignLeadId`), this one always applies. It is belt **and** braces on
purpose, and the version suffix means a deliberate re-materialisation after a
sequence edit produces a *different* key while an accidental replay produces the
*same* one.

**Why the database.** The retry path is exactly where application state is least
trustworthy. A worker crashes after inserting but before committing its
bookkeeping; the job is redelivered; the handler re-runs from the top with no
memory of the first attempt. Its in-process "have I done this?" state died with
the process. The database is the only thing that remembers.

**If it were removed:** `WARMUP` and `MANUAL` sends lose all dedup protection —
they are the rows #1 cannot see. A retried manual send from the inbox delivers
twice, to a real person, in a thread they are actively reading.

### 3. No double-counted analytics

```
EmailEvent_dedupeKey_key
  UNIQUE ("dedupeKey")
```

**How it enforces.** `EmailEvent.dedupeKey` is `String?` — nullable, and the
nullability is the design. Provider-sourced facts that can be redelivered (a
webhook replay, a re-synced bounce) carry a key derived from the provider's own
id. Opens and clicks leave it `NULL` because a recipient opening an email three
times is **three real facts**, and Postgres treats each `NULL` as distinct, so
they all insert.

**Why the database.** Gmail Pub/Sub has an aggressive ack deadline and
redelivers freely — that is documented, expected behaviour, not an error path.
`EmailEvent` is append-only with `UPDATE`/`DELETE` revoked, so there is no
"clean up the duplicate later". The insert must be correct the first time.

**If it were removed:** a redelivered bounce notification inserts twice. Bounce
rate doubles on the dashboard, the deliverability circuit breaker trips on a
number that is not real, and it **pauses a healthy campaign**. Worse, because
counters on parent rows are caches rebuilt *from* `EmailEvent`, a rebuild
faithfully reproduces the corruption — the wrong number becomes stable and
looks trustworthy.

### 4. No duplicate enrollment

```
CampaignLead_campaignId_leadId_key
  UNIQUE ("campaignId", "leadId")
```

**How it enforces.** The upstream defence, one level above #1. A lead is
enrolled in a campaign **at most once**, so the entire class of "two program
counters for one person in one campaign" is unreachable.

**Why the database.** Enrollment is bulk: "add these 4,000 leads from this
list". A user clicking *Add leads* twice, two overlapping list sources sharing
leads, or a CSV import racing an enrollment all converge on the same
`(campaignId, leadId)`. Deduplicating 4,000 candidates in application code
means reading the existing set first, which is both a race and a large read;
`INSERT … ON CONFLICT DO NOTHING` against this index is one statement, correct
under concurrency, and reports how many were new.

**If it were removed:** two `CampaignLead` rows for one lead. Each has its own
`nextStepAt` and its own `currentStepId`, so each independently satisfies #1 —
the constraint is keyed on `campaignLeadId`, and these are different
`campaignLeadId`s. **#1 provides no protection here**, which is why this
constraint is not redundant with it. The lead receives the entire sequence
twice, and `stopOnReply` halts only one of the two.

### 5. Queue leasing

```
Job_state_runAt_priority_idx
  INDEX ("state", "runAt", "priority" DESC)
```

**How it enforces.** The index makes the lease query cheap; `FOR UPDATE SKIP
LOCKED` makes it correct. The index alone is not the guarantee — the row lock
is. Together they mean N workers can hammer the same query and each walks away
with a disjoint set of jobs, without any worker waiting on another.

**Why the database.** This *is* the concurrency primitive. There is no
application-level equivalent: a shared in-memory claim set does not survive a
process restart and does not exist across machines. Postgres row locks do both.
The exact SQL is in §6.3.

**If it were removed** (the index, not the lock): the lease query degenerates to
a sequential scan over a table where `SUCCEEDED` rows dominate — millions of
irrelevant rows read on every poll, by every worker, several times a second.
The queue does not become *incorrect*, it becomes **too slow to drain**, which
in a sending system means missed send windows and campaigns that silently
stall. Removing the `SKIP LOCKED` instead is worse and quieter: workers serialise
behind each other on the same rows, throughput collapses to one worker's worth,
and adding workers makes it *worse*.

### 6. Dead-worker recovery

```
Job_state_leaseExpiresAt_idx
  INDEX ("state", "leaseExpiresAt")
```

**How it enforces.** A worker sets `leaseExpiresAt` when it leases. The sweeper
runs `WHERE state = 'RUNNING' AND "leaseExpiresAt" < now()` and returns those
rows to `PENDING`. This index makes that query a bounded range scan instead of a
full scan of every job that ever ran.

**Why the database.** A crashed process cannot clean up after itself — it is
gone. There is nowhere else the "this job was claimed at time T and should have
finished by T+n" fact can live durably. A heartbeat in memory dies with the
worker; an OOM kill, a `SIGKILL`, a container eviction, and a power loss all
produce the same orphan, and only a timestamp in a committed row survives all
four.

**If it were removed:** the sweeper's scan cost grows with total job history
until it either times out or is disabled — and then orphaned `RUNNING` jobs are
never reclaimed. Sends stop happening with **no error anywhere**: the job looks
`RUNNING`, so nothing retries it and nothing alerts. That is the worst failure
shape in the system, because the dashboard shows a healthy campaign that is
sending nothing.

**Note the deliberate asymmetry with `ScheduledEmail`.** A `Job` returning to
`PENDING` is safe because the *effect* is guarded by #13 — the re-run finds
`state <> 'SCHEDULED'` and no-ops. A `ScheduledEmail` stuck in `SENDING` is
**not** swept back automatically (§4.3): the provider call may have succeeded.

### 7. Idempotent enqueue

```
Job_dedupeKey_key
  UNIQUE ("dedupeKey")
```

`dedupeKey` is **non-null**: every job must be able to name itself, because a job
that cannot be deduplicated is a job that can double-send. Format
`"<type>:<stable-natural-key>"`, e.g. `"SEND_SCHEDULED_EMAIL:<scheduledEmailId>"`.
For legitimately repeatable work the key carries the period bucket:
`"SCHEDULER_TICK:<campaignId>:2026-08-31T14:05"`.

This is what makes **transactional enqueue** safe, which is the reason the queue
lives in Postgres at all: the job and the row that caused it commit in one
transaction, so there is no dual-write drift between a database and a broker. A
second insert raises `23505` and the caller treats it as success.

**If it were removed:** a retried scheduler tick enqueues a second
`SEND_SCHEDULED_EMAIL` for the same row. #13 still prevents the double *send* —
but the queue fills with duplicate work, the dead-letter view fills with
duplicate failures, and the layered defence loses a layer.

### 8–12. The remaining enforced invariants

| Object | Guarantee | If removed |
|---|---|---|
| `EmailMessage_emailAccountId_providerMessageId_key` | Re-fetching a message is an **upsert**, never a duplicate. Essential because `CURSOR_EXPIRED` forces a re-backfill over messages we already have. | Every re-backfill duplicates the inbox. Threads show each message N times; reply detection fires N times; `messageCount` is meaningless. |
| `EmailThread_emailAccountId_providerThreadId_key` | One thread row per provider thread **per mailbox**. Scoped by `emailAccountId` (itself workspace-scoped), so two mailboxes seeing one conversation correctly get two rows. | Concurrent sync workers create two thread rows for one conversation; messages split across them; the inbox shows the same conversation twice with half the messages in each. |
| `WebhookEvent_providerEventId_key` | Pub/Sub redelivery is a no-op. Global because it is the provider's namespace. | Every redelivery re-runs inbound processing. Combined with a missing #3, replies double-count. |
| `AIAnalysis_targetType_targetId_kind_promptVersion_key` | Re-running the same prompt on the same target is an upsert. A retried job **cannot burn tokens twice or produce two contradictory labels.** | Retries cost real money, and two rows disagree about whether a message is a `HUMAN_REPLY` — with no principled tiebreak. |
| `MailboxDailyStat_emailAccountId_localDate_key` | The daily cap is one indexed upsert inside the **same transaction that claims the send**, so `sentCount` cannot be incremented twice or read stale. | Two rows for one mailbox-day, each holding part of the count. The cap is computed from one of them and the mailbox sends over its limit — the invariant "never send over the daily cap", broken, with deliverability consequences that outlive the bug. |

### 13. Exactly one worker actually sends

This one is not an index. It is the conditional `UPDATE` that the whole sending
path pivots on:

```sql
UPDATE "ScheduledEmail"
   SET state = 'SENDING', "claimedAt" = now(), "claimedBy" = $2
 WHERE id = $1
   AND state = 'SCHEDULED'      -- ← the guard
RETURNING id;
```

Zero rows returned means someone else won, or the row was cancelled — either way
this worker **must not call the provider**. Postgres serialises concurrent
`UPDATE`s on the same row, so exactly one transaction sees `state = 'SCHEDULED'`
and the losers see `SENDING`. This holds for N workers, at-least-once job
delivery, and duplicate jobs simultaneously.

Together with #7 the layering is: `Job.dedupeKey` stops the duplicate *job*;
this guard stops the duplicate *send* even when a duplicate job exists anyway.
**Idempotency is a property of the effect, not of the message.**

---

## 6. Index per query path

222 indexes exist because every hot path was named first and given one. Below,
the actual query, then the object that serves it.

### 6.1 Hot paths

| # | Query | Index |
|---|---|---|
| 1 | **Inbox list** — one mailbox, unarchived, newest first | `EmailThread_emailAccountId_isArchived_lastMessageAt_idx` |
| 1b | Unified inbox across all mailboxes in a workspace | `EmailThread_workspaceId_isArchived_lastMessageAt_idx` |
| 1c | Unread filter | `EmailThread_emailAccountId_isRead_lastMessageAt_idx` |
| 1d | "Replies only" filter | `EmailThread_workspaceId_hasHumanReply_lastMessageAt_idx` |
| 2 | **Scheduler: what is due now** (enrollments) | `CampaignLead_state_nextStepAt_idx` |
| 2b | Which campaigns need a tick | `Campaign_status_startAt_idx` |
| 2c | **Which sends are due** | `ScheduledEmail_state_scheduledAt_idx` (+ partial, §6.2) |
| 2d | Per-mailbox pacing / next eligible send | `ScheduledEmail_emailAccountId_state_scheduledAt_idx` |
| 3 | **Queue lease** | `Job_state_runAt_priority_idx` |
| 3b | Lease-expiry sweep | `Job_state_leaseExpiresAt_idx` |
| 3c | Dead-letter view, per-tenant depth | `Job_workspaceId_state_createdAt_idx` |
| 4 | **Lead list**, default (not deleted, newest first) | `Lead_workspaceId_deletedAt_createdAt_idx` |
| 4b | Filter by status / owner / domain / score | `Lead_workspaceId_status_idx`, `_ownerUserId_idx`, `_emailDomain_idx`, `_score_idx` |
| 5 | **Campaign analytics rollup** | `EmailEvent_campaignId_type_occurredAt_idx` |
| 5b | Per-step and per-variant rollups | `EmailEvent_sequenceStepId_type_occurredAt_idx`, `EmailEvent_variantId_type_occurredAt_idx` |
| 5c | Mailbox health rollup | `EmailEvent_emailAccountId_type_occurredAt_idx` |
| 5d | Workspace time-series chart | `EmailEvent_workspaceId_occurredAt_idx` |
| 6 | **Activity timeline** on a lead | `Activity_leadId_occurredAt_idx` |
| 6b | Workspace-wide activity feed | `Activity_workspaceId_occurredAt_idx` |
| 7 | Thread detail, chronological | `EmailMessage_threadId_sentAt_idx` |
| 8 | Inbound processing scan | `EmailMessage_workspaceId_direction_classification_sentAt_idx` |
| 9 | Reply attribution by header | `EmailMessage_emailAccountId_rfcMessageId_idx`, `EmailMessage_emailAccountId_inReplyTo_idx` |
| 10 | Pipeline board, one column ordered | `Opportunity_workspaceId_stage_position_idx` |
| 11 | "My open tasks, soonest first" | `Task_workspaceId_assigneeUserId_status_dueAt_idx` |
| 12 | Scheduler mailbox selection | `EmailAccount_status_throttledUntil_idx` |
| 13 | Daily cap check | `MailboxDailyStat_emailAccountId_localDate_key` |

Representative SQL for the two most-run reads:

```sql
-- 1. Inbox list. Index-ordered; no sort, no join. lastMessagePreview,
--    lastMessageDirection and messageCount are denormalised onto the thread
--    precisely so rendering a row touches EmailMessage zero times.
SELECT id, subject, "lastMessageAt", "lastMessagePreview",
       "lastMessageDirection", "messageCount", "isRead", "hasHumanReply"
  FROM "EmailThread"
 WHERE "emailAccountId" = $1
   AND "isArchived" = false
 ORDER BY "lastMessageAt" DESC
 LIMIT 50;
```

```sql
-- 2. Scheduler: which enrollments are due. Leading equality on state,
--    range on nextStepAt. Terminal enrollments set nextStepAt = NULL and
--    leave the index entirely -- the working set stays proportional to
--    live work, not to history.
SELECT id, "campaignId", "currentStepId", "assignedEmailAccountId"
  FROM "CampaignLead"
 WHERE state IN ('PENDING', 'ACTIVE', 'WAITING')
   AND "nextStepAt" <= now()
 ORDER BY "nextStepAt"
 LIMIT 500;
```

```sql
-- 5. Campaign analytics rollup. One index, one pass, no joins -- every
--    dimension is already on the row.
SELECT type, count(*) AS n, count(*) FILTER (WHERE "isFirstForSend") AS uniq
  FROM "EmailEvent"
 WHERE "campaignId" = $1
   AND "occurredAt" >= $2
   AND "isBot" = false
 GROUP BY type;
```

### 6.2 Partial and GIN indexes

Prisma's schema language cannot express partial or GIN indexes. These live in
hand-edited migration SQL and are **load-bearing** — they are the ones the
planner actually chooses on the hot paths, because the `@@index` equivalents
cover tables where terminal rows dominate forever.

```sql
-- Queue lease. Between maintenance sweeps SUCCEEDED rows dominate Job;
-- this index contains ONLY leasable rows, so it stays small enough to
-- remain in cache no matter how much history accumulates.
CREATE INDEX "Job_leasable_idx"
    ON "Job" ("runAt", "priority" DESC)
 WHERE state IN ('PENDING', 'RETRYING');

-- Due sends. SENT rows dominate ScheduledEmail permanently.
CREATE INDEX "ScheduledEmail_due_idx"
    ON "ScheduledEmail" ("scheduledAt")
 WHERE state = 'SCHEDULED';

-- Reply attribution by References overlap. Array containment needs GIN;
-- a btree cannot answer "&&".
CREATE INDEX "EmailMessage_references_gin"
    ON "EmailMessage" USING GIN ("references");

-- Inbox participant filter without a join.
CREATE INDEX "EmailThread_participants_gin"
    ON "EmailThread" USING GIN ("participants");

-- At most one LIVE invite per email per workspace. A plain unique would
-- forbid ever re-inviting someone after a revoke.
CREATE UNIQUE INDEX "WorkspaceInvite_live_key"
    ON "WorkspaceInvite" ("workspaceId", email)
 WHERE status = 'PENDING';

-- At most one RUNNING experiment per step; a plain unique would forbid a
-- second test on the same step forever.
CREATE UNIQUE INDEX "Experiment_live_per_step_key"
    ON "Experiment" ("sequenceStepId")
 WHERE "endedAt" IS NULL;

-- A mailbox belongs to at most one warmup pool. Kept out of the Prisma
-- schema so the relation stays one-to-many and EmailAccount.warmupMemberships
-- does not collapse into a single optional row.
CREATE UNIQUE INDEX "WarmupPoolMember_emailAccount_key"
    ON "WarmupPoolMember" ("emailAccountId");

-- Append-only enforcement. Application bugs cannot rewrite history.
REVOKE UPDATE, DELETE ON "EmailEvent" FROM PUBLIC;
REVOKE UPDATE, DELETE ON "AuditLog"   FROM PUBLIC;
```

The append-only `REVOKE`s must also be applied to the application role, not only
`PUBLIC`, since the app connects as `instantmail` and not as `PUBLIC`.

### 6.3 The queue lease query

```sql
-- One transaction. Lease up to $1 jobs, skipping anything another worker holds.
BEGIN;

WITH leased AS (
  SELECT id
    FROM "Job"
   WHERE state IN ('PENDING', 'RETRYING')
     AND "runAt" <= now()
   ORDER BY priority DESC, "runAt"
   LIMIT $1
   FOR UPDATE SKIP LOCKED          -- ← the whole design in four words
)
UPDATE "Job" j
   SET state            = 'RUNNING',
       "leaseExpiresAt" = now() + ($2 || ' seconds')::interval,
       "lockedBy"       = $3,
       "lockedAt"       = now(),
       "startedAt"      = COALESCE(j."startedAt", now()),
       attempt          = j.attempt + 1
  FROM leased
 WHERE j.id = leased.id
RETURNING j.id, j.type, j.payload, j.attempt, j."maxAttempts",
          j."workspaceId", j."scheduledEmailId";

COMMIT;
```

**Why `SKIP LOCKED` is the right primitive for N workers.**

Compare the three available behaviours when two workers reach the same row:

| Primitive | What worker B does | Result with N workers |
|---|---|---|
| plain `SELECT` then `UPDATE` | reads the same rows as A | **both process the same job** — duplicate work, and duplicate sends if the effect were unguarded |
| `FOR UPDATE` | **blocks** until A commits, then re-reads | throughput ≈ one worker; adding workers adds queueing, not capacity. Every worker converges on the same top-of-queue rows and serialises behind the leader |
| `FOR UPDATE SKIP LOCKED` | skips A's locked rows, takes the next unlocked ones | each worker gets a **disjoint** batch, nobody waits, throughput scales with worker count |

`SKIP LOCKED` turns one ordered queue into N non-overlapping cursors with no
coordination, no partitioning scheme, and no broker. The disjointness is
guaranteed by Postgres's row locks, not by our code, and it holds across
processes, containers, and machines — which an in-memory claim set cannot do.

Three details that matter:

- **`LIMIT` inside the CTE, before the lock.** The subquery orders and limits,
  then locks only what it took. Locking first and filtering after would hold
  locks on rows this worker is not going to run.
- **`ORDER BY priority DESC, "runAt"`.** Sends outrank rollups, so an analytics
  backlog can never delay a scheduled send. Ordering is advisory under
  `SKIP LOCKED` — a worker may take a lower-priority job when the high-priority
  ones are all locked, which is correct: waiting for a busy row starves the
  worker for no benefit.
- **The lease is a timestamp, not a lock.** The row lock is released at
  `COMMIT`, a few milliseconds later; the *lease* is `leaseExpiresAt`, which
  survives the transaction and the process. That is what makes #6 possible: a
  lock held for the job's whole duration would be lost on crash with no trace,
  whereas a committed timestamp is exactly the evidence the sweeper needs.

This is also why integration tests must **not** wrap tests in a rolled-back
transaction: one connection cannot exercise `SKIP LOCKED` at all, so the entire
lease mechanism would be untestable. See §9.
