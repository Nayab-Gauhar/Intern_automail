# Lead integration notes

Running list of fixes the lead applies when merging agent work. Each entry is a real defect
found by running tooling, not a style preference.

## 1. Prisma 7 removed BOTH `url` and `directUrl` from the schema (BREAKING)

`prisma validate` fails on each:

> The datasource property `url` is no longer supported in schema files. Move connection
> URLs for Migrate to `prisma.config.ts` and pass either `adapter` for a direct database
> connection or `accelerateUrl` to the `PrismaClient` constructor.

> The datasource property `directUrl` is no longer supported in schema files.

This is broader than it first appears. In Prisma 7 the `datasource` block carries
**`provider` only** — no connection URL at all. Connection handling splits in two:

| Consumer | Where the URL comes from |
|---|---|
| Migrate / introspection CLI | `datasource.url` in **`prisma.config.ts`** |
| `PrismaClient` at runtime | a **driver adapter** (`@prisma/adapter-pg`), not a URL |

**Fix applied:**
- `prisma.config.ts` at the repo root supplies `datasource.url` for CLI commands,
  preferring `DIRECT_DATABASE_URL` (migrations must not run through a transaction-mode
  pooler) and falling back to `DATABASE_URL`.
- `@prisma/adapter-pg@7.10.0` + `pg@8.23.0` are dependencies; `src/lib/db.ts` constructs
  `PrismaClient` with `new PrismaPg(...)`.
- `dotenv` is a **direct** devDependency because `prisma.config.ts` imports it; it was
  present only transitively, which would break on any dependency reshuffle.
- `next.config.ts` lists `@prisma/client`, `@prisma/adapter-pg`, and `pg` in
  `serverExternalPackages` so a stray client-side import fails at build rather than
  shipping a broken bundle.

**Schema owner must remove the `url` and `directUrl` lines** from the `datasource` block.
Any doc showing a URL in `schema.prisma` describes Prisma ≤6 and is wrong for this repo.

## 2. `@types/react-dom` does not track React's version

`@types/react-dom@19.2.8` does not exist even though `react-dom@19.2.8` does. The type
packages version independently: `@types/react@19.2.18`, `@types/react-dom@19.2.5`.

**Fix:** applied in `package.json`. Never assume a `@types/*` version mirrors its runtime
package.

## 3. Prisma CLI `latest` is a release candidate

See `10-dependency-pins.md`. Both `prisma` and `@prisma/client` are pinned to `7.10.0`.

## 4. `next lint` was removed in Next 16

Next 16's CLI no longer has a `lint` command (`next --help` lists build, dev, start, info,
typegen, upgrade… and no `lint`). A `"lint": "next lint"` script silently fails.

**Fix:** `"lint": "eslint ."` with a flat config in `eslint.config.mjs`.

## 5. TypeScript 7 breaks the whole lint toolchain

`typescript-eslint@8.68.0` hard-refuses TS 7:

> typescript-eslint does not support TS 7.0.

TS 7 is the native (Go) port; the lint ecosystem targets the TS 6 API. Its peer range is
`typescript: >=4.8.4 <6.1.0`. Since `eslint-config-next` depends on `typescript-eslint`,
TS 7 makes linting impossible, not merely degraded.

