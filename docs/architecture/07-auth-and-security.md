# Authentication, Authorization & Security

> **Scope.** Login identity, sessions, the role model, workspace isolation,
> credential encryption, input validation, rate limiting, CSRF, OAuth, webhook
> verification, audit logging, transport headers, and the threat model.
>
> **Status.** Elaborates brief §4 (multi-tenancy) and §6 (security baselines). It
> does not restate them; it makes them executable. Where this document and the
> brief disagree, the brief wins and this document is the bug.
>
> **Companion docs.** `06-jobs-and-sending-engine.md` owns per-mailbox send
> pacing and provider error classification. `09-deployment-and-testing.md` owns
> env validation, secret storage, and key rotation *procedure*. This document
> owns the crypto module's shape and every request-path control.

---

## 1. The security posture in one page

We are a multi-tenant platform that holds, for every customer:

- **OAuth refresh tokens for real mailboxes.** Stolen, they are read/write
  access to a company's email. This is the crown jewel, and it is why
  `EmailAccount.encryptedRefreshToken` is the most sensitive column in the
  schema.
- **Lead lists** — the customer's commercial asset, and personal data of third
  parties who never signed up with us. GDPR applies to them, not to our user.
- **Inbound email bodies** — attacker-controlled text that our AI reads.
- **The ability to send mail from a customer's domain.** Abused, we burn their
  domain reputation, and ours.

Four consequences shape everything below:

1. **A session leak must not be a credential leak.** Sessions are opaque random
   tokens stored hashed; mailbox credentials are separately encrypted. A dump of
   `Session` replays nothing; a dump of `EmailAccount` decrypts nothing without
   `ENCRYPTION_KEY`.
2. **Authorization lives in service functions, not in the UI and not in
   middleware.** Every other layer is convenience.
3. **Tenant isolation is a property of the repo layer**, mechanically tested, not
   a habit.
4. **Inbound content is data.** It is never an instruction, never HTML we inject
   into our own DOM, and never a source of a workspace id.

### 1.1 The three enforcement layers, and what each is worth

```
┌──────────────────────────────────────────────────────────────────────────┐
│ LAYER 1 · middleware.ts            NOT A SECURITY BOUNDARY              │
│   · attaches per-request CSP nonce + security headers                    │
│   · attaches x-request-id                                                │
│   · cheap redirect when the session cookie is absent   (UX only)         │
│   · NO database access, NO token validation, NO role check               │
├──────────────────────────────────────────────────────────────────────────┤
│ LAYER 2 · layout / page / route handler          GATE, not the decision  │
│   · requireSession()   → redirect('/login?next=…')                       │
│   · requireWorkspace() → resolves Ctx from the session, server-side      │
│   · decides what to RENDER; hides what the user cannot do                │
├──────────────────────────────────────────────────────────────────────────┤
│ LAYER 3 · modules/<d>/service.ts + repo.ts       THE ACTUAL DECISION     │
│   · every entrypoint takes Ctx as its first parameter                    │
│   · requireCan(ctx, capability) before any mutation                      │
│   · every repo query filters/sets workspaceId FROM Ctx                   │
│   · a foreign id yields NotFound, never Forbidden                        │
└──────────────────────────────────────────────────────────────────────────┘
```

The load-bearing rule: **layer 3 assumes nothing about layers 1 and 2.** A
service function called from a script, a test, the worker, or a future public
API behaves identically. If deleting `middleware.ts` and every layout guard
would expose data, the design is wrong.

---

## 2. Files this document specifies

```
src/lib/
  crypto.ts              # AES-256-GCM envelope + SHA-256 helpers      (server-only)
  password.ts            # argon2id hash/verify/rehash + entropy policy (server-only)
  tokens.ts              # opaque token mint + hash + timing-safe compare
  rate-limit.ts          # Postgres fixed-window limiter
  errors.ts              # AppError hierarchy incl. Unauthorized/Forbidden/NotFound
src/server/
  session.ts             # getSession / requireSession / cookie mechanics (server-only)
  ctx.ts                 # requireWorkspace / Ctx derivation / workspace switch
  authz.ts               # Capability type, MATRIX, can(), requireCan()
  origin.ts              # assertSameOrigin for route handlers
  action.ts              # the action() wrapper (auth → authz → zod → Result)
  audit.ts               # writeAudit()
src/modules/auth/
  index.ts service.ts repo.ts schema.ts types.ts
  mailer.ts              # Mailer port + Console/Noop adapters
src/modules/workspace/
  index.ts service.ts repo.ts schema.ts types.ts   # members, invites, roles
middleware.ts            # headers + CSP nonce + unauthenticated redirect only
```

`crypto.ts`, `password.ts`, `session.ts`, and `mailer.ts` all begin with
`import 'server-only'` (brief §3 rule 5), so a client component anywhere in
their import graph is a build error rather than a leak.

---

## 3. Identity model

```
User (global)  ──WorkspaceMember(role, status)──  Workspace (tenant)
  │
  └─ Session (opaque token hash, activeWorkspaceId)
```

Three decisions that follow from the schema and must not be relitigated:

- **`User` is global, not tenant data.** One person, one password, one session,
  N workspaces. `User.email` is `@unique` globally — one of only two legitimate
  global uniques (the other is `Workspace.slug`).
- **Role lives on `WorkspaceMember`, never on `User`.** Authorization reads
  `WorkspaceMember.role`. A user may be OWNER of one workspace and MEMBER of
  another in the same browser tab.
- **`Session.activeWorkspaceId` is a pointer, not an authorization.** It says
  which workspace the user is *looking at*. Whether they may is re-derived from
  `WorkspaceMember` on every request. A stale pointer is not access.

### 3.1 Registration

```
POST-equivalent server action  auth.register({ email, password, name })
   │
   ├─ 1. rate limit: register:ip → 3/hour, 10/day          (§13)
   ├─ 2. zod: email = z.email(), password = passwordSchema  (§4.2)
   ├─ 3. normalise: email.trim().toLowerCase()
   ├─ 4. hashPassword(password)                             ← ALWAYS, even if taken
   ├─ 5. tx: create User + Workspace + WorkspaceMember(OWNER)
   │        (a registration with no workspace is a dead end; we create one)
   ├─ 6. createSession(user) → set cookie
   ├─ 7. audit: auth.register.succeeded
   └─ 8. redirect /onboarding
```

Step 4 runs before the uniqueness check so a taken email and a free one cost the
same ~160 ms. The `User.email` unique violation (Postgres `23505`) is caught and
mapped to a typed `EmailTakenError`.

**Registration is enumerable in v1, deliberately, and this is the one place we
accept it.** The non-leaking design ("we've sent you an email either way")
requires a transactional mail provider we do not have (§7). Without one, hiding
the collision leaves the user staring at a screen that will never resolve — a
worse outcome than the disclosure. The paths that actually matter for credential
attacks — **login and password reset — do not leak** (§5.2, §7.1). Registration
is rate-limited hard so the disclosure cannot be harvested in bulk.

Revisit the moment `Mailer` has a real adapter: the flow becomes "create or
notify, respond identically," and this paragraph gets deleted.

**Workspace slug generation.** `slugify(name)`, and on collision append
`-` plus 4 random base32 chars, retrying up to 5 times. Never a sequential
suffix: `acme-2` tells an attacker `acme` exists and is a tenant-enumeration
oracle on a globally unique column.

---

## 4. Password policy

### 4.1 argon2id parameters

```ts
// src/lib/password.ts
import 'server-only'

/** Bun.password argon2id parameters. Bumping these is safe — §4.4 rehashes. */
export const ARGON2 = {
  algorithm: 'argon2id',
  memoryCost: 65_536,   // KiB → 64 MiB
  timeCost: 3,
} as const satisfies Parameters<typeof Bun.password.hash>[1]
```

