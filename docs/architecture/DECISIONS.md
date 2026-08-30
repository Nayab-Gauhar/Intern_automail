# Lead decisions

Conflicts between architecture documents, resolved by the lead. Each entry is a decision the
docs could not settle among themselves, with the reasoning, so it is not relitigated.

---

## D1 — `campaigns.launch` is available to MEMBER

**Status:** decided. Supersedes `07-auth-and-security.md` §9.4.

### The conflict

Two docs specified opposite things:

| Doc | Position | Argument |
|---|---|---|
| `07-auth-and-security.md` §9.4 | ADMIN+ only | Launching sends real mail from a real domain and can burn its reputation — a blast radius outside the product. |
| `02-backend.md` §16.12 | MEMBER | "A tool where the person doing outreach must ask an admin to press send is a tool people work around." |

`02-backend.md` cited `03-frontend.md` §16 as agreeing with it. It does not: §16 lists mailbox
connection as an *open question* and says "The brief's role table does not say." The citation
was wrong, so it carries no weight either way.

The locked brief does not settle it. It requires only that campaign launch be **audit-logged**
(§6), which marks the action as sensitive without assigning a role.

### Decision: MEMBER may launch. `'campaigns.launch': ALL`.

The security argument for ADMIN-only rests on a premise that does not hold here: that
launching is what endangers the domain. It is not. The controls that actually bound outbound
volume and reputation are separate capabilities, and all of them remain ADMIN+:

```
mailboxes.connect       ADMIN+   which mailboxes exist at all
mailboxes.limits_edit   ADMIN+   daily cap, sending window, ramp
domains.manage          ADMIN+   SPF/DKIM/DMARC
warmup.manage           ADMIN+   ramp policy
```

A MEMBER pressing launch cannot exceed a cap they cannot edit, send from a mailbox they
cannot connect, or widen a window they cannot change. They can start sending *within limits an
ADMIN already set*. The reputation risk sits with whoever sets those limits, and that is
already gated.

Against that, ADMIN-only launch has a concrete security cost: the primary user of an outreach
tool **is** the person doing outreach. Making them ask someone else to press send does not
stop the send — it produces shared ADMIN credentials, which is strictly worse than the
capability we were trying to withhold.

### What stays ADMIN+, and why the reasoning differs

- `leads.export` and `leads.bulk_delete` — the lead list is the customer's commercial asset,
  and "departing employee exports the list" is a real incident class. Unlike launching, there
  is **no** other capability that bounds the damage: one export is total. Both docs already
  agree here.
- `mailboxes.connect` — grants us an OAuth scope over a person's real mailbox. Also
  irreversible in the sense that matters: the grant exists until revoked.

The distinction is whether another ADMIN-gated control already bounds the blast radius.
For launching, one does. For exporting, none does.

### Consequences

- `src/server/authz.ts`: `'campaigns.launch'` moves from `STAFF` to `ALL`.
- `campaigns.pause` was already `ALL` and stays there — stopping sends is a safety action and
  must never require permission.
- Launch remains audit-logged per the brief.
- `07-auth-and-security.md` §9.4's `campaigns.launch` row is superseded by this entry. The doc
  is left as written rather than edited, so the original reasoning stays legible.

---

## D2 — Open and click tracking default to OFF

**Status:** decided. Changes `Workspace.trackOpensDefault`, `Workspace.trackClicksDefault`,
and `Campaign.trackOpens`/`trackClicks` defaults from `true` to `false`.

Both the email-provider and analytics docs flagged this as a product decision for the lead
rather than changing it unilaterally. The schema shipped `true`.

The locked brief does **not** require opt-in — it requires that open data be *labelled
indicative rather than factual*. So this is a genuine product call, and it goes to `false`
for three reasons:

1. **Deliverability.** A tracking pixel is a remote image in a cold email from an unknown
   sender. It is one of the signals spam filters weigh, and this product's entire value
   depends on landing in the inbox. Trading inbox placement for a metric we already
   describe as unreliable is a bad trade.