**Fix:** pinned **TypeScript 6.0.3** — the newest stable version the lint ecosystem
supports. Revisit when typescript-eslint ships TS 7 support
(typescript-eslint issue #10940).

## 6. ESLint 10 breaks typescript-eslint at runtime

With ESLint 10.9.1, every lint run throws:

> TypeError: scopeManager.addGlobals is not a function

The plugins declare `eslint: ^8.57.0 || ^9.0.0 || ^10.0.0` as a peer, but at least one
still calls ESLint 9's scope-manager API. **A declared peer range is not evidence that a
combination works** — only running it is.

**Fix:** pinned **ESLint 9.39.5**. Verified `eslint .` exits 0.

## 7. `eslint-config-next` already registers `jsx-a11y`

Adding `eslint-plugin-jsx-a11y`'s recommended config alongside `eslint-config-next` fails
config loading outright:

> ConfigError: Key "plugins": Cannot redefine plugin "jsx-a11y".

`eslint-config-next` bundles `@next/next`, `react`, `react-hooks`, `import`, **and**
`jsx-a11y`. Do not re-register any of them.

**Fix:** rely on `...next` for jsx-a11y; layer only rule overrides on top.

## Verified toolchain (all commands exit 0)

| Tool | Pin | Status |
|---|---|---|
| Bun | 1.4.0 | installs 276 packages clean |
| Next | 16.3.3 | CLI operational |
| TypeScript | **6.0.3** | downgraded from 7.0.2 for lint support |
| ESLint | **9.39.5** | downgraded from 10.9.1; `eslint .` exits 0 |
| Prisma | 7.10.0 | CLI + client matched |

`bunx tsc --noEmit` currently exits 2 with `TS18003: No inputs were found` — expected
while no `.ts` files exist; it resolves as soon as source lands.

## 8. Prisma 7 CLI flag changes (found by running them)

| Prisma ≤6 | Prisma 7 | Symptom if you use the old form |
|---|---|---|
| `db push --skip-generate` | flag removed | CLI prints help and exits 0 — **a silent no-op** |
| `migrate diff --to-schema-datamodel <p>` | `--to-schema <p>` | prints help, writes an empty script |

The `--skip-generate` case is the dangerous one: the command appears to succeed while doing
nothing. Any script using it needs updating.

## 9. `prisma db push` refuses to run for an AI agent

Prisma 7 ships an agent guardrail. `db push --accept-data-loss` returns a block explaining
that the action irreversibly destroys all data and requires explicit user consent via
`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`.

This is a good default and we work with it rather than around it. To verify a schema
**non-destructively**, generate the DDL and apply it to a throwaway database:

```bash
# read-only: touches no database
bunx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > /tmp/schema.sql

# apply to a brand-new empty database, so there is nothing to lose
createdb ddl_probe && psql -d ddl_probe -v ON_ERROR_STOP=1 -f /tmp/schema.sql
```

Never pass the consent variable on the user's behalf, and never point a destructive command
at `instantmail` (the dev database with real local state).

## 10. Schema verified against live PostgreSQL 16 ✅

The generated DDL was applied to a scratch database with `ON_ERROR_STOP=1` and succeeded:

| Object | Count |
|---|---|
| Tables | 42 |
| Enums | 35 |
| Indexes | 222 |
| Foreign keys | 123 |

Tenancy audit: of 42 models, **only 4 lack `workspaceId`** — `User`, `Session`,
`PasswordResetToken` (identity-scoped, not tenant-owned) and `Workspace` (the tenant root).
Every tenant-owned model is scoped. All **123** FK-owning relations declare an explicit
`onDelete` (81 `Cascade`, 42 `SetNull`), so no deletion behaviour is left to chance.
(123, not 134: `grep -c '@relation'` counts *both* sides of every relation, while only
the side carrying `fields:`/`references:` owns a foreign key. The generated DDL contains
exactly 123 `FOREIGN KEY` clauses, and 81 + 42 = 123.)

The product invariants are enforced **by the database**, not merely by application code:

```
ScheduledEmail_campaignLeadId_sequenceStepId_key   one email per lead per step
ScheduledEmail_dedupeKey_key                       survives worker crash / retry
EmailEvent_dedupeKey_key                            webhook redelivery cannot double-count
CampaignLead_campaignId_leadId_key                  no duplicate enrollment
Job_state_runAt_priority_idx                        queue lease path
Job_state_leaseExpiresAt_idx                        dead-worker job reclamation
```

## 11. ⚠️ `prisma migrate diff` proposes DROPPING our hand-written indexes

**Read this before committing any generated migration.**

`prisma/migrations/20260830212002_init/migration.sql` ends with a hand-written block of eight
objects Prisma's schema language cannot express: two partial indexes on the hottest paths
(`Job_leasable_idx`, `ScheduledEmail_due_idx`), three partial/plain uniques enforcing business
rules, two GIN indexes, and the `EmailEvent` append-only trigger.

Prisma computes a diff from `schema.prisma` alone. It cannot see those objects, so it treats
them as foreign and emits `DROP INDEX` for them. Generating the `RateLimit` migration produced:

```sql
-- DropIndex
DROP INDEX "EmailMessage_references_gin";
DROP INDEX "EmailThread_participants_gin";
DROP INDEX "WarmupPoolMember_emailAccount_unique";
-- CreateTable ... (the change actually wanted)
```

Committing that unnoticed would have silently deleted a uniqueness guarantee and two indexes
that exist to avoid sequential scans — with no error, just a slow, subtly wrong system.

**Every future `migrate diff` will propose the same deletions.** The workflow is therefore:

1. Generate into a file, never straight into a commit.
2. Read the SQL. Strip any `DROP` touching an object from the init migration's hand-written
   block.
3. Apply with `migrate deploy`, then verify the objects still exist:

```sql
SELECT indexname FROM pg_indexes WHERE indexname IN (
  'Job_leasable_idx', 'ScheduledEmail_due_idx', 'WorkspaceInvite_pending_unique',
  'Experiment_live_per_step_unique', 'EmailMessage_references_gin',
  'EmailThread_participants_gin', 'WarmupPoolMember_emailAccount_unique');
SELECT tgname FROM pg_trigger WHERE tgname = 'EmailEvent_no_update';
```

All eight must be present. This check belongs in CI before it bites someone.

### Two smaller findings from the same exercise

- **`migration_lock.toml` was missing.** Prisma writes it when `migrate dev` scaffolds a
  migration; the init directory was hand-created, so it never appeared, and
  `migrate diff --from-migrations` failed with *"Could not determine the connector from the
  migrations directory"*. Now committed with `provider = "postgresql"`.
- **`--from-migrations` requires a shadow database.** Prisma replays migrations into a
  throwaway database to compute the diff. `prisma.config.ts` now reads
  `SHADOW_DATABASE_URL` (`instantmail_shadow` locally). Prisma **resets** it on every use, so
  it must never point at anything real.