Justification, measured on this machine (12 cores, Bun 1.4.0):

| Params | Measured hash time | Verdict |
|---|---|---|
| `m=19456, t=2` (OWASP floor) | **32 ms** | too cheap; we can afford 5× |
| `m=65536, t=3` | **158 ms** | **chosen** |
| Bun default (`m=65536, t=2`) | ~110 ms | fine, but pinning explicitly beats inheriting a default that can change under us |

64 MiB / t=3 sits at the OWASP "second recommended" configuration and lands near
the 150–250 ms band that is imperceptible on a login form while making offline
cracking expensive. Login is not a hot path — we do at most a handful per second
in the busiest plausible future.

**Two facts about `Bun.password` that the implementation must respect,
both verified rather than assumed:**

1. **`parallelism` is ignored.** Passing `parallelism: 4` still produces
   `$argon2id$v=19$m=65536,t=3,p=1$…`. Bun pins `p=1`. Do not add the option and
   do not assume lanes; the memory cost is the whole defence.
2. **`verify` throws on a non-argon2 string.** `Bun.password.verify(pw, 'x')`
   rejects in **0.21 ms** with `UnsupportedAlgorithm`. This is why the
   user-enumeration dummy in §5.2 must be a *real* PHC hash, not a placeholder
   string — a placeholder would make "no such user" 750× faster than "wrong
   password" and hand an attacker a perfect oracle.

**Memory-exhaustion guard.** 64 MiB per in-flight hash means 100 concurrent
login attempts is 6.4 GB of transient allocation — a trivially cheap DoS. Two
controls, both required:

```ts
// src/lib/password.ts — a 4-permit semaphore around every argon2 call.
// Bounds peak argon2 memory at 4 × 64 MiB = 256 MiB regardless of load.
const gate = new Semaphore(4)

export async function hashPassword(plaintext: string): Promise<string> {
  return gate.run(() => Bun.password.hash(plaintext, ARGON2))
}
export async function verifyPassword(plaintext: string, phc: string): Promise<boolean> {
  return gate.run(async () => {
    try { return await Bun.password.verify(plaintext, phc) }
    catch { return false }        // malformed/legacy hash → wrong, never a 500
  })
}
```

plus the login rate limits in §13. Queueing behind the semaphore is the correct
behaviour: a slow login under attack beats an OOM-killed process.

**Runtime dependency, stated plainly.** `Bun.password` exists only under the Bun
runtime. `09-deployment-and-testing.md` §7.2 runs the web service as
`bun .next/standalone/server.js`, so the global is present — verified. If a
future deploy ever runs the server under Node, **login breaks entirely**. Node
24 does expose `crypto.argon2`/`argon2Sync`, so a fallback is possible, but we do
not write one: an untested code path in the password verifier is worse than a
loud failure. Guard it at boot instead:

```ts
// src/lib/password.ts, module scope
if (typeof Bun === 'undefined') {
  throw new Error('auth requires the Bun runtime: Bun.password is unavailable')
}
```

### 4.2 Strength: entropy, not composition

```ts
// src/modules/auth/schema.ts
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200, 'Passwords longer than 200 characters are not accepted')
  .refine((p) => p.trim().length > 0, 'Cannot be only whitespace')
  .refine((p) => !isCommonPassword(p), 'This password appears in known breach lists')
  .superRefine(contextualRejects)   // see below
```

No uppercase/digit/symbol rules. Composition rules push users to `Password1!`,
which is 12 characters of nothing, and NIST SP 800-63B has recommended against
them for years. What we enforce instead:

| Rule | Why |
|---|---|
| **≥ 12 characters** | the single highest-signal predictor of entropy |
| **≤ 200 characters** | argon2 cost is length-independent, but an unbounded field is a memory footgun |
| **not in a common-password list** | catches `123456789012` and `qwertyuiop12`, which pass every length check |
| **does not contain the email local part, the workspace name, or "instantmail"** | context-specific guesses are the first thing an attacker tries |
| **max length is checked before hashing** | never hand argon2 a 10 MB string |

`isCommonPassword` is a `Set` built from a committed, gzipped list of the
**top 10,000** breached passwords (~60 KB gzipped), loaded lazily on first use.
Not an online breach API: that would send a password prefix to a third party on
every registration, and a network dependency in the registration path is a
liveness risk for a marginal gain.

**Rejected: `zxcvbn`.** ~800 KB of dictionaries for a score we would only
threshold anyway, and it is not on the approved-dependency list. The length +
breach-list + context check catches the same realistic failures at 60 KB.

`contextualRejects` needs the email, so `passwordSchema` is composed inside the
registration and reset schemas rather than used bare:

```ts
export const registerSchema = z
  .object({ email: z.email(), password: passwordSchema, name: z.string().trim().min(1).max(120) })
  .superRefine(({ email, password }, ctx) => {
    const local = email.split('@')[0]!.toLowerCase()
    if (local.length >= 3 && password.toLowerCase().includes(local)) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'Do not include your email address' })
    }
  })
```

Strength is also shown, never enforced beyond the above: a client-side meter
driven by length and breach-list membership only, so the meter and the server
agree. A meter that says "strong" for a password the server rejects is a bug.

### 4.3 What we do not build

No password expiry, no history table, no "cannot reuse your last 5". All three
are known to *reduce* real-world security by driving predictable increments, and
NIST removed the recommendation. Rotation happens on suspicion (§5.6), which is
the case that matters.

### 4.4 Rehash on login when parameters change

`Bun.password.verify` reads the parameters out of the stored PHC string — a hash
written with `m=19456,t=2` still verifies after we raise the cost (verified).
That makes an upgrade a one-liner at the only moment we hold the plaintext:

```ts
// src/lib/password.ts
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/

/** True when `phc` was written with weaker parameters than ARGON2, or is not argon2id at all. */
export function needsRehash(phc: string): boolean {
  const m = PHC.exec(phc)
  if (!m) return true                                  // bcrypt or anything else → upgrade
  return Number(m[1]) < ARGON2.memoryCost || Number(m[2]) < ARGON2.timeCost
}
```

```ts
// src/modules/auth/service.ts, inside login, AFTER a successful verify
if (needsRehash(user.passwordHash)) {
  await repo.updatePasswordHash(user.id, await hashPassword(input.password))
  log.info({ event: 'auth.password.rehashed', userId: user.id })
}
```

Never on a failed verify. Never outside the login path — there is nowhere else
we legitimately hold a plaintext password. Raising `ARGON2` is therefore a
one-line change that migrates the whole user base on natural login traffic, with
no migration job.

`Bun.password.verify` also accepts bcrypt (`$2b$…`, verified), so `needsRehash`
returning `true` for it gives us a free import path if we ever absorb another
system's users. We have none today.

---

## 5. Sessions

### 5.1 The cookie and the token

```ts
// src/server/session.ts
import 'server-only'

export const SESSION_COOKIE =
  env.NODE_ENV === 'production' ? '__Host-im_session' : 'im_session'

const IDLE_TTL_MS      = 14 * 24 * 60 * 60 * 1000   // 14d sliding
const ABSOLUTE_TTL_MS  = 90 * 24 * 60 * 60 * 1000   // 90d hard ceiling
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000        // extend at most once a day
```