2. **The metric barely survives its own caveats.** Image proxying, blocked images, and
   prefetching mean open rate is noise at small volumes. `08` §7.1 already forbids any
   insight rule from firing on open rate alone, and `Experiment.primaryMetric` defaults to
   `"reply"`. A default-on metric that no decision may rest on is cost without benefit.
3. **Consent posture.** Silently embedding a tracker on behalf of a new workspace is a
   default nobody asked for.

**This is cheap now and expensive later.** Flipping a default before any data exists is a
one-line schema change. After customers have campaigns, it needs a data migration plus a
user-visible behaviour change. That asymmetry is the reason to decide now rather than defer.

Click tracking follows opens for consistency: link rewriting also alters the message and has
its own deliverability cost.

---

## D3 — Four missing database objects added

**Status:** decided and implemented.

Three docs specified objects the schema lacked, each blocking a named phase. Verified absent
by grep before adding:

| Object | Blocks | Why it cannot be deferred |
|---|---|---|
| `RateLimit` | phase 1 | already added — see commit c0c65c7 |
| `WorkerHeartbeat` | phase 6 | `/api/health`'s worker liveness check is a stub without it, so "is the worker alive" is unanswerable |
| `SendAttempt` | phase 6 | crash-after-provider-accept reconciliation needs per-attempt forensics; without it a duplicate send is undiagnosable |
| `MailboxDailyStat.reservedCount` | phase 6 | `sentCount` alone cannot enforce a daily cap: two workers both read *under cap*, both send, and the cap is exceeded. A reservation counter with `reservedCount >= sentCount` makes the check atomic |
| `Job.enqueuedByRequestId` | phase 6 | `09`'s tracing claim ("why has this lead not received step 3") is unanswerable without correlating a job to the request that created it |

`OAuthState` is **not** added as a Prisma model. It would need a nullable `workspaceId`
(state is minted before a workspace is known), making it a fourth exception to the non-null
tenancy invariant — for a table whose rows live ten minutes. It lands as hand-written
migration SQL alongside the other objects Prisma cannot express.

---

## D4 — `09-deployment-and-testing.md` contains stale SQL that would fail at runtime

**Status:** identified, fix owned by the lead.

Unlike a naming drift in prose, these appear inside **runnable SQL** — the §5.4 metric
queries and the restore script — so they fail rather than mislead:

| In the doc | Actually in the schema |
|---|---|
| `attempts` | `attempt` |
| `idempotencyKey` | `dedupeKey` |
| `JobState.LEASED` | no such value (`PENDING RUNNING RETRYING SUCCEEDED DEAD CANCELLED`) |
| `"Mailbox"` | `"EmailAccount"` |
| `Lead.importBatchId` | not present |

`06` already self-corrected against the schema; `09` had not. Corrected in place, because a
copy-pasteable query that errors is worse than no query.

---

## D5 — `z.string().uuid()` on cuid ids is a real bug; `z.nativeEnum` is not

**Status:** decided.

`03-frontend.md` uses `z.string().uuid()` to validate ids in three places. Our ids are
**cuids**, and this was verified to fail, not merely to be untidy:

```
z.string().uuid().safeParse('clzq1a2b3c4d5e6f7g8h9i0j').success  →  false
```

Every affected route would reject every valid id. Real bug; must be `z.string()` with a
cuid check, or `z.cuid2()` where the format matches.

The same report claimed `z.nativeEnum` was "removed in zod 4" and would throw. **That is
wrong** — it still exists in zod 4.5.4 (`typeof z.nativeEnum === 'function'`) and works. It
is deprecated in favour of `z.enum`, which is a style preference, not a runtime failure.
Recorded because a fabricated breakage is as costly to chase as a real one, and prefer
`z.enum` in new code regardless.