| Attribute | Value | Reason |
|---|---|---|
| name | `__Host-im_session` in prod, `im_session` in dev | the `__Host-` prefix is browser-enforced: the cookie is *rejected* unless `Secure`, `Path=/`, and **no `Domain`** — so a subdomain-injected cookie cannot overwrite it. Dev runs on `http://localhost`, where `Secure` is not settable, so the prefix must be dropped there or local login silently fails. |
| `httpOnly` | `true` | XSS cannot read it |
| `sameSite` | `Lax` | blocks cross-site form POSTs while surviving the top-level GET redirect back from Google OAuth. `Strict` breaks that redirect and every emailed deep link. |
| `secure` | `env.NODE_ENV === 'production'` | forced by `__Host-` anyway; explicit so the dev/prod difference is one expression |
| `maxAge` | `IDLE_TTL_MS / 1000` | re-sent on each sliding refresh |
| `path` | `/` | required by `__Host-` |
| `domain` | **never set** | required by `__Host-`; also keeps the cookie off any future marketing subdomain |

```ts
// src/lib/tokens.ts — pure; no server-only marker because tests use the hash half

/** 256 bits of CSPRNG entropy, base64url: 43 chars, no padding, cookie-safe. */
export function mintToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
}

/** The ONLY form that ever touches the database. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')   // 64 hex chars
}

/** Constant-time compare for equal-length ASCII digests. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false     // length is not the secret here
  return timingSafeEqual(ab, bb)
}
```

**Plain SHA-256, not argon2, and not HMAC.** The token is 256 bits of uniform
CSPRNG output, so there is no dictionary to attack — a slow KDF buys nothing and
would add 150 ms to *every authenticated request*. An HMAC keyed by `AUTH_SECRET`
would tie session validity to a secret whose rotation `09-deployment-and-testing.md`
§4.3 explicitly promises will not log anyone out. SHA-256 keeps that promise.

**Lookup is a unique-index probe, so there is no compare loop.**
`Session.tokenHash` is `@unique`; we fetch the row directly. That leaks nothing —
the hash is derived from the attacker's own input, so there is no stored secret to
time against. `timingSafeEqualStr` exists for `WORKER_AUTH_TOKEN` and the Pub/Sub
verification token (§14), where we genuinely do compare against a stored secret.

### 5.2 Login

```
auth.login({ email, password })
   │
   ├─ 1. rate limit: login:ip → 10/15min  AND  login:email → 5/15min   (§13)
   ├─ 2. zod: { email: z.email(), password: z.string().min(1).max(200) }
   ├─ 3. user = repo.findByEmail(lower(email))        // deletedAt IS NULL
   ├─ 4. if (user?.lockedUntil > now) → InvalidCredentials (SAME shape as wrong pw)
   ├─ 5. ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH)
   │        ▲ always exactly one real argon2id verify, present user or not
   ├─ 6. if (!ok) → bumpFailedLogin(user?.id); audit; InvalidCredentials
   ├─ 7. if (needsRehash(user.passwordHash)) → rehash                  (§4.4)
   ├─ 8. tx: reset failedLoginCount + lockedUntil, set lastLoginAt,
   │         insert Session, resolve activeWorkspaceId
   ├─ 9. set cookie; audit auth.login.succeeded
   └─ 10. redirect safeNext(next) ?? /dashboard                        (§5.9)
```

**User-enumeration resistance — the three things that leak, and how each closes:**

```ts
// src/modules/auth/service.ts, module scope.
// A real argon2id hash of a random 32-byte string, computed ONCE at boot with the
// CURRENT ARGON2 params. Its plaintext is unknowable, so verify always returns
// false — after doing the same ~158 ms of work as a real verify.
// It MUST be a valid PHC string: Bun.password.verify THROWS in 0.21 ms on a
// placeholder, which would make "no such user" ~750x faster and hand an attacker
// a perfect oracle.
const DUMMY_HASH = await hashPassword(mintToken())
```

| Leak vector | Closed by |
|---|---|
| **Timing** — an unknown email skips the hash | verify against `DUMMY_HASH` when `user` is null *or* when `user.passwordHash` is null (an invited-but-not-yet-accepted row) |
| **Response body** — "no such account" vs "wrong password" | one `InvalidCredentialsError`, one message: *"Email or password is incorrect."* Never a field-level error on `email`. |
| **Response shape/status** — a 404 vs a 401 | one code path, one `Result` error variant. The form renders it above the fieldset, not attached to a field. |

The same discipline covers lockout: a locked account returns
`InvalidCredentials`, not "account locked". Telling an attacker they successfully
locked someone out confirms the account exists *and* invites them to keep doing
it.

**Lockout uses the schema's own columns** — `User.failedLoginCount` and
`User.lockedUntil` exist for exactly this:

```ts
const LOCK_THRESHOLD   = 10                 // consecutive failures
const LOCK_DURATION_MS = 15 * 60 * 1000     // then the counter keeps climbing
// Reset to 0 on any successful login AND on a completed password reset.
```

Lockout backs the rate limiter up rather than replacing it. The limiter is keyed
on IP and stops the broad sweep; the lock is keyed on the account and stops a
distributed low-and-slow attack on one high-value user. The tradeoff, stated
plainly: **a per-account lock is a DoS vector against a known user.** 15 minutes
with automatic expiry and no admin-unlock ceremony is the compromise — long
enough to defeat guessing, short enough that being locked out is an annoyance
rather than a support ticket.

**`activeWorkspaceId` at login** = the most recently used workspace if that
membership is still `ACTIVE`, else the oldest `ACTIVE` membership, else `null`
(which sends the user to `/onboarding`). `Session.activeWorkspaceId` is nullable
in the schema precisely for the third case.

### 5.3 Session creation and validation

```ts
// src/server/session.ts

export type SessionRecord = {
  id: string
  userId: string
  activeWorkspaceId: string | null
  expiresAt: Date
  absoluteExpiresAt: Date
}

/** Mints the token, stores only its hash, sets the cookie. Returns nothing:
 *  the plaintext token must not escape this function. */
export async function createSession(
  userId: string,
  meta: { ipAddress?: string; userAgent?: string; activeWorkspaceId?: string | null },
): Promise<void>

/** Reads the cookie, validates, slides expiry. `null` when absent/invalid/
 *  expired/revoked. Wrapped in React `cache()` so N server components in one
 *  render cost one query. */
export const getSession: () => Promise<SessionRecord | null>

/** getSession() or redirect(`/login?next=<current path>`). */
export async function requireSession(): Promise<SessionRecord>

export async function destroyCurrentSession(): Promise<void>
export async function revokeSession(userId: string, sessionId: string): Promise<void>
export async function revokeAllSessions(userId: string, opts?: { except?: string }): Promise<number>
```

The validation query, written as SQL because the ordering of the predicates *is*
the design:

```sql
-- revokedAt is checked BEFORE expiresAt: a revoked-but-unexpired session must be
-- dead immediately, which is the entire reason sessions live server-side.
SELECT s.id, s."userId", s."activeWorkspaceId", s."expiresAt", s."absoluteExpiresAt"
FROM "Session" s
JOIN "User" u ON u.id = s."userId"
WHERE s."tokenHash"         = $1
  AND s."revokedAt"         IS NULL
  AND s."expiresAt"         > now()
  AND s."absoluteExpiresAt" > now()
  AND u."deletedAt"         IS NULL;
```

`tokenHash` is `@unique`, so this is an index probe. The `User` join is not
decoration: it makes a soft-deleted user's live sessions inert with no sweeper.

On a miss we **delete the cookie** as well as returning `null`. Otherwise a user
whose session expired carries a dead cookie that re-triggers the database probe
on every request, forever.

### 5.4 Sliding refresh and the absolute cap

```
createdAt ────────────────────────────────────────────────▶ absoluteExpiresAt
          │                                                 (createdAt + 90d,
          │  activity extends expiresAt, at most once/24h     NEVER extended)
          ▼
    expiresAt = min(now + 14d, absoluteExpiresAt)
```

```ts
// inside getSession(), after a successful lookup
const slid = new Date(Math.min(Date.now() + IDLE_TTL_MS, row.absoluteExpiresAt.getTime()))
if (slid.getTime() - row.expiresAt.getTime() > REFRESH_AFTER_MS) {
  await repo.touchSession(row.id, slid)   // UPDATE expiresAt, lastActiveAt
  setSessionCookie(token, slid)           // re-send Set-Cookie with the new maxAge
}
```

Three deliberate properties:

- **`expiresAt` is clamped to `absoluteExpiresAt`.** Without the clamp, sliding
  eventually pushes idle expiry past the hard ceiling and the ceiling becomes
  decorative.
- **At most one write per session per 24 h.** A naive touch-on-every-request
  turns a read-only page render into a write and makes `Session` the hottest
  table in the database. `REFRESH_AFTER_MS` bounds it.
- **The token does not rotate on refresh.** Rotating per request makes two
  concurrent requests race, and one of them gets logged out — a real bug in real
  apps with link prefetching. Rotation happens only at the moments that warrant
  it (§5.6).

Absolute expiry lands mid-session with no warning. That is the point: a stolen
cookie has a hard shelf life. The user re-authenticates and returns to where they
were via `?next=`.

### 5.5 Logout

```ts
export async function destroyCurrentSession(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (token) await repo.revokeByTokenHash(hashToken(token))   // sets revokedAt = now()
  jar.delete(SESSION_COOKIE)
}
```

`revokedAt`, not `DELETE`. The row stays forensically useful for a few days —
"was this session active when that mailbox was disconnected?" — and `MAINTENANCE`
prunes rows with `revokedAt < now() - 30 days` or `absoluteExpiresAt < now()`.

Logout is a **server action / POST**, never a link. A `GET /logout` is CSRF-able
(annoying rather than dangerous) and gets fired by link prefetchers, email
scanners, and chat unfurlers.

### 5.6 When sessions are revoked

| Trigger | Action | Rationale |
|---|---|---|
| Explicit logout | revoke that one session | |
| **Password change** | `revokeAllSessions(userId, { except: currentSessionId })` | brief §6. The point of changing a password is evicting whoever knew the old one. Keeping the current session avoids logging the user out of the tab they are in. |
| **Password reset completed** | `revokeAllSessions(userId)` — **no exception** | the person holding the old sessions may not be the user; that is the whole scenario. Force a fresh login. |
| Email address changed | revoke all except current | the address is the login handle |
| User soft-deleted (`deletedAt`) | `revokeAllSessions` + the `User` join in §5.3 | belt and braces |
| Member removed from a workspace | **no revocation** | the session is still a valid *identity*; they lose that workspace only. `requireWorkspace()` re-checks membership per request (§9.2), so access ends on the next navigation. |
| Role downgraded | **no revocation** | same reasoning — role is read from `WorkspaceMember` per request and never cached in the session row. |
| "Sign out everywhere" in `/settings/security` | `revokeAllSessions(userId)` | |

The last two rows are the payoff for never denormalising role or membership into
the session: privilege changes take effect on the next request, with no
revocation machinery and no cache to invalidate.

### 5.7 The active-sessions UI

`/settings/security` lists the caller's own sessions via
`auth.listSessions(ctx)`:

```ts
export type SessionSummary = {
  id: string
  createdAt: Date
  lastActiveAt: Date
  isCurrent: boolean
  device: string           // coarse UA parse: "Chrome on macOS"
  ipMasked: string         // "203.0.113.x" / "2001:db8::" — never the full address
}
```

`tokenHash` is never selected into a domain type, so it cannot reach a client
component. IPs are **masked** in the UI: a full-precision IP history is a
stalking aid if the account is already compromised, and the last octet adds
nothing to the legitimate "was that me?" question. The full `Session.ipAddress`
stays in the database for incident response.

### 5.8 Change password

```ts
// Requires the current password even though the caller is authenticated: this is
// the control that stops a stolen session from locking the owner out.
changePassword(ctx, { currentPassword, newPassword })
  → verifyPassword(currentPassword, user.passwordHash)   || InvalidCredentials
  → newPassword !== currentPassword                      || SamePasswordError
  → tx: updatePasswordHash + revokeAllSessions(userId, { except: ctx.sessionId })
  → audit: auth.password.changed
```

Rate limited at `password_change:user → 5/hour`.

### 5.9 `?next=` redirect validation

An unvalidated `next` is an open redirect and a phishing primitive.

```ts
// src/server/session.ts
const CONTROL_CHARS = /[\x00-\x1f\x7f]/      // CR/LF/NUL header-splitting tricks

export function safeNext(next: string | null): string {
  if (!next) return '/dashboard'
  // Allowlist by SHAPE. Reject anything that could resolve off-origin: absolute
  // URLs, protocol-relative "//evil.com", backslash tricks, control characters.
  if (!next.startsWith('/')) return '/dashboard'
  if (next.startsWith('//')) return '/dashboard'
  if (next.includes('\\')) return '/dashboard'
  if (CONTROL_CHARS.test(next)) return '/dashboard'
  return next
}
```

Allowlist by shape, never a blocklist of hostnames. Applied at every redirect
that reads `next`: `/login`, `/register`, `/accept-invite`.

---

## 6. The single-use token pattern

Password reset, email verification, and workspace invites are the same problem
three times. One pattern, applied identically, so a reviewer checks it once:

```
1. MINT     token = mintToken()                    // 256 bits, §5.1
2. STORE    tokenHash = sha256(token), expiresAt, usedAt = NULL
3. DELIVER  the PLAINTEXT token, once, in a URL — never persisted anywhere
4. CONSUME  UPDATE … SET usedAt = now()
            WHERE tokenHash = $1 AND usedAt IS NULL AND expiresAt > now()
            ▲ single statement; rowCount = 1 means we won, 0 means invalid/used/expired
5. ACT      only if rowCount = 1
```

**Step 4 is one atomic UPDATE, not a SELECT-then-UPDATE.** The read-then-write
shape lets two concurrent requests with the same token both pass the check. The
conditional UPDATE makes the database the arbiter, and `rowCount` the answer.

```ts
// src/modules/auth/repo.ts
/** Atomically consumes the token. Returns the userId on success, null otherwise. */
export async function consumePasswordResetToken(tokenHash: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ userId: string }[]>`
    UPDATE "PasswordResetToken"
       SET "usedAt" = now()
     WHERE "tokenHash" = ${tokenHash}
       AND "usedAt"    IS NULL
       AND "expiresAt" > now()
    RETURNING "userId"`
  return rows[0]?.userId ?? null
}
```

TTLs, and why each is what it is:

| Token | Model | TTL | Reason |
|---|---|---|---|
| Password reset | `PasswordResetToken` | **1 hour** | delivered by email; long enough to survive a slow inbox, short enough that a mailbox compromised next week is not an account takeover |
| Email verification | *(no model — see §6.1)* | 24 hours | not a credential; a longer window is a usability win with little downside |
| Workspace invite | `WorkspaceInvite` | **7 days** | a human has to notice, ask a colleague, and act. Anything shorter generates support load. |
| OAuth `state` | *(no model — signed, §15)* | 10 minutes | one browser round-trip |

### 6.1 Email verification — SCHEMA GAP

`User.emailVerifiedAt` exists, but **there is no model to hold a verification
token.** `PasswordResetToken` must not be reused for this: a token that can both
verify an address and set a password is a privilege-escalation waiting to happen
the first time someone forwards a verification email.

Two options for the lead:

- **A) Add a model** (preferred — symmetric with `PasswordResetToken`, and it is
  the same 10 lines):

```prisma
/// Single-use email-verification token. Hash-at-rest, same reasoning as Session.
model EmailVerificationToken {
  id        String    @id @default(cuid())
  tokenHash String    @unique
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// The address being verified. Stored because a pending email CHANGE must not
  /// mutate User.email until the new address is proven reachable.
  email     String
  expiresAt DateTime  @db.Timestamptz(6)
  usedAt    DateTime? @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @db.Timestamptz(6)

  @@index([userId])
  @@index([expiresAt])
}
```

- **B) Defer verification entirely** until a `Mailer` adapter exists, leaving
  `emailVerifiedAt` null for everyone.

**Recommendation: B for phase 1, A when the mailer lands.** Verification with no
delivery channel is theatre. What matters is that **nothing gates on
`emailVerifiedAt` in v1** — no login check, no send check. The moment it gates
anything without a working mailer, every user is locked out.

The one thing that must be built now, because retrofitting it is a breaking
change: **a pending email change never writes `User.email` directly.** It writes
a verification row carrying the new address and swaps `User.email` only on
consumption. Otherwise a typo'd address is an unrecoverable lockout.

---

## 7. Password reset

```
                    ┌─────────────────────────────────────────────────┐
POST /forgot-password│ rate limit: reset:ip 5/h ‖ reset:email 3/h     │
                    │ zod: { email: z.email() }                       │
                    │ user = findByEmail(lower(email))                │
                    │   ├─ found    → invalidate prior live tokens,   │
                    │   │             mint + store, mailer.send()     │
                    │   └─ NOT found→ do nothing                      │
                    │ ALWAYS: same 200, same copy, same latency       │
                    └─────────────────────────────────────────────────┘
                                        │
GET /reset-password?token=…  → renders the form. Does NOT consume the token, and
                               does NOT confirm validity: an email scanner
                               prefetching the link must not burn it.
                                        │
POST (server action)         → consumePasswordResetToken(sha256(token))
                               │  null → "This link is invalid or has expired."
                               └─ userId → tx:
                                     updatePasswordHash(hashPassword(new))
                                     failedLoginCount = 0, lockedUntil = NULL
                                     revokeAllSessions(userId)      ← ALL, §5.6
                                     emailVerifiedAt ??= now()       ← see below
                                     invalidate that user's other reset tokens
                                  audit auth.password.reset
                                  → /login?reset=1 (do NOT auto-login)
```

**"Do not leak account existence" in practice** means three things must match on
both branches, not just the status code:

1. **Same body.** *"If an account exists for that address, we have sent a reset
   link."* Note the phrasing — it is honest and it reveals nothing.
2. **Same latency.** The found branch mints a token, writes a row, and calls the
   mailer. The not-found branch does none of that and returns in ~2 ms. That
   difference is measurable. Fix: the mail send is **not awaited inline** on
   either branch — the found branch enqueues delivery and returns, so both
   branches do at most one indexed lookup plus one small write.
3. **Same behaviour under repetition.** Both branches consume rate-limit budget.
   If only the found branch did, an attacker would enumerate by watching for the
   429.

**Reset does not auto-login.** Redirect to `/login` with a success notice. Auto-
login turns a leaked reset link into a session, and gives the attacker no
password to have known.

**Reset sets `emailVerifiedAt` if it is null.** Completing a reset proves control
of the mailbox, which is exactly what verification proves. Not doing so would
leave a user permanently unverified while demonstrably owning the address.

**Password reset invalidates all sessions with no exception**, unlike a password
*change* (§5.6). The person clicking reset may be recovering from a compromise;
keeping any session alive defeats the purpose.

### 7.1 No transactional email provider yet — how we ship this without a hole

There is no mail provider in the env schema, and Gmail mailboxes belong to
*customers* — sending our own transactional mail through a customer's connected
mailbox would be a serious abuse of that OAuth grant. So `Mailer` is a port with
two adapters and nothing else:

```ts
// src/modules/auth/mailer.ts
import 'server-only'

export type SystemEmail =
  | { kind: 'password_reset';     to: string; resetUrl: string }
  | { kind: 'email_verification'; to: string; verifyUrl: string }
  | { kind: 'workspace_invite';   to: string; inviteUrl: string; workspaceName: string; inviterName: string }

export interface Mailer {
  send(msg: SystemEmail): Promise<void>
}
```

| Adapter | When | Behaviour |
|---|---|---|
| `ConsoleMailer` | `NODE_ENV !== 'production'` | logs the URL at `warn` with `event: 'mailer.dev_delivery'`. The link is in the dev server's terminal. |
| `NoopMailer` | production, no provider configured | logs `event: 'mailer.dropped'` at **error** and returns. Does not throw: the flow's security properties must not depend on delivery. |

The four rules that keep this from being a security hole:

1. **The token never appears in an HTTP response.** Not in the JSON, not in a
   header, not in a `<script>` payload, not in dev. Dev surfacing is
   **server-stdout only** — a developer reads their own terminal. The moment a
   token is in a response body, someone builds a client that reads it, and the
   reset flow is bypassable in production.
2. **`ConsoleMailer` cannot be selected in production.** Selection is
   `env.NODE_ENV === 'production' ? new NoopMailer() : new ConsoleMailer()` — no
   env flag, so there is no variable to set wrong.
3. **The flow is identical in both adapters.** The token is still hashed,
   single-use, TTL'd, and atomically consumed. The only difference is where the
   URL is written. When a real adapter lands, only the class changes.
4. **`NoopMailer` logs at `error`** so a production deploy with an unresolved
   mailer is loud in the dashboards rather than silently swallowing every reset.

Phase-1 recovery path while `NoopMailer` is live: an operator reads the URL from
the audit log's correlation id and the `mailer.dropped` line, or resets the hash
directly via a documented `bun run scripts/…` script. Written down in the runbook,
not in the UI.

---

## 8. Invitations

`WorkspaceInvite` already carries `tokenHash`, `email`, `role`, `status`,
`expiresAt`, `acceptedAt`, `revokedAt`, and `invitedById`.

```
workspace.invite(ctx, { email, role })          requires: invite_member (§9)
   ├─ rate limit: invite:workspace → 20/hour, 100/day
   ├─ role must not exceed the inviter's own (§9.4): an ADMIN cannot mint an OWNER
   ├─ already an ACTIVE member with that email → AlreadyMemberError (not an invite)
   ├─ existing PENDING invite → REVOKE it, then create a new one
   │     (the partial unique index `WHERE status = 'PENDING'` makes this mandatory)
   └─ audit member.invited { email, role }

GET /accept-invite/[token]
   ├─ look up by sha256(token); PENDING, not expired, not revoked
   ├─ render workspace name + role. Reveals nothing but the invite's own contents.
   └─ two paths:
        · signed in as the invited email  → "Join <workspace>" button
        · signed in as SOMEONE ELSE       → explicit warning + "sign out and accept"
                                            NEVER auto-switch identity
        · not signed in, user exists      → /login?next=/accept-invite/<token>
        · not signed in, user does not     → set-password form (creates the User)

POST accept  → tx:
        consume the invite atomically (§6 pattern, on status = PENDING)
        upsert WorkspaceMember(workspaceId, userId, role, ACTIVE)
        if the user was created here: emailVerifiedAt = now()   ← the invite proved it
        set Session.activeWorkspaceId = workspaceId
        audit auth.invite.accepted
```

Four rules that are easy to get wrong:

- **The invite binds to an email, and the accepting user's email must match.**
  Otherwise a forwarded invite grants access to whoever opens it. Compared
  lowercased. A mismatch is a clear error, not a silent join.
- **The token is the only capability, so it must not be guessable or reusable.**
  256 bits, hashed at rest, consumed atomically.
- **Accepting an invite is the one place a `workspaceId` legitimately comes from
  outside the session** — but it comes from the *server-side row*, keyed by a
  hashed unguessable token, never from a request parameter. That is what keeps it
  consistent with brief §4 rule 2.
- **`InviteStatus.EXPIRED` is set by `MAINTENANCE`, not by the read path.** The
  accept path checks `expiresAt > now()` regardless of `status`, so a not-yet-
  swept row cannot be accepted late.

Revoking an invite (`status = REVOKED`) is immediate and requires the same
`invite_member` capability.

---

## 9. Authorization

### 9.1 `Ctx` — the only thing a service trusts

```ts
// src/server/ctx.ts
import 'server-only'

/** Brief §4 rule 3, plus the two fields every caller ends up needing anyway. */
export type Ctx = {
  userId: string
  workspaceId: string
  role: Role                 // Prisma enum: OWNER | ADMIN | MEMBER
  sessionId: string          // so changePassword can spare the current session
  timezone: string           // workspace timezone; used for rendering, never for storage
}
```

`Ctx` is **constructed only** by `requireWorkspace()`. There is no
`buildCtx(workspaceId)` exported anywhere, no test helper that fabricates one
against production code, and no service that accepts a `workspaceId` argument
alongside a `Ctx`. Making `Ctx` the sole carrier of tenancy is what lets the
isolation sweep (§10.3) be exhaustive: there is exactly one way in.

### 9.2 Deriving it

```ts
/** requireSession() → membership lookup → Ctx. Redirects rather than throwing,
 *  because every caller is a layout, page, or action that wants a redirect. */
export const requireWorkspace = cache(async (): Promise<Ctx> => {
  const session = await requireSession()

  // A workspace pointer with no live membership is not access.
  const membership = session.activeWorkspaceId
    ? await workspaceRepo.findActiveMembership(session.userId, session.activeWorkspaceId)
    : null

  if (!membership) {
    // Either no active workspace, or the pointer is stale (removed, suspended,
    // workspace soft-deleted). Fall back to any other ACTIVE membership.
    const fallback = await workspaceRepo.findFirstActiveMembership(session.userId)
    if (!fallback) redirect('/onboarding')
    await repo.setActiveWorkspace(session.id, fallback.workspaceId)
    return toCtx(session, fallback)
  }
  return toCtx(session, membership)
})
```

`findActiveMembership` is the whole authorization root, so its predicates are
written out:

```sql
SELECT m."workspaceId", m.role, w.timezone
FROM "WorkspaceMember" m
JOIN "Workspace" w ON w.id = m."workspaceId"
WHERE m."userId"      = $1
  AND m."workspaceId" = $2
  AND m.status        = 'ACTIVE'      -- MemberStatus; SUSPENDED gets nothing
  AND w."deletedAt"   IS NULL         -- a soft-deleted workspace is inaccessible
LIMIT 1;
```

Wrapped in React `cache()`, so a page with 8 server components that each call
`requireWorkspace()` performs one session probe and one membership lookup.

**The rule, stated as a lint-enforceable invariant:** a `workspaceId` appearing in
a request body, query string, form field, route parameter, or JSON payload is
**ignored**, and logging it at `warn` as `authz.cross_workspace_attempt` is
mandatory. Every action schema is `.strict()` (§12) so a stray `workspaceId` key
is a *validation failure*, not a silently dropped field.

### 9.3 Capabilities, not role checks scattered through the code

`if (ctx.role === 'ADMIN')` sprinkled across 40 service functions is how a
permission drifts. One table instead:

```ts
// src/server/authz.ts
export type Capability =
  // leads
  | 'leads.view' | 'leads.create' | 'leads.edit' | 'leads.delete' | 'leads.bulk_delete'
  | 'leads.import' | 'leads.export'
  // campaigns & sequences
  | 'campaigns.view' | 'campaigns.create' | 'campaigns.edit' | 'campaigns.delete'
  | 'campaigns.launch' | 'campaigns.pause' | 'sequences.edit'
  // mailboxes & deliverability
  | 'mailboxes.view' | 'mailboxes.connect' | 'mailboxes.edit' | 'mailboxes.disconnect'
  | 'mailboxes.limits_edit' | 'warmup.manage' | 'domains.manage'
  // inbox
  | 'inbox.view' | 'inbox.reply' | 'inbox.archive' | 'suppressions.manage'
  // crm
  | 'crm.view' | 'crm.edit' | 'crm.delete'
  // analytics & ai
  | 'analytics.view' | 'ai.use' | 'ai.configure'
  // workspace administration
  | 'members.view' | 'members.invite' | 'members.remove' | 'members.change_role'
  | 'workspace.edit' | 'workspace.delete' | 'workspace.transfer_ownership'
  | 'billing.view' | 'billing.manage'
  | 'audit.view' | 'apikeys.manage' | 'jobs.view' | 'jobs.replay'

export const MATRIX: Readonly<Record<Capability, readonly Role[]>> = { /* §9.4 */ }

export function can(ctx: Ctx, cap: Capability): boolean {
  return MATRIX[cap].includes(ctx.role)
}

/** Throws ForbiddenError. Called at the TOP of every mutating service function. */
export function requireCan(ctx: Ctx, cap: Capability): void {
  if (!can(ctx, cap)) {
    log.warn({ event: 'authz.denied', required: cap, actual: ctx.role, userId: ctx.userId })
    throw new ForbiddenError(cap)
  }
}
```

Deny-by-default: `MATRIX` is `Record<Capability, …>`, so adding a `Capability`
without a row is a **type error**. There is no fallthrough that grants access.

### 9.4 The permission matrix

Read `✓` as allowed, `–` as denied. OWNER is a superset of ADMIN, which is a
superset of MEMBER, with the deliberate exceptions marked.

| Action | Capability | OWNER | ADMIN | MEMBER |
|---|---|:--:|:--:|:--:|
| **Leads** | | | | |
| View leads | `leads.view` | ✓ | ✓ | ✓ |
| Create / edit a lead | `leads.create` / `leads.edit` | ✓ | ✓ | ✓ |
| Delete a single lead | `leads.delete` | ✓ | ✓ | ✓ |
| **Bulk-delete leads** | `leads.bulk_delete` | ✓ | ✓ | **–** |
| Import CSV | `leads.import` | ✓ | ✓ | ✓ |
| **Export leads** | `leads.export` | ✓ | ✓ | **–** |
| **Campaigns** | | | | |
| View campaigns | `campaigns.view` | ✓ | ✓ | ✓ |
| Create / edit campaign, edit sequence | `campaigns.create` / `.edit` / `sequences.edit` | ✓ | ✓ | ✓ |
| **Launch a campaign** | `campaigns.launch` | ✓ | ✓ | **–** |
| Pause a campaign | `campaigns.pause` | ✓ | ✓ | ✓ |
| Delete / archive a campaign | `campaigns.delete` | ✓ | ✓ | – |
| **Mailboxes** | | | | |
| View mailboxes | `mailboxes.view` | ✓ | ✓ | ✓ |
| **Connect a mailbox** | `mailboxes.connect` | ✓ | ✓ | **–** |
| Edit from-name / reply-to | `mailboxes.edit` | ✓ | ✓ | – |
| Disconnect a mailbox | `mailboxes.disconnect` | ✓ | ✓ | – |
| Change daily cap / sending window | `mailboxes.limits_edit` | ✓ | ✓ | – |
| Manage warmup | `warmup.manage` | ✓ | ✓ | – |
| Manage domains / DNS | `domains.manage` | ✓ | ✓ | – |
| **Inbox** | | | | |
| View inbox | `inbox.view` | ✓ | ✓ | ✓ |
| Send a reply | `inbox.reply` | ✓ | ✓ | ✓ |
| Archive / mark read | `inbox.archive` | ✓ | ✓ | ✓ |
| Manage suppressions | `suppressions.manage` | ✓ | ✓ | ✓ |
| **CRM** | | | | |
| View pipeline, opportunities, tasks | `crm.view` | ✓ | ✓ | ✓ |
| Create / edit opportunity, task, note | `crm.edit` | ✓ | ✓ | ✓ |
| Delete an opportunity | `crm.delete` | ✓ | ✓ | – |
| **Analytics & AI** | | | | |
| View analytics | `analytics.view` | ✓ | ✓ | ✓ |
| Use AI (classify, draft, summarise) | `ai.use` | ✓ | ✓ | ✓ |
| Configure AI / set token budget | `ai.configure` | ✓ | ✓ | – |
| **Members** | | | | |
| View members and pending invites | `members.view` | ✓ | ✓ | ✓ |
| **Invite a member** | `members.invite` | ✓ | ✓ | **–** |
| Remove a member | `members.remove` | ✓ | ✓ | – |
| **Change a member's role** | `members.change_role` | ✓ | **✓\*** | **–** |
| **Workspace** | | | | |
| Edit workspace name / defaults | `workspace.edit` | ✓ | ✓ | – |
| **Delete the workspace** | `workspace.delete` | ✓ | **–** | **–** |
| **Transfer ownership** | `workspace.transfer_ownership` | ✓ | **–** | **–** |
| **View billing** | `billing.view` | ✓ | ✓ | **–** |
| **Manage billing / plan** | `billing.manage` | ✓ | **–** | **–** |
| **Operations** | | | | |
| View audit log | `audit.view` | ✓ | ✓ | – |
| Manage API keys | `apikeys.manage` | ✓ | – | – |
| View the job/dead-letter queue | `jobs.view` | ✓ | ✓ | – |
| Replay a dead job | `jobs.replay` | ✓ | ✓ | – |

**`✓*` — three rules on `members.change_role` that the matrix cannot express**,
enforced in `workspace.changeRole` as explicit guards:

```ts
requireCan(ctx, 'members.change_role')

// 1. Nobody may grant a role above their own. Otherwise ADMIN self-escalates
//    by promoting a puppet account to OWNER.
if (nextRole === 'OWNER' && ctx.role !== 'OWNER') throw new ForbiddenError('members.change_role')

// 2. Nobody may change an OWNER's role unless they are an OWNER.
if (target.role === 'OWNER' && ctx.role !== 'OWNER') throw new ForbiddenError('members.change_role')

// 3. THE LAST-OWNER INVARIANT (§9.5).
await assertNotLastOwner(tx, ctx.workspaceId, target.userId)
```

Two matrix decisions worth defending, since they are the ones that will be
questioned:

- **MEMBER cannot launch a campaign or connect a mailbox.** Both are actions
  whose blast radius is *outside* the product: launching sends real mail from a
  real domain and can burn its reputation; connecting a mailbox grants us an
  OAuth scope over someone's email. A MEMBER can build the entire campaign and
  hand it over for launch. This is the one place we accept friction.
- **MEMBER cannot export or bulk-delete leads.** The lead list is the customer's
  commercial asset. "Departing employee exports the lead list" is a real,
  common incident (§17), and it costs one capability to make it an
  ADMIN-and-audited action.

### 9.5 The last-OWNER invariant

**Every workspace has at least one `ACTIVE` OWNER, always.** Violated, the
workspace becomes unadministrable — nobody can invite, change roles, or delete
it — and there is no self-service recovery.

Three operations can violate it: demoting an OWNER, removing an OWNER, and an
OWNER leaving. All three route through one guard:

```ts
// src/modules/workspace/service.ts
async function assertNotLastOwner(tx: Tx, workspaceId: string, losingUserId: string) {
  // FOR UPDATE is load-bearing: two concurrent "demote the other owner" requests
  // both read count = 2 and both proceed, leaving zero owners. The row lock on
  // the OWNER memberships serialises them.
  const owners = await tx.$queryRaw<{ userId: string }[]>`
    SELECT "userId" FROM "WorkspaceMember"
     WHERE "workspaceId" = ${workspaceId}
       AND role   = 'OWNER'
       AND status = 'ACTIVE'
     FOR UPDATE`
  if (owners.length <= 1 && owners.some((o) => o.userId === losingUserId)) {
    throw new LastOwnerError()
  }
}
```

Called **inside** the same transaction as the mutation, never before it. Checked
outside, it is a TOCTOU bug.

Error copy, because "Forbidden" is useless here: *"This is the workspace's only
owner. Promote another member to owner first."*

Ownership transfer is a single transaction that promotes the target to `OWNER`
*before* demoting the caller, so the invariant holds at every intermediate state.

### 9.6 Where enforcement lives, precisely

```
Server Action  ──▶ action() wrapper (§12.1)  ──▶ service fn ──▶ repo fn
                    · requireWorkspace()          · requireCan()   · workspaceId
                    · zod .strict()               · invariants       from Ctx
                    · rate limit
Route Handler  ──▶ assertSameOrigin() ──▶ requireWorkspace() ──▶ service fn ──▶ repo
RSC page       ──▶ requireWorkspace() ──▶ service read fn ──▶ repo
Worker job     ──▶ Ctx built from Job.workspaceId ──▶ service fn ──▶ repo
```

Notes on the edges:

- **The UI hides, the server stops.** `can(ctx, cap)` drives whether a button
  renders. That is UX. The identical check in `requireCan` inside the service is
  the security control. Removing the UI check is a cosmetic bug; removing the
  service check is a vulnerability.
- **Read paths get `requireCan` too**, for the capabilities where a role
  distinction exists (`audit.view`, `billing.view`, `jobs.view`). Where every
  role can read (`leads.view`), the check is still written — it documents intent
  and costs an array lookup.
- **The worker has no session.** It builds `Ctx` from `Job.workspaceId` (non-null
  by schema contract) with a synthetic `userId: 'system'` and `role: 'OWNER'`,
  because the scheduler must be able to act on anything in the tenant. This is
  the one privileged path in the system, and it is why `Job.payload` carries ids
  only: a job that could name an arbitrary workspace would be a
  cross-tenant escalation. `enqueue()` always sets `workspaceId` from the
  enqueuing `Ctx`, never from the payload.

---

## 10. Workspace isolation

Brief §4 calls this the single most important invariant. It gets the most
mechanical treatment in the codebase.

### 10.1 The repo-level rule

**Every repo function names its workspace scope, from `Ctx`, in the query
itself.** Not in a wrapper, not in middleware, not in a Prisma extension — in
the `where` clause of the statement that runs.

```ts
// src/modules/leads/repo.ts

// CORRECT — workspaceId in the where clause, sourced from ctx.
export function findLead(ctx: Ctx, id: string) {
  return prisma.lead.findFirst({ where: { id, workspaceId: ctx.workspaceId } })
}

// WRONG — a global unique id "cannot collide", so the filter looks redundant.
// It is not: the caller controls `id`, and this returns another tenant's row.
export function findLead(_ctx: Ctx, id: string) {
  return prisma.lead.findUnique({ where: { id } })
}
```

Consequences, each non-negotiable:

- **`findUnique` on a tenant-owned model is banned.** It accepts only unique
  fields, and `id` alone is unique, so it *cannot* be scoped. Use `findFirst`
  with the compound where. This is mechanically greppable and belongs in review.
- **Updates and deletes use `updateMany` / `deleteMany` with `workspaceId`,** even
  for a single row, and assert `count === 1`. `prisma.lead.update({ where: { id } })`
  has the same hole as `findUnique`.
- **Nested writes carry the scope too.** `connect: { id: leadId }` on a campaign
  bypasses every top-level filter. Nested connects are validated by first reading
  the child *with* `ctx.workspaceId`, or by using
  `connect: { id_workspaceId: … }` where a compound unique exists. This is the
  sneaky one, and it has its own isolation test (§10.3).
- **Raw SQL takes `workspaceId` as a bound parameter.** Never interpolated,
  never omitted. The queue's `FOR UPDATE SKIP LOCKED` lease is the notable
  exception — it is intentionally cross-tenant, runs only in the worker, and
  every job row carries its own non-null `workspaceId` which becomes the `Ctx`
  for the handler.

**Rejected: a Prisma client extension that injects `workspaceId` globally.** It
reads as the obvious fix and is a trap. It needs request-scoped state
(`AsyncLocalStorage`) to know the tenant, silently does nothing on the query
shapes it does not understand (`findUnique`, raw SQL, nested writes), and makes
every repo function *look* safe whether or not it is. An explicit filter is
greppable, testable, and reviewable. Boring wins.

### 10.2 404, never 403

```ts
// src/lib/errors.ts
export class NotFoundError extends AppError {}      // → notFound() / 404
export class ForbiddenError extends AppError {}     // → 403, ONLY for role denials
```

The distinction, which is easy to blur and important:

| Situation | Response | Why |
|---|---|---|
| Resource is in **another workspace** | **404 / `notFound()`** | brief §4 rule 5. A 403 confirms the id exists somewhere, which is a cross-tenant existence oracle. |
| Resource does not exist at all | 404 | identical to the above, deliberately |
| Resource **is in your workspace**, your role is insufficient | **403 `ForbiddenError`** | you already know it exists; telling you why you cannot act is useful, not a leak |

So a MEMBER hitting `campaigns.launch` gets a clear 403 ("Only admins can launch
campaigns"), while anyone touching another tenant's campaign gets an
indistinguishable 404. `ForbiddenError` is thrown **only** by `requireCan` and
the explicit role guards in §9.4; a repo miss is always `NotFoundError`.

A foreign-id access is logged at `warn` as
`authz.cross_workspace_attempt { requestedId, requestedType }` (the taxonomy in
`09-deployment-and-testing.md` §5.2 already reserves it) so §17's alert has
something to fire on. Note the honest caveat: most hits will be stale bookmarks
and a deleted-then-refetched row, not attacks. It is a rate-of-change signal, not
a per-event alarm.

### 10.3 How we test isolation

`09-deployment-and-testing.md` §9.3 owns the harness. The contract this document
adds is what makes it a **sweep rather than a sample**:

```ts
// tests/integration/workspace-isolation.test.ts
// Enumerate the module's actual exports and assert each one is covered by a case.
// A new repo function that nobody added a case for FAILS the suite — that is the
// whole mechanism. Reviewers forget; a failing test does not.
import * as leadsRepo from '@/modules/leads/repo'

const covered = new Set(cases.map((c) => c.name))
for (const name of Object.keys(leadsRepo).filter(isExportedFn)) {
  test(`isolation case exists for leads.repo.${name}`, () => {
    expect(covered.has(`leads.repo.${name}`)).toBe(true)
  })
}
```

Each case creates the row as workspace A, calls the function as workspace B, and
asserts one of three outcomes:

| Expectation | Meaning |
|---|---|
| `notFound` | returns null / a `NotFoundError` Result / throws `NotFoundError`. **Never `ForbiddenError`** — the test asserts the error class, which is what pins §10.2 down. |
| `empty` | list functions return `[]` and counts return `0` |
| `noop` | writes affect 0 rows, and A's row is byte-identical afterwards |

Plus these, each its own test, because they catch classes of bug the per-function
sweep cannot:

| Test | Pins down |
|---|---|
| every tenant table has a NOT NULL `workspaceId` (via `information_schema.columns`) | a new model without the column fails CI |
| every unique index on a tenant table includes `workspaceId` (via `pg_index`) | brief §4 rule 6 — a bare-global unique |
| **no repo file calls `findUnique`/`update`/`delete` on a tenant model** (AST or grep over `src/modules/*/repo.ts`) | §10.1 mechanically, not by review |
| a `workspaceId` key in an action payload is rejected by the schema | brief §4 rule 2, through the real wrapper |
| a foreign-workspace id in a **nested relation** (a foreign `leadId` on your own campaign) is rejected | the nested-connect hole in §10.1 |
| a MEMBER cannot perform an OWNER-only action | §9 is server-side |
| a user removed from a workspace loses access on the next request | §5.6's "no revocation needed" claim |
| demoting the last OWNER fails, concurrently too | §9.5's `FOR UPDATE` |
| cross-workspace access logs `authz.cross_workspace_attempt` | §17's alert has a source |

### 10.4 Switching the active workspace

```ts
// src/modules/workspace/service.ts
export async function switchWorkspace(session: SessionRecord, workspaceId: string) {
  // The ONLY authorization that matters: does THIS user have a live membership?
  const m = await repo.findActiveMembership(session.userId, workspaceId)
  if (!m) throw new NotFoundError('workspace')      // 404, not 403 (§10.2)
  await repo.setActiveWorkspace(session.id, workspaceId)
  revalidatePath('/', 'layout')                     // drop every cached RSC payload
}
```

Four properties:

- **Server action, POST-equivalent.** Not `GET /switch?ws=…`: a state-changing GET
  is banned (§14.3), and this one is CSRF-able into "victim now operates in the
  attacker's workspace".
- **The membership check is the authorization.** The incoming `workspaceId` is
  attacker-controlled, so it is *validated* against `WorkspaceMember`, never
  trusted. This is not an exception to brief §4 rule 2: the id is a
  **selector among the user's own memberships**, and the resulting `Ctx` is still
  built server-side from the row we just verified.
- **`revalidatePath('/', 'layout')` is mandatory.** Without it, cached RSC payloads
  from the previous workspace render under the new one — a tenant leak through
  the framework's cache rather than through a query (§17).
- **The switcher lists only `ACTIVE` memberships of live workspaces**, from the
  same query shape as §9.2.

`Session.activeWorkspaceId` is `onDelete: SetNull` in the schema, so deleting a
workspace nulls the pointer and every session in it falls through to §9.2's
fallback on the next request. No sweeper.

### 10.5 Caching and tenancy

The one framework-level way to leak across tenants without writing a bad query.

| Cache | Rule |
|---|---|
| React `cache()` (`getSession`, `requireWorkspace`) | per-request by construction. Safe. |
| `revalidatePath` / `revalidateTag` | tags **must** include the workspace id: `revalidateTag(\`ws:${ctx.workspaceId}:leads\`)`. A bare `'leads'` tag invalidates across tenants — noisy rather than leaky, but it also means one tenant's write can serve another's stale render. |
| `unstable_cache` / `"use cache"` | **banned for any tenant-scoped read.** The cache key is derived from arguments, and a function reading `ctx.workspaceId` from an enclosing scope produces one entry serving every tenant. This is the single highest-severity cache mistake available to us. If it is ever needed, `workspaceId` must be an explicit first argument. |
| `fetch` memoisation | not used for tenant data — we read through Prisma. |
| Module-scope `Map`/object caches | **banned.** A module-level `Map` in a long-lived server process is shared across every request and every tenant. |

`DUMMY_HASH` (§5.2) is the only module-scope cached value in the auth path, and it
holds no tenant data.
