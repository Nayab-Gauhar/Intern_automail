# 05 — Email providers & mailbox connectivity

> **Owns:** the `MailProvider` interface, the provider registry, the Gmail
> implementation, the fake provider, OAuth, token lifecycle, MIME construction,
> incremental sync, push notifications, bounce parsing, and tracking mechanics.
>
> **Consumed by:** `06-jobs-and-sending-engine` (send path, error taxonomy),
> `07-replies` (inbound classification input), `08-analytics-crm-ai`
> (`EmailEvent` production), `09-deployment-and-testing` (the test seam).
>
> **Subordinate to:** `00-product-brief.md` and `prisma/schema.prisma`. Where a
> sibling doc and the schema disagree, the schema wins and the disagreement is
> recorded in §18.

---

## 1. The one decision this document exists to make

Gmail is the only provider that sends mail in v1. Nothing else in the codebase
is allowed to know that.

Concretely, three properties must hold at the end of phase 2, and each is
testable by grep:

1. **`googleapis` is imported in exactly one file**
   (`src/modules/mailboxes/providers/gmail.ts`). Any other import is a broken
   seam: the code path it creates cannot be exercised without the network.
2. **`new GmailProvider(...)` appears in exactly one file**
   (`src/modules/mailboxes/provider-registry.ts`). Everything else calls
   `getProvider()`.
3. **No Gmail-shaped type crosses a module boundary.** No caller ever sees
   `gmail_v1.Schema$Message`, a `payload.parts` tree, a label id, or a
   `historyId` outside `SyncState`. The provider returns normalised domain
   types that map onto `EmailMessage` columns one-for-one.

Property 3 is the one that decays quietly. It is easy to "abstract" a provider
by passing its raw response through, and then discover in phase 11 that the
inbox parser, the reply classifier, and three UI components all know what a
Gmail MIME part looks like. The provider owns parsing. Callers get columns.

### 1.1 Naming: `MailProvider`, not `EmailProvider`

`EmailProvider` is already a **Prisma enum** (`GMAIL | OUTLOOK | SMTP`), so the
interface cannot share the name without a permanent import-alias tax in every
file that touches both.

```ts
import type { EmailProvider } from '@prisma/client';   // the enum
import type { MailProvider }  from '@/modules/mailboxes/providers/types';
```

`09-deployment-and-testing.md` already says `MailProvider`. `06` line 363 says
`EmailProvider`. **`MailProvider` is correct**; `06` needs the one-word fix
(§18.1).

### 1.2 Files owned by this document

```
src/modules/mailboxes/
  index.ts                  # PUBLIC API — the only import surface for app/**
  service.ts                # connect, reconnect, disconnect, status transitions
  repo.ts                   # the only Prisma access for EmailAccount + SyncState
  schema.ts                 # zod: connect input, callback params, webhook body
  types.ts                  # domain types (never Prisma types outward)
  provider-registry.ts      # getProvider() — the ONLY construction path
  tokens.ts                 # access-token cache, refresh, invalid_grant handling
  oauth-state.ts            # sign/verify the single-use OAuth state parameter
  sync.ts                   # backfill + delta orchestration over the interface
  providers/
    types.ts                # MailProvider, capabilities, DTOs, ProviderError
    gmail.ts                # GmailProvider   (the only googleapis importer)
    gmail-mime.ts           # RFC 5322 builder + parser (pure, unit-tested)
    gmail-errors.ts         # Gmail error → ProviderError (pure, unit-tested)
    fake.ts                 # FakeProvider    (E2E + contract tests)
    dsn.ts                  # DSN/bounce parsing (pure, unit-tested)

src/app/api/oauth/google/start/route.ts
src/app/api/oauth/google/callback/route.ts
src/app/api/webhooks/gmail/route.ts
src/app/api/track/open/[token]/route.ts
src/app/api/track/click/[token]/route.ts
src/app/api/u/[token]/route.ts               # one-click unsubscribe (GET + POST)
src/app/api/test/fake-provider/**            # 404 unless E2E_FAKE_PROVIDER=1
```

`gmail-mime.ts`, `gmail-errors.ts`, and `dsn.ts` are **pure functions over
strings and plain objects**. They hold the density of real-world detail in this
system, they are where the bugs live, and they are cheap to test exhaustively
only if they never touch the network or the database. Keep them that way.

---

## 2. The `MailProvider` interface

Design constraints, in priority order:

- **Stateless with respect to credentials.** A provider instance holds a client
  id/secret and nothing per-mailbox. Every call takes a `ProviderAuth`. This is
  what lets the registry build one instance per process and lets `tokens.ts`
  own the entire token lifecycle in one place.
- **No method returns a provider-shaped object.** Inputs and outputs are DTOs
  declared in `providers/types.ts`.
- **Capability differences are declared, not faked.** A provider that cannot do
  something omits the method and says so in `capabilities`. It never returns a
  plausible-looking lie.
- **Every network interaction the product performs is a method.** If it isn't,
  the fake cannot stand in for it and the E2E suite is broken by construction.

### 2.1 Auth and identity DTOs

```ts
// src/modules/mailboxes/providers/types.ts

/** What a provider needs to make one authenticated call. Never a refresh token. */
export type ProviderAuth = {
  /** Plaintext access token. Lives in memory for the duration of one call. */
  readonly accessToken: string;
  /** The provider's own account id, when a method needs it (Graph does). */
  readonly providerAccountId?: string;
};

export type AuthStartInput = {
  /** Signed, single-use state (§4.3). Opaque to the provider. */
  readonly state: string;
  /** Absolute callback URL. Must match the provider console registration. */
  readonly redirectUri: string;
  /** Pre-fills the account chooser on reconnect. Never trusted as identity. */
  readonly loginHint?: string;
};

export type AuthorizationUrl = {
  readonly url: string;
  /** PKCE verifier when the provider requires it. Gmail (confidential client)
   *  does not; Graph public clients do. Stored in the state payload, not a cookie. */
  readonly codeVerifier?: string;
};

/** Result of exchanging an authorization code. */
export type ProviderCredentials = {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  /**
   * Absent when the provider declines to issue one — which for Google means the
   * user has already granted consent and we did not force `prompt=consent`.
   * The caller MUST treat absence as an error on first connect and as
   * "keep the stored token" on reconnect (§4.5).
   */
  readonly refreshToken?: string;
  /** Space-separated, exactly as granted. Persisted to `EmailAccount.grantedScopes`. */
  readonly grantedScopes: string;
};

export type RefreshedCredentials = {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  /**
   * Set only by providers that ROTATE refresh tokens. Google does not (the same
   * refresh token keeps working). Microsoft does — see §16.1. When present the
   * caller must persist it in the same transaction that persists the access
   * token, or the mailbox is bricked.
   */
  readonly rotatedRefreshToken?: string;
  readonly grantedScopes?: string;
};

export type ProviderProfile = {
  /** Lowercased. Written to `EmailAccount.email` and `providerAccountId`. */
  readonly email: string;
  readonly displayName?: string;
  /**
   * Opaque sync cursor as of NOW. Captured BEFORE a backfill begins so nothing
   * that arrives during the backfill is missed (§6.2).
   */
  readonly cursor: SyncCursor;
  readonly totalMessages?: number;
};
```

### 2.2 Capability flags

```ts
export type MessageIdFidelity = 'preserved' | 'rewritten' | 'unreliable';

export type ProviderCapabilities = {
  /** Provider exposes stable conversation ids we can store in
   *  `EmailThread.providerThreadId` and reply into. False ⇒ association falls
   *  back to `rootMessageId` + `references` overlap, which the schema supports. */
  readonly supportsThreadIds: boolean;

  /** A cursor-based delta feed exists. False ⇒ full-scan polling only. */
  readonly supportsIncrementalSync: boolean;

  /** Server can notify us of changes over HTTP. False ⇒ polling is the ONLY
   *  path and `SyncState.watchExpiresAt` stays null. */
  readonly supportsPush: boolean;

  /** Arbitrary user-visible labels. False ⇒ folders/categories; our
   *  `EmailMessage.labels` array is then populated with folder names. */
  readonly supportsLabels: boolean;

  /** Read/archive state written back to the provider. False ⇒ our `isRead`
   *  and `isArchived` are LOCAL ONLY and the UI must say so. */
  readonly supportsReadStateWriteback: boolean;

  /** Indexed server-side search we can use for send reconciliation (§5.7). */
  readonly supportsMessageIdSearch: boolean;

  /** True only if the provider genuinely tells us a message reached the
   *  recipient's server. FALSE FOR EVERY v1 PROVIDER — see §8.1. Exists so the
   *  analytics layer can refuse to render a delivery rate rather than invent one. */
  readonly reportsDeliveryConfirmation: boolean;

  /** Custom `X-` headers survive the send. Required for reconcile strategy B. */
  readonly preservesCustomHeaders: boolean;

  /** Whether our generated `Message-ID` survives. Drives which reconciliation
   *  strategy is primary (§5.7). */
  readonly messageIdFidelity: MessageIdFidelity;

  /** Arbitrary non-`X-` headers (List-Unsubscribe) can be set. Graph's JSON
   *  send path cannot — see §16.1. */
  readonly supportsArbitraryHeaders: boolean;

  /** Hard ceiling on the assembled RFC 5322 message, in bytes, before base64. */
  readonly maxRawMessageBytes: number;
};
```

`reportsDeliveryConfirmation` deserves its place. Gmail's API has no delivery
callback, no DSN webhook, and no per-message status. The
`EmailEventType.DELIVERED` enum member exists in the schema with a comment
saying exactly this. Rather than let a future implementer synthesise `DELIVERED`
from `SENT` because a chart looked empty, the capability flag makes the absence
a typed fact that `08`'s reporting layer reads and renders as "not available for
this provider".

### 2.3 Sync DTOs

```ts
export type SyncCursor =
  | { readonly kind: 'none' }
  | { readonly kind: 'gmail-history'; readonly historyId: string }
  | { readonly kind: 'delta-token';   readonly token: string }
  | { readonly kind: 'imap-uid';      readonly uidValidity: number; readonly uidNext: number };

export type MessageChange =
  | { readonly kind: 'added';    readonly providerMessageId: string; readonly providerThreadId: string | null }
  | { readonly kind: 'labels';   readonly providerMessageId: string; readonly added: readonly string[]; readonly removed: readonly string[] }
  | { readonly kind: 'deleted';  readonly providerMessageId: string };

export type FetchChangesResult =
  | {
      readonly kind: 'ok';
      readonly changes: readonly MessageChange[];
      /** Advance `SyncState` to this ONLY when `nextPageToken` is null. */
      readonly nextCursor: SyncCursor;
      /** More pages at the SAME cursor. Non-null ⇒ do not advance the cursor. */
      readonly nextPageToken: string | null;
    }
  | {
      /** The stored cursor is too old to serve. Caller runs the bounded
       *  re-backfill path and sets `SyncStatus.CURSOR_EXPIRED` (§6.5). */
      readonly kind: 'cursor_expired';
      /** Cursor as of now, so the re-backfill has a fresh anchor. */
      readonly currentCursor: SyncCursor;
    };
```

Splitting `nextCursor` from `nextPageToken` is the whole correctness story of
incremental sync, and it is the mistake everyone makes once. A paginated delta
response carries a cursor that is only valid **after the last page**. Persist it
mid-pagination, crash, and every message on the remaining pages is lost forever
with no error anywhere. The type makes that unrepresentable: `nextPageToken`
non-null means the cursor is not yours yet.

### 2.4 The normalised inbound message

Every field here lands in an `EmailMessage` column. That correspondence is the
contract; keep it visible.

```ts
export type ProviderAttachmentRef = {
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Fetch on demand via `fetchAttachment`. Bytes are never stored (schema). */
  readonly providerAttachmentId: string;
  readonly contentId: string | null;   // inline images
};

export type ProviderMessage = {
  readonly providerMessageId: string;          // → providerMessageId
  readonly providerThreadId: string | null;    // → thread.providerThreadId

  /** Angle brackets stripped, lowercased. Null when the sender omitted it —
   *  rare but legal, and it must not crash the parser. */
  readonly rfcMessageId: string | null;        // → rfcMessageId
  readonly inReplyTo: string | null;           // → inReplyTo  (LAST value if several)
  readonly references: readonly string[];      // → references (normalised, oldest first)

  readonly fromEmail: string;                  // → fromEmail
  readonly fromName: string | null;            // → fromName
  readonly toEmails: readonly string[];        // → toEmails
  readonly ccEmails: readonly string[];        // → ccEmails
  readonly bccEmails: readonly string[];       // → bccEmails
  readonly replyTo: string | null;             // → replyTo

  readonly subject: string | null;             // → subject   (RFC 2047 decoded)
  readonly normalizedSubject: string | null;   // → thread.normalizedSubject
  readonly snippet: string | null;             // → snippet
  readonly bodyHtml: string | null;            // → bodyHtml
  readonly bodyText: string | null;            // → bodyText

  readonly attachments: readonly ProviderAttachmentRef[];   // → attachments (Json)
  readonly labels: readonly string[];                       // → labels

  /**
   * The subset of raw headers the schema says we must not lose:
   * Auto-Submitted, X-Autoreply, X-Autorespond, Precedence, List-Id,
   * List-Unsubscribe, Return-Path, Authentication-Results, X-Failed-Recipients,
   * Content-Type, Delivered-To. Lowercased keys. NOT the full block.
   */
  readonly headers: Readonly<Record<string, string>>;       // → headers (Json)

  /** Provider timestamp (Gmail `internalDate`), never the `Date` header. */
  readonly sentAt: Date;                                    // → sentAt

  /** Provider's own read flag, where it has one. */
  readonly isUnread: boolean;

  /**
   * Set by the provider when the message is structurally a DSN
   * (`multipart/report; report-type=delivery-status`). Parsing lives in
   * `dsn.ts`; the provider only fills this in because only it has the raw MIME.
   * Null for ordinary mail. Maps onto `bounceType`/`bounceCode`/`bouncedRecipient`.
   */
  readonly dsn: ParsedDsn | null;
};
```

`normalizedSubject` is computed in the provider rather than downstream because
prefix stripping is locale-dependent (`Re:`, `RE :`, `Fwd:`, `AW:`, `SV:`,
`Antwort:`, `回复:`) and duplicating that regex in the inbox module guarantees
the two copies diverge.

### 2.5 The outbound message

```ts
export type OutboundAttachment = {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Uint8Array;
  readonly contentId?: string;
  readonly inline?: boolean;
};

export type OutboundMessage = {
  readonly from: { readonly email: string; readonly name?: string };
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly replyTo?: string;

  /** Empty string is legal and means "reply in thread with no new subject"
   *  (schema: SequenceStepVariant.subject comment). */
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodyText: string;

  /**
   * WE generate this, before the send, with angle brackets. It is written to
   * `ScheduledEmail.rfcMessageId` and committed BEFORE the provider call, so
   * reconciliation works even if the response is lost.
   */
  readonly messageId: string;

  /** `ScheduledEmail.inReplyToMessageId` / `.referencesHeader`, verbatim. */
  readonly inReplyTo?: string;
  readonly references?: string;

  /** `ScheduledEmail.providerThreadId` of the thread to land in. Ignored by
   *  providers with `supportsThreadIds: false`. */
  readonly providerThreadId?: string;

  /** Additional headers. `List-Unsubscribe`, `List-Unsubscribe-Post`,
   *  `X-IM-Send-Token`, `Auto-Submitted`. See §5.4. */
  readonly headers?: Readonly<Record<string, string>>;

  readonly attachments?: readonly OutboundAttachment[];
};

export type SendResult = {
  readonly providerMessageId: string;
  readonly providerThreadId: string | null;
  /**
   * The `Message-ID` the provider actually stored, read back after send. May
   * differ from `msg.messageId`. Null when the provider gives us no way to
   * check. Drives the per-mailbox reconciliation strategy (§5.7).
   */
  readonly observedMessageId: string | null;
  readonly sentAt: Date;
};
```

### 2.6 The interface

```ts
export interface MailProvider {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;

  // ── OAuth / credentials ────────────────────────────────────────────────
  getAuthorizationUrl(input: AuthStartInput): AuthorizationUrl;
  exchangeCode(input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier?: string;
  }): Promise<ProviderCredentials>;
  refreshAuth(input: { readonly refreshToken: string }): Promise<RefreshedCredentials>;
  /** Best-effort. A provider-side failure is logged, not surfaced: the user
   *  pressed "disconnect" and our rows must be cleared regardless (§4.7). */
  revokeAuth(input: { readonly refreshToken: string }): Promise<void>;

  // ── Identity ───────────────────────────────────────────────────────────
  getProfile(auth: ProviderAuth): Promise<ProviderProfile>;

  // ── Sending ────────────────────────────────────────────────────────────
  send(auth: ProviderAuth, msg: OutboundMessage): Promise<SendResult>;

  // ── Reading ────────────────────────────────────────────────────────────
  fetchChanges(
    auth: ProviderAuth,
    cursor: SyncCursor,
    opts: { readonly pageToken?: string; readonly maxResults?: number },
  ): Promise<FetchChangesResult>;

  /** Full backfill: newest-first enumeration bounded by `after`. Used when the
   *  cursor is `{ kind: 'none' }` or expired. */
  fetchBackfillPage(
    auth: ProviderAuth,
    opts: { readonly after: Date; readonly pageToken?: string; readonly maxResults?: number },
  ): Promise<{
    readonly providerMessageIds: readonly string[];
    readonly nextPageToken: string | null;
  }>;

  fetchMessage(auth: ProviderAuth, providerMessageId: string): Promise<ProviderMessage | null>;

  fetchAttachment(
    auth: ProviderAuth,
    input: { readonly providerMessageId: string; readonly providerAttachmentId: string },
  ): Promise<Uint8Array>;

  /** Indexed lookup by RFC Message-ID. Present iff
   *  `capabilities.supportsMessageIdSearch`. Reconciliation strategy A. */
  findByRfcMessageId?(
    auth: ProviderAuth,
    rfcMessageId: string,
  ): Promise<readonly { readonly providerMessageId: string; readonly providerThreadId: string | null }[]>;

  // ── Push. Present iff `capabilities.supportsPush`. ──────────────────────
  watch?(auth: ProviderAuth, input: { readonly topic: string }): Promise<{
    readonly expiresAt: Date;
    /** Cursor as of the watch call. Seeds `SyncState.historyId` on first watch. */
    readonly cursor: SyncCursor;
  }>;
  unwatch?(auth: ProviderAuth): Promise<void>;

  // ── Writeback. Present iff `capabilities.supportsReadStateWriteback`. ────
  setReadState?(auth: ProviderAuth, providerMessageId: string, isRead: boolean): Promise<void>;
  setArchived?(auth: ProviderAuth, providerThreadId: string, archived: boolean): Promise<void>;
}
```

Optional methods paired with a capability flag, rather than required methods
that throw, is deliberate: TypeScript then forces the caller to acknowledge the
absence at the call site. To keep that from spreading `if (!provider.watch)`
noise, one narrowing helper does the work:

```ts
// src/modules/mailboxes/providers/types.ts
export class CapabilityUnsupportedError extends AppError {
  constructor(readonly providerKind: ProviderKind, readonly capability: string) { super(...); }
}

export function requirePush(p: MailProvider): Required<Pick<MailProvider, 'watch' | 'unwatch'>> {
  if (!p.capabilities.supportsPush || !p.watch || !p.unwatch) {
    throw new CapabilityUnsupportedError(p.kind, 'push');
  }
  return p as Required<Pick<MailProvider, 'watch' | 'unwatch'>>;
}
```

The `MAILBOX_RENEW_WATCH` job calls `requirePush`. For an SMTP mailbox that
throws a `TerminalError`, the job dead-letters once, and the correct fix is that
the job should never have been enqueued — which is exactly the signal we want,
rather than a silent no-op that leaves a mailbox un-synced for a week.

### 2.7 How callers stay provider-agnostic

The send path in `06` is one screen of code with no provider knowledge:

```ts
// src/modules/sending/service.ts (excerpt — 06 owns this file)
const mailbox  = await mailboxes.getSendable(ctx, se.emailAccountId);   // throws if not ACTIVE
const provider = getProvider(mailbox);
const auth     = await mailboxes.getAuth(ctx, mailbox.id);              // §4.6, refreshes if needed

const result = await provider.send(auth, {
  from: { email: mailbox.email, name: mailbox.fromName ?? undefined },
  to: [se.toEmail],
  replyTo: mailbox.replyToEmail ?? undefined,
  subject: se.subject,
  bodyHtml: se.bodyHtml,
  bodyText: se.bodyText,
  messageId: se.rfcMessageId!,               // generated + committed at claim time
  inReplyTo: se.inReplyToMessageId ?? undefined,
  references: se.referencesHeader ?? undefined,
  providerThreadId: se.providerThreadId ?? undefined,
  headers: buildOutboundHeaders(se, mailbox),   // §5.4 — pure
});
```

Three things make that possible and each is load-bearing:

- `getAuth` returns a `ProviderAuth`, so no caller ever holds a refresh token.
- `buildOutboundHeaders` is pure and provider-independent; a provider that
  cannot honour a header drops it and says so via
  `capabilities.supportsArbitraryHeaders`, which the header builder reads to
  decide whether `List-Unsubscribe` can be promised (§16.1).
- Everything the caller persists comes from `SendResult`, whose fields are
  exactly the four `ScheduledEmail` columns that need filling.

### 2.8 Where capability differences are handled honestly

| Capability absent | What we do NOT do | What we actually do |
|---|---|---|
| `supportsThreadIds` | Invent a thread id from a subject hash | `EmailThread.providerThreadId` stays null; association uses `rootMessageId` and the GIN-indexed `references` overlap the schema already provides |
| `supportsPush` | Pretend a watch exists | `SyncState.watchExpiresAt` stays null; the mailbox is polled on the `MAILBOX_SYNC` cadence; the mailbox detail page says "polled every N minutes" instead of "live" |
| `supportsReadStateWriteback` | Silently keep read state local while the UI implies otherwise | `isRead`/`isArchived` remain local; the inbox shows a one-line note that read state is not written back for this provider |
| `reportsDeliveryConfirmation` | Synthesise `DELIVERED` from `SENT` | Delivery rate is rendered as "not reported by this provider", per brief §10 |
| `supportsMessageIdSearch` | Assume "not found" means "not sent" | Reconciliation falls to strategy B, and if that is also unavailable the verdict is `inconclusive` and **we do not send** (`06` §6.4) |
| `supportsArbitraryHeaders` | Drop `List-Unsubscribe` quietly | Send via the raw-MIME path if the provider has one; if it has none, refuse to launch a campaign from that mailbox with an explicit error naming the missing header |

The last row is the pattern for all of them: a missing capability produces a
visible, named consequence at the boundary, never a quiet degradation three
layers down.

---

## 3. The test seam — a hard requirement on the interface

**This section is a requirement, not a testing convenience.** `09` §10.1 states
it as a constraint on this document; here it is discharged.

The E2E suite must drive register → connect mailbox → import leads → build a
sequence → launch → send → receive a reply → sequence stops → CRM opportunity,
with **zero network calls to Google**. If it cannot, the suite is either flaky
or fictional, and the core product invariants ("a reply stops the sequence",
"we never send twice") go untested end to end. Those two invariants are the
product.

### 3.1 The registry is the only construction path

```ts
// src/modules/mailboxes/provider-registry.ts
import 'server-only';

export type ProviderKind = 'gmail' | 'fake';

let gmailSingleton: GmailProvider | undefined;
let fakeSingleton: FakeProvider | undefined;

/**
 * The ONLY way any code obtains a MailProvider.
 * A grep test asserts `new GmailProvider(` and `new FakeProvider(` appear
 * nowhere else in src/** or worker/**.
 */
export function getProvider(mailbox: { readonly provider: EmailProvider }): MailProvider {
  if (env.E2E_FAKE_PROVIDER) return (fakeSingleton ??= new FakeProvider());

  switch (mailbox.provider) {
    case 'GMAIL':
      return (gmailSingleton ??= new GmailProvider({
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
      }));
    case 'OUTLOOK':
    case 'SMTP':
      // Honest failure, not a stub that half-works. Phase 11.
      throw new ProviderNotImplementedError(mailbox.provider);
  }
}

/** For the OAuth start/callback routes, which have no mailbox row yet. */
export function getProviderByKind(kind: EmailProvider): MailProvider {
  return getProvider({ provider: kind });
}
```

Selection rules, exactly:

1. `E2E_FAKE_PROVIDER=1` ⇒ `FakeProvider` for **every** mailbox, whatever
   `EmailAccount.provider` says. One branch, first line, no per-call-site opt-in.
2. `E2E_FAKE_PROVIDER` is read **only** here and in `src/lib/env.ts`. A lint
   rule (`no-restricted-syntax` on `process.env.E2E_FAKE_PROVIDER`) enforces it.
3. The env schema refines `E2E_FAKE_PROVIDER !== '1' when NODE_ENV === 'production'`,
   so a mis-set flag is a boot crash, not a silent production backdoor. `09`
   already has this refinement and a test that asserts the crash.
4. `OUTLOOK`/`SMTP` throw rather than fall through to Gmail. A mailbox row with
   `provider = SMTP` in v1 is a data bug and should stop, loudly.

### 3.2 The OAuth flow goes through the same seam

This is the part that is easy to get wrong: stubbing `send` but leaving OAuth
real means the E2E suite still needs a human at a Google consent screen, and the
whole exercise fails at step 2 of the happy path.

`getAuthorizationUrl` and `exchangeCode` are interface methods for this reason
alone. `FakeProvider.getAuthorizationUrl` returns a URL pointing back at our own
callback with a synthetic code:

```ts
// FakeProvider
getAuthorizationUrl({ state, redirectUri }: AuthStartInput): AuthorizationUrl {
  const code = `fake-code-${randomHex(8)}`;
  this.pendingCodes.set(code, { email: this.nextConnectEmail ?? 'sender@fake.test' });
  return { url: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}` };
}
```

"Connect Gmail" in E2E is therefore one redirect that lands straight back on our
callback. The callback handler runs its **real** code — state verification, code
exchange, profile fetch, encryption, row creation, backfill enqueue — against the
fake. That is the point: the flow under test is ours, and the only thing replaced
is Google.

### 3.3 `FakeProvider` shape

```ts
// src/modules/mailboxes/providers/fake.ts
export class FakeProvider implements MailProvider {
  readonly kind = 'fake' as const;

  /** Deliberately Gmail-like so contract tests are meaningful. */
  readonly capabilities: ProviderCapabilities = {
    supportsThreadIds: true,
    supportsIncrementalSync: true,
    supportsPush: true,
    supportsLabels: true,
    supportsReadStateWriteback: true,
    supportsMessageIdSearch: true,
    reportsDeliveryConfirmation: false,   // matches Gmail. Never true.
    preservesCustomHeaders: true,
    messageIdFidelity: 'preserved',
    supportsArbitraryHeaders: true,
    maxRawMessageBytes: 25 * 1024 * 1024,
  };

  // ── Control surface (test-only; not on MailProvider) ──
  failNextSendWith(err: ProviderError): void;
  rateLimitNextSend(retryAfterMs: number): void;
  delayNextSendMs(ms: number): void;            // exercises lease renewal
  /** Push an inbound message into a mailbox's synthetic history. */
  enqueueInbound(input: FakeInboundInput): void;
  /** Simulate a revoked grant: refreshAuth then throws invalid_grant. */
  revokeGrant(email: string): void;
  /** Simulate Gmail rewriting our Message-ID, to exercise reconcile strategy B. */
  rewriteMessageIdsFrom(email: string): void;
  /** Simulate an aged-out cursor. */
  expireCursor(email: string): void;

  readonly sentMessages: ReadonlyArray<SentRecord>;   // assertions read this
  reset(): void;                                      // per-test isolation
}
```

Two rules on the fake, both learned the hard way:

- **No randomness in behaviour.** Failure injection is a queue the test fills,
  never a probability. A flaky fake is worse than no fake because it destroys
  trust in the suite it exists to justify.
- **The fake maintains a real history log.** `enqueueInbound` appends to a
  monotonic per-mailbox history with integer cursors, so `fetchChanges`
  pagination, cursor advancement, and the `cursor_expired` path are all
  genuinely exercised. A fake whose `fetchChanges` returns everything every time
  proves nothing about the one algorithm most likely to lose mail.

### 3.4 The contract suite binds them together

`09` §9.6 runs `tests/integration/provider-contract.test.ts` against both
implementations, with Gmail skipped unless `GMAIL_SANDBOX_REFRESH_TOKEN` is set.
This document adds four cases to the list there, because they are the ones that
catch drift in the awkward places:

```
test('fetchChanges does not advance the cursor while nextPageToken is non-null');
test('an expired cursor yields kind:"cursor_expired" with a usable currentCursor');
test('send with a 25MB attachment yields a permanent, not retryable, error');
test('refreshAuth on a revoked grant yields ProviderAuthRevoked, not ProviderAuthFailed');
```

The last one matters because the two errors have opposite consequences: one
retries, the other disconnects the mailbox and emails the user (§4.8).

---

## 4. Gmail OAuth 2.0, end to end

### 4.1 Scopes — the decision and the justification

**We request exactly two:**

```
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.readonly
```

Per-scope reasoning:

| Scope | Grants | Do we need it | Verdict |
|---|---|---|---|
| `gmail.send` | Send only. No read of any kind. | Yes — the product sends mail. | **Requested.** |
| `gmail.readonly` | Read mail, threads, labels, history, `users.watch`. No write. | Yes — reply detection, thread sync, bounce DSN parsing, send reconciliation, and push all read. | **Requested.** |
| `gmail.modify` | Read **plus** modify labels, mark read, archive, trash. | Only for read-state writeback and archive-in-Gmail, both non-essential in v1. | **Rejected for v1.** |
| `gmail.metadata` | Headers only, no bodies. | Insufficient: reply classification reads bodies, and DSN parsing needs the report body. | Rejected. |
| `mail.google.com/` | Full IMAP-equivalent access, including delete. | No. | Rejected outright. |
| `userinfo.email` | The signed-in Google identity. | No — mailbox connect is not login (brief §6), and `users.getProfile` under `gmail.readonly` already returns the address we need. | Rejected. Requesting it would blur the identity boundary the brief draws. |

The `gmail.modify` decision is the one with a real product cost, so state it
plainly: **without it, marking a thread read or archiving it in Instant Mail does
not change anything in the user's Gmail.** That is a visible limitation. We
accept it in v1 because `gmail.modify` grants trash and label rewriting over the
user's entire mailbox — a materially larger blast radius for a convenience
feature — and because `capabilities.supportsReadStateWriteback: false` makes the
limitation explicit in the UI rather than surprising. When writeback is built,
the escalation is a scope change with a re-consent prompt (§4.5), which is
exactly the review moment we want.

`grantedScopes` on `EmailAccount` exists to make this checkable at runtime:

```ts
const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

export function missingScopes(granted: string | null): readonly string[] {
  const set = new Set((granted ?? '').split(/\s+/).filter(Boolean));
  return REQUIRED_SCOPES.filter((s) => !set.has(s));
}
```

A mailbox with missing scopes is `DISCONNECTED` with
`statusMessage = 'Reconnect required: missing permission to <x>'`. This is how we
distinguish **needs re-consent** from **revoked**, which the schema comment on
`grantedScopes` calls for and which produce different UI copy: one says
"Reconnect to grant sending permission", the other "Access was revoked in your
Google account".

### 4.2 Verification reality for a real deployment

Both requested scopes are **restricted** under Google's API user-data policy —
`gmail.readonly` most acutely. The practical consequences, stated so nobody
plans a launch around a wrong assumption:

- An unverified app is capped at **100 distinct users** and shows an
  "unverified app" interstitial that a fair share of users abandon.
- Publishing requires OAuth brand verification **plus** a CASA security
  assessment for restricted Gmail scopes, performed by a third-party assessor.
  Budget weeks-to-months and a recurring annual cost; it is not a form.
- Google Workspace customers can skip all of that by marking the app **internal**
  to their tenant, or by having an admin domain-install it. For a
  self-hosted/single-tenant deployment this is the realistic path and should be
  the documented one.
- `testing`-mode refresh tokens expire after **7 days**. Every dev-mode mailbox
  disconnects weekly. This is not a bug in our token handling, and the
  disconnect UI should link to a docs note saying so — otherwise it gets
  "fixed" repeatedly by successive developers.

Design consequence: nothing in the send or sync path may assume a long-lived
refresh token. The `invalid_grant` path (§4.8) is a **routine** operation in
development, not an exceptional one, and is exercised by a test rather than
discovered in production.

### 4.3 The signed, single-use, short-TTL `state`

Brief §6 mandates it. Concretely:

```ts
// src/modules/mailboxes/oauth-state.ts
import 'server-only';

type StatePayload = {
  readonly v: 1;
  readonly workspaceId: string;
  readonly userId: string;
  /** 128-bit random. The single-use key. */
  readonly nonce: string;
  /** Set on reconnect: the mailbox this flow must land on. */
  readonly emailAccountId?: string;
  /** Where to send the user afterwards. Validated as a same-origin path. */
  readonly returnTo?: string;
  readonly iat: number;
  readonly exp: number;      // iat + 600 seconds
};

/** base64url(json) + '.' + base64url(HMAC-SHA256(AUTH_SECRET, json)) */
export function signState(p: Omit<StatePayload, 'v' | 'iat' | 'exp' | 'nonce'>): {
  readonly state: string;
  readonly nonce: string;
};

export type StateVerdict =
  | { readonly ok: true; readonly payload: StatePayload }
  | { readonly ok: false; readonly reason: 'malformed' | 'bad_signature' | 'expired' | 'replayed' };

export function verifyState(state: string): StateVerdict;
```

Details that matter:

- **HMAC-SHA256 with `AUTH_SECRET`**, compared with `crypto.timingSafeEqual`. A
  `===` on a MAC is a timing oracle; it is also the kind of line that survives
  review because it looks fine.
- **10-minute TTL.** Long enough for a slow consent screen, short enough that a
  state leaked into a browser history or a referrer header is inert.
- **Single use is enforced server-side**, not by a cookie. The `nonce` is
  inserted into a small table on start and deleted on callback:

  ```sql
  -- Migration SQL (not a Prisma model: it is infrastructure, not domain data,
  -- and it is swept by MAINTENANCE).
  CREATE TABLE "OAuthState" (
    nonce       TEXT        PRIMARY KEY,
    "workspaceId" TEXT      NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState" ("expiresAt");
  ```

  The callback runs `DELETE FROM "OAuthState" WHERE nonce = $1 RETURNING nonce`.
  Zero rows ⇒ `replayed` ⇒ 400. A cookie-based nonce fails in the case that
  actually happens: the user starts the flow in one browser and finishes in
  another, or Safari drops the cookie on the cross-site return. Server-side
  state is one small table and no third-party-cookie exposure.

  **This table is the only new database object this document requires.** It is
  not tenant data (it holds no mail, no lead, no credential) and it is
  deliberately not a Prisma model, so no repo can accidentally join it. §18.3
  flags it for the schema owner.

### 4.4 Start route

```
GET /api/oauth/google/start?returnTo=/mailboxes[&emailAccountId=<id>]
```

```
1. requireSession()                    → 401 → redirect to /login
2. requireRole(ADMIN|OWNER)            → MEMBER cannot connect a mailbox
3. rateLimit('oauth.start', workspaceId, 10/hour)      ← brief §6
4. zod-parse returnTo: must match /^\/(?!\/)/ (same-origin path, no protocol,
   no protocol-relative //evil.com). An open redirect here would be a
   phishing primitive.
5. if emailAccountId: load it in-workspace; 404 if absent (brief §4.5 — never
   a 403). Capture its email as loginHint.
6. { state, nonce } = signState({ workspaceId, userId, emailAccountId, returnTo })
   INSERT INTO "OAuthState" (nonce, workspaceId, expiresAt = now() + 10 min)
7. url = getProviderByKind('GMAIL').getAuthorizationUrl({
     state, redirectUri: env.GOOGLE_REDIRECT_URI, loginHint,
   })
8. audit('mailbox.oauth.started'); log 'mailbox.oauth.started'
9. 302 → url
```

The authorization URL Gmail builds:

```
https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=<GOOGLE_CLIENT_ID>
  &redirect_uri=<GOOGLE_REDIRECT_URI>
  &response_type=code
  &scope=https://www.googleapis.com/auth/gmail.send%20https://www.googleapis.com/auth/gmail.readonly
  &access_type=offline          ← REQUIRED: without it there is no refresh token
                                  and the mailbox dies in one hour
  &prompt=consent               ← REQUIRED: forces a refresh token even when the
                                  user already granted these scopes
  &include_granted_scopes=true  ← preserves scopes granted to us previously
  &state=<signed state>
  &login_hint=<mailbox email>   ← only on reconnect
```

`prompt=consent` is the one people omit. Google issues a refresh token **only on
the first authorization** for a given client/user/scope set. Without
`prompt=consent`, a user who reconnects gets `tokens.refresh_token === undefined`,
we store nothing, and the mailbox works for exactly one hour before failing in a
way that looks like a token-refresh bug. The cost is that the consent screen is
shown every time, which is the correct trade for a mailbox-connect action anyway
— the user should see what they are granting.

We do **not** send `prompt=select_account` in addition; `login_hint` already
pre-selects the account on reconnect without suppressing the consent screen.

### 4.5 Callback route

```
GET /api/oauth/google/callback?code=…&state=…&scope=…
   (or ?error=access_denied&state=…)
```

```
 1. zod-parse the query. Unknown shape → 400, log 'mailbox.oauth.callback_failed'
    { reason: 'malformed' }. No detail to the client.
 2. verifyState(state). !ok → 400 with a generic message. Reason is LOGGED, not
    rendered — 'replayed' is a security signal and telling an attacker which
    check failed is free intelligence.
 3. If `error` is present (user pressed Cancel): 302 to
    `${returnTo}?mailbox=cancelled`. No row is created. This is the common case,
    not an error case, and must not surface a red banner.
 4. Re-resolve the session and assert `session.workspaceId === payload.workspaceId`.
    The signed state is not sufficient on its own: the user may have switched
    workspaces in another tab between start and callback. Mismatch → 400.
 5. provider.exchangeCode({ code, redirectUri: env.GOOGLE_REDIRECT_URI })
    Failure → 400, status stays whatever it was, log
    'mailbox.oauth.callback_failed' { reason: 'exchange_failed', status }.
 6. Assert scopes: missingScopes(creds.grantedScopes) must be empty. If not,
    do NOT create the mailbox — 302 to `${returnTo}?mailbox=missing_scopes`
    with the scope names. A half-permissioned mailbox that appears connected and
    then fails at send time is the worse outcome.
 7. profile = provider.getProfile({ accessToken: creds.accessToken })
    `profile.email` is the identity. NOT `login_hint`, which is a client-supplied
    hint, and not the state payload.
 8. Reconnect check: existing = findByWorkspaceAndEmail(workspaceId, profile.email)
    → see §4.6 for the four cases.
 9. Encrypt and persist in ONE transaction:
      encryptedRefreshToken = encryptSecret(creds.refreshToken)   (§5 of 09)
      encryptedAccessToken  = encryptSecret(creds.accessToken)
      accessTokenExpiresAt  = creds.accessTokenExpiresAt
      encryptionKeyVersion  = <current>
      grantedScopes         = creds.grantedScopes
      providerAccountId     = profile.email
      status                = CONNECTING
      SyncState: { status: IDLE, historyId: profile.cursor.historyId,
                   backfillAfter: now() - 30 days }
10. Enqueue, in the same transaction (the whole point of a Postgres queue):
      MAILBOX_BACKFILL      dedupeKey "MAILBOX_BACKFILL:<id>"
      MAILBOX_RENEW_WATCH   dedupeKey "MAILBOX_RENEW_WATCH:<id>:initial"
11. audit('mailbox.connected'); log 'mailbox.connected'
12. 302 → `${returnTo}?mailbox=connected`
```

Step 9 captures `profile.cursor` **before** the backfill runs, from step 7's
`getProfile`. Anything arriving during the backfill is then covered by the first
delta sync. Capturing the cursor after the backfill instead loses every message
that arrived while it ran — a silent gap, invisible until a customer asks why a
reply never appeared.

`backfillAfter = now() - 30 days` is a deliberate default, not a limit we are
shy about: importing years of a real mailbox costs enormous quota and stores mail
the product has no use for. It is configurable per mailbox at connect time.

### 4.6 Reconnecting an already-connected mailbox

Four cases, all of which happen:

| Case | Behaviour |
|---|---|
| No row for `(workspaceId, profile.email)` | Create. The normal path. |
| Row exists, `DISCONNECTED` / `ERROR` | **Update in place**, do not create a second row. Replace credentials, `status = ACTIVE` if `backfillCompletedAt` is set (the mailbox already has history) else `CONNECTING`, clear `statusMessage`, zero `consecutiveFailures`. **Keep `SyncState.historyId`** if the disconnect was recent; if `fetchChanges` later returns `cursor_expired`, that path handles it. Do not wipe threads or messages — the user reconnected the same mailbox, and re-backfilling gigabytes because a token lapsed is user-hostile. |
| Row exists and `ACTIVE` | Idempotent refresh of credentials. Redirect with `?mailbox=already_connected`. Not an error: users click "Connect" to fix an imagined problem, and the correct response is a working mailbox and a calm message. |
| Row exists with `deletedAt` set (soft-deleted) | Revive: clear `deletedAt`, replace credentials, `status = CONNECTING`, re-enqueue backfill. The schema soft-deletes mailboxes precisely so the `EmailEvent` history survives; reviving reattaches to it. |
| A `(workspaceId, email)` row exists but the OAuth landed on a **different** Google account | Detected because `profile.email` differs from the reconnect target's email. Do **not** repoint the existing row — its threads, sends, and events belong to the old address. Create/update the row for `profile.email` and redirect with `?mailbox=different_account&expected=…&got=…`. Silently repointing a mailbox row at a different mailbox would misattribute every future reply. |

The `@@unique([workspaceId, email])` constraint is what makes all of this safe:
the reconnect path is an upsert on that key, and a race between two concurrent
connect flows resolves as a 23505 that the second flow treats as "already
connected".

### 4.7 Disconnect

```ts
// modules/mailboxes/index.ts
export async function disconnectMailbox(
  ctx: Ctx,
  input: { readonly emailAccountId: string; readonly reason: 'user' | 'revoked' | 'policy' },
): Promise<Result<void, MailboxError>>;
```

Order matters:

```
1. Provider-side revoke FIRST (best-effort, 5s timeout). Failure is logged at
   warn and does not abort: the user asked to disconnect, and leaving our
   ciphertext in place because Google was slow is the wrong failure mode.
2. In one transaction:
     status = DISCONNECTED, statusMessage = <reason copy>
     encryptedRefreshToken = null, encryptedAccessToken = null,
     accessTokenExpiresAt = null, grantedScopes = null
     SyncState: watchExpiresAt = null, status = IDLE
     Cancel PENDING/RETRYING jobs for this mailbox
       (MAILBOX_SYNC, MAILBOX_BACKFILL, MAILBOX_RENEW_WATCH → CANCELLED)
     Cancel SCHEDULED ScheduledEmail rows for this mailbox
       → state = CANCELLED, cancelledReason = NO_ELIGIBLE_MAILBOX
3. unwatch() best-effort, after the commit (it needs an access token we have
   just destroyed, so it runs on the token we held in memory, or not at all).
4. audit('mailbox.disconnected', { reason }); log 'mailbox.disconnected'.
```

Threads, messages, and events are **kept**. Analytics must not change because a
mailbox was disconnected, and `EmailEvent` is append-only by database grant
anyway.

Note the step-2 cancellation of scheduled sends: a campaign whose only mailbox
is disconnected must not leave rows sitting in `SCHEDULED` that fire the moment
somebody reconnects three weeks later. `cancelledReason = NO_ELIGIBLE_MAILBOX`
is an existing `EnrollmentStopReason` member, which is why that column is typed
with that enum.

---

## 5. Token handling

### 5.1 What is stored where

All on `EmailAccount`, columns that already exist:

| Column | Contents |
|---|---|
| `encryptedRefreshToken` | AES-256-GCM ciphertext of the refresh token. Long-lived. |
| `encryptedAccessToken` | AES-256-GCM ciphertext of the current access token. Cached to avoid a refresh round trip on every send. |
| `accessTokenExpiresAt` | `timestamptz`. Absolute expiry as reported by Google. |
| `encryptionKeyVersion` | Which `ENCRYPTION_KEY` encrypted these. Default 1. |
| `grantedScopes` | Space-separated granted scopes. |

The schema comment on `encryptedRefreshToken` says the envelope is
**`base64(iv ‖ ciphertext ‖ authTag)`** in a `String` column. `09` §4.2 shows a
`Bytes` column laid out `iv(12) ‖ tag(16) ‖ ct` on a `MailboxCredential` model
that does not exist in the schema. **The schema wins** — see §18.2. So:

```ts
// src/lib/crypto.ts — canonical, matching prisma/schema.prisma
import 'server-only';

/** base64( iv(12) ‖ ciphertext(n) ‖ authTag(16) ) */
export function encryptSecret(plaintext: string): { ciphertext: string; keyVersion: number };
export function decryptSecret(ciphertext: string, keyVersion: number): string;
```

Implementation notes that are not optional:

- `iv` is 12 random bytes per encryption, from `crypto.randomBytes`. **Never
  reused** — GCM nonce reuse under one key is a catastrophic break, not a
  weakness.
- The auth tag is verified by `decipher.final()`. A tag mismatch throws; it is
  never caught and downgraded to "token invalid", because a tag mismatch means
  the ciphertext or the key is wrong (a botched rotation), and treating it as a
  Google problem sends the operator hunting in the wrong place. It surfaces as
  `CredentialDecryptError`, which sets `status = ERROR`, not `DISCONNECTED`.
- The keyring is assembled once at boot from `ENCRYPTION_KEY` +
  `ENCRYPTION_KEY_PREVIOUS` per `09` §4.2. An unknown `keyVersion` throws
  `CredentialKeyMissingError` loudly.

### 5.2 Access-token caching with expiry skew

```ts
// src/modules/mailboxes/tokens.ts
const EXPIRY_SKEW_MS = 120_000;   // 2 minutes

function isUsable(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS;
}
```

Two minutes, not thirty seconds: a Gmail send can take several seconds, worker
clocks drift, and a token that expires mid-call produces a 401 whose retry costs
more than refreshing slightly early. Google's tokens last ~3600s, so a 2-minute
skew wastes ~3% of token lifetime — a rounding error against the cost of the
failure it prevents.

### 5.3 Single-flight refresh

The stampede is real: `WORKER_CONCURRENCY=4` workers plus a web request can hit
one mailbox with an expired token in the same second. Five concurrent
`refreshAuth` calls give five different access tokens, four of which get written
and then overwritten, and Google counts all five against the mailbox's token
endpoint quota.

Two layers, because in-process alone is insufficient with a multi-process
deployment (web + worker are separate processes, per brief §5):

**Layer 1 — in-process coalescing.** One promise per mailbox id:

```ts
const inflight = new Map<string, Promise<ProviderAuth>>();

export async function getAuth(ctx: Ctx, emailAccountId: string): Promise<ProviderAuth> {
  const row = await repo.getCredentials(ctx, emailAccountId);   // status + ciphertexts

  if (row.status === 'DISCONNECTED') throw new MailboxDisconnectedError(emailAccountId);

  if (row.encryptedAccessToken && isUsable(row.accessTokenExpiresAt)) {
    return { accessToken: decryptSecret(row.encryptedAccessToken, row.encryptionKeyVersion) };
  }

  const existing = inflight.get(emailAccountId);
  if (existing) return existing;                       // coalesce

  const p = refreshWithLock(ctx, emailAccountId).finally(() => inflight.delete(emailAccountId));
  inflight.set(emailAccountId, p);
  return p;
}
```

**Layer 2 — a Postgres advisory lock across processes.** No new table, no Redis:

```ts
async function refreshWithLock(ctx: Ctx, emailAccountId: string): Promise<ProviderAuth> {
  return db.$transaction(async (tx) => {
    // Transaction-scoped: released automatically on COMMIT/ROLLBACK, including
    // a crash. `pg_advisory_lock` (session-scoped) would leak on a killed worker.
    const key = hashToBigInt(`mailbox-token:${emailAccountId}`);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;

    // Re-read INSIDE the lock: the winner of the race already refreshed.
    const row = await repo.getCredentialsTx(tx, ctx, emailAccountId);
    if (row.encryptedAccessToken && isUsable(row.accessTokenExpiresAt)) {
      return { accessToken: decryptSecret(row.encryptedAccessToken, row.encryptionKeyVersion) };
    }
    if (!row.encryptedRefreshToken) throw new MailboxDisconnectedError(emailAccountId);

    const refreshToken = decryptSecret(row.encryptedRefreshToken, row.encryptionKeyVersion);
    const provider = getProvider(row);

    let fresh: RefreshedCredentials;
    try {
      fresh = await provider.refreshAuth({ refreshToken });
    } catch (err) {
      if (err instanceof ProviderAuthRevoked) {
        await markDisconnected(tx, ctx, emailAccountId, err);   // §5.5
        throw new MailboxDisconnectedError(emailAccountId, { cause: err });
      }
      throw err;                                                // retryable
    }

    await repo.storeAccessTokenTx(tx, ctx, emailAccountId, {
      encryptedAccessToken: encryptSecret(fresh.accessToken).ciphertext,
      accessTokenExpiresAt: fresh.accessTokenExpiresAt,
      // Google does not rotate refresh tokens; Microsoft does (§16.1).
      ...(fresh.rotatedRefreshToken
        ? { encryptedRefreshToken: encryptSecret(fresh.rotatedRefreshToken).ciphertext }
        : {}),
      encryptionKeyVersion: currentKeyVersion(),
      consecutiveFailures: 0,
      lastErrorAt: null,
    });

    log.info({ event: 'mailbox.token.refreshed', emailAccountId });
    return { accessToken: fresh.accessToken };
  }, { timeout: 20_000 });
}
```

The two subtleties, both of which are bugs if missed:

1. **Re-read inside the lock.** Without it the lock serialises the refreshes but
   does not prevent them — every waiter still calls Google, just politely one at
   a time. The re-read is what turns N refreshes into 1.
2. **`pg_advisory_xact_lock`, not `pg_advisory_lock`.** The transaction-scoped
   variant releases on commit, rollback, and connection death. The session-scoped
   one leaks on a `SIGKILL`ed worker and permanently wedges that mailbox's
   refresh — a failure that looks exactly like Google being down.

A holder crash mid-refresh is safe: the transaction rolls back, the lock
releases, the next caller re-reads, finds no usable token, and refreshes. At
worst one wasted Google call.

### 5.4 The `invalid_grant` path

Google returns HTTP 400 with `{"error": "invalid_grant"}` for a refresh token
that is dead. The causes are not distinguishable from the response:

- the user revoked access at myaccount.google.com/permissions;
- the Workspace admin revoked the app or suspended the account;
- the password changed (Google invalidates Gmail-scope grants);
- the token was unused for 6 months;
- the app is still in `testing` publishing status and 7 days elapsed (§4.2);
- >100 outstanding refresh tokens for one client/user pair, oldest silently
  invalidated.

Because we cannot tell which, there is exactly one correct response: **stop
retrying, mark the mailbox disconnected, tell the user.** Retrying `invalid_grant`
is pure waste; it will never succeed, and a retry loop on it is the classic way
to burn quota and hide the real problem for a week.

```ts
// gmail-errors.ts
if (status === 400 && body.error === 'invalid_grant') {
  return new ProviderAuthRevoked('gmail.invalid_grant', {
    disconnectMailbox: true,
    retryable: false,
    detail: body.error_description ?? null,   // e.g. "Token has been expired or revoked."
  });
}
```

`markDisconnected` does exactly what §4.7 step 2 does, minus the provider-side
revoke (pointless — the grant is already gone), plus:

```
status         = DISCONNECTED
statusMessage  = 'Google revoked access. Reconnect this mailbox to resume sending.'
lastErrorAt    = now()
encryptedAccessToken = null, accessTokenExpiresAt = null
encryptedRefreshToken IS KEPT until the user reconnects or deletes the mailbox
```

Keeping the dead ciphertext is intentional: it is the evidence that this mailbox
was connected with a specific key version, and it makes the "reconnect" flow an
update rather than a create. It is unusable to an attacker without
`ENCRYPTION_KEY`, and `getAuth` refuses to use it because `status` gates the
call before any decryption happens.

### 5.5 Surfacing it in the UI

Non-negotiable, per brief §8 ("every async surface ships five states" plus
*disconnected*):

- `/mailboxes` list: the row shows a `Disconnected` badge — text **and** icon,
  never colour alone (brief §7 a11y) — with a `Reconnect` button linking to
  `/api/oauth/google/start?emailAccountId=<id>`.
- Global: the app shell renders a dismissible banner when any mailbox in the
  workspace is `DISCONNECTED`, because the user's next question is "why did my
  campaign stop" and the answer should not require navigating to find it.
- Campaign detail: a campaign whose mailboxes are all disconnected shows
  `Paused — no sending mailbox available`, with the affected mailboxes named.
- Any `ScheduledEmail` that fails a pre-send guard for this reason is
  `CANCELLED` with `cancelledReason = NO_ELIGIBLE_MAILBOX`, so the enrollment
  timeline says why rather than going quiet.
- One notification email to the workspace owners, **rate-limited to one per
  mailbox per 24h**. A disconnect that generates an email per queued send is
  how a product teaches its users to filter its notifications.

### 5.6 Plaintext tokens: the containment rules

Six rules, each with an enforcement mechanism rather than a good intention:

1. `tokens.ts`, `crypto.ts`, `provider-registry.ts`, and `providers/*.ts` all
   start with `import 'server-only'`. A client component importing any of them
   is a **build** failure.
2. `repo.ts` exposes two distinct read shapes. `getCredentials` (returns
   ciphertext) is called only from `tokens.ts`. `getMailboxView` returns the
   safe projection and is what every other caller — every page, every action,
   every list — receives:

   ```ts
   export type MailboxView = {
     id: string; email: string; fromName: string | null; provider: EmailProvider;
     status: EmailAccountStatus; statusMessage: string | null;
     dailySendLimit: number; timezone: string; healthScore: number;
     sentCount: number; bouncedCount: number; repliedCount: number;
     lastSentAt: Date | null; lastSyncedAt: Date | null;
     throttledUntil: Date | null; needsReconsent: boolean;
     // NO encrypted* fields. NO accessTokenExpiresAt. NO grantedScopes string.
   };
   ```

   `modules/mailboxes/index.ts` exports `MailboxView` and **not** the Prisma
   `EmailAccount` type. A server component cannot leak what it cannot name.
3. A plaintext token exists only as a local `const` inside a `tokens.ts`
   function and as a `ProviderAuth.accessToken` for the duration of one provider
   call. It is never stored on an object that outlives the call, never put on a
   class field, and never returned from a module's public API.
4. The logger's redaction deny-list (`09` §5.1) already covers `accessToken`,
   `refreshToken`, `token`, `ciphertext`. Add `encryptedRefreshToken`,
   `encryptedAccessToken`, and `authorization`. A unit test asserts a log line
   containing a synthetic token value comes out redacted at any nesting depth.
5. Provider errors are wrapped before they are logged. `googleapis` errors carry
   `config.headers.Authorization` on the error object; logging a caught Gmail
   error verbatim writes a bearer token to stdout. `gmail-errors.ts` constructs
   a fresh `ProviderError` with an explicit field list — `status`, `reason`,
   `message` — and **never** attaches the original error as `cause` on a path
   that reaches the logger. There is a test for this that asserts the serialised
   error contains no `Bearer `.
6. `AuditLog.metadata` for `mailbox.connected` records
   `{ email, grantedScopeCount, keyVersion }` — never the scope string with a
   token-shaped value, never the ciphertext.

---

## 6. Sending

### 6.1 RFC 5322 construction

We build the raw message ourselves rather than using Gmail's JSON message
object, for three reasons: the JSON path cannot set arbitrary headers
(`List-Unsubscribe` is not optional for us), raw MIME is what SMTP and IMAP need
in phase 11 so the builder is reused verbatim, and `preservesCustomHeaders` —
which reconciliation strategy B depends on — only holds on the raw path.

`gmail-mime.ts` is pure: `(OutboundMessage) => string`. No I/O, no clock beyond
an injected `now`, so its ~40 test cases are fast and exhaustive.

The structure for a tracked HTML email with an attachment:

```
multipart/mixed; boundary="mix-<random>"
├── multipart/alternative; boundary="alt-<random>"
│   ├── text/plain;  charset="UTF-8"; Content-Transfer-Encoding: quoted-printable
│   └── text/html;   charset="UTF-8"; Content-Transfer-Encoding: quoted-printable
└── application/pdf; name="proposal.pdf"   (base64, Content-Disposition: attachment)
```

With no attachments the `multipart/mixed` wrapper is omitted and the top level is
`multipart/alternative`. An unnecessary `mixed` wrapper is a mild spam signal and
some clients render it as "this message has an attachment" when it does not.

`text/plain` is **mandatory**. `SequenceStepVariant.bodyText` is a non-null
column and its schema comment says why: an HTML-only cold email is a spam signal.
The MIME builder throws on an empty `bodyText` rather than generating one, because
auto-stripping HTML produces the link-soup plaintext that spam filters recognise.

### 6.2 Header block

```
From: =?UTF-8?B?SsO2cmc=?= <jorg@acme.com>
To: recipient@example.com
Reply-To: replies@acme.com                    (only when mailbox.replyToEmail set)
Subject: =?UTF-8?B?...?=                       (RFC 2047 when non-ASCII)
Message-ID: <clh7x9k2q0000abcd1234@acme.com>   ← OURS, generated pre-send
Date: Sun, 31 Aug 2026 09:14:02 +0000          (RFC 5322, always +0000)
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="alt-a1b2c3d4e5f6"
In-Reply-To: <parent@acme.com>                 (follow-ups only)
References: <root@acme.com> <parent@acme.com>  (follow-ups only, oldest first)
List-Unsubscribe: <https://app.example.com/api/u/AbC…>, <mailto:unsub@acme.com?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
X-IM-Send-Token: <opaque 128-bit, per ScheduledEmail>
X-IM-Workspace: <sha256(workspaceId)[0..16]>
```

Rules, each with a reason:

**UTF-8 encoding (RFC 2047).** Headers are 7-bit. Any header value with a byte
> 0x7F is encoded `=?UTF-8?B?<base64>?=`. This applies to `Subject` and to the
display name in `From` — a display name is encoded, the address never is.
Encoded words are folded at 75 characters **on encoded-word boundaries**, never
mid-word; splitting inside a base64 encoded word produces mojibake in most
clients. Q-encoding is not implemented: B-encoding is correct for all inputs and
one code path beats two.

**Address formatting.** `Display Name <addr@host>`. A display name containing
`"`, `\`, `,`, `:`, `;`, or `<` is quoted-string escaped **before** any RFC 2047
consideration. An unescaped `,` in a display name splits one recipient into two —
a real and easily-triggered header injection.

**Header injection defence.** Every header value is rejected if it contains
`\r` or `\n` after decoding. `mailbox.fromName` is user-supplied, arrives from a
form, and a `\r\nBcc: attacker@evil.com` in it turns our send into an open relay.
zod strips control characters at the input boundary; the MIME builder **also**
throws on them. Two independent checks, because this one is unrecoverable if it
gets through.

**`Date` is always `+0000`.** UTC per brief §9, formatted per RFC 5322
(`ddd, DD MMM YYYY HH:mm:ss +0000` with C-locale month and day names). A
localised month name is a malformed date header.

**`Message-ID` domain.** The domain part is the mailbox's own domain, taken from
`EmailAccount.email`. A Message-ID whose domain does not match the sending
domain is a mild spam signal and confuses DMARC alignment debugging. The local
part is the `ScheduledEmail.id` (a cuid — already unguessable and unique), so the
header is reproducible from the row with no extra column: `<{se.id}@{domain}>`.

**`Bcc` is never sent.** The schema has `bccEmails` for inbound parsing.
Outbound campaign sends are one-recipient-per-message by design — a `Bcc` list is
how a cold email tool leaks a customer's entire lead list.

### 6.3 base64url and the size ceiling

```ts
const raw = Buffer.from(mime, 'utf8').toString('base64url');
```

Gmail requires base64**url** (`-`/`_`, no `=` padding), not standard base64.
`Buffer`'s `'base64url'` encoding does this natively; hand-rolled
`.replace(/\+/g, '-')` chains are where the padding bug lives.

Size: Gmail's limit is 35 MB on the raw upload; the practical limit for the
simple (non-resumable) `messages.send` path is **~25 MB** of assembled MIME, and
base64 inflates by 4/3, so the pre-encoding ceiling is
`capabilities.maxRawMessageBytes = 25 MB`. The builder checks the assembled
length and throws a **permanent** (non-retryable) error above it. Retrying a
too-large message five times with exponential backoff, as a generic retry policy
would, is pure waste — the message will never shrink.

### 6.4 Threading

Follow-ups must land in the same conversation as step 1, or the recipient sees
four unrelated emails and the reply rate collapses. Gmail needs both signals to
agree:

```
1. threadId in the send request  → Gmail's own conversation grouping
2. In-Reply-To + References      → RFC threading, for every OTHER client that
                                   will ever see this thread (the recipient's)
```

Gmail additionally requires that the **subject match** the thread's subject, or
it silently starts a new conversation despite a valid `threadId`. Hence the
schema's note that an empty `SequenceStepVariant.subject` means "reply in thread
with no new subject": at materialisation, an empty subject is filled with
`Re: <thread subject>`. Sending a *different* subject with a `threadId` is the
single most common cause of "why did my follow-up start a new thread".

Where the values come from — all existing columns, no new ones:

| `OutboundMessage` field | Source |
|---|---|
| `providerThreadId` | `ScheduledEmail.providerThreadId`, copied at materialisation from `CampaignLead.primaryThread.providerThreadId` |
| `inReplyTo` | `ScheduledEmail.inReplyToMessageId` — the `rfcMessageId` of the most recent message in the thread (ours or theirs) |
| `references` | `ScheduledEmail.referencesHeader` — space-separated, oldest first, angle brackets included |

`References` chain construction, and the cap that matters:

```
new References = parent.References ++ [parent.Message-ID]
```

If the assembled chain exceeds **~900 bytes**, keep the **first** id (the thread
root — what every client uses for grouping) and the **last 8** (the recent
context), dropping the middle. Unbounded growth eventually exceeds the 998-byte
line limit of RFC 5322 and gets the header truncated or the message rejected
mid-sequence — which breaks threading at exactly step 5 or 6, where a long
sequence's remaining value lives.

After step 1 sends, the `SendResult.providerThreadId` is written to
`ScheduledEmail.providerThreadId`, an `EmailThread` row is created with that
`providerThreadId`, and `CampaignLead.primaryThreadId` points at it. Steps 2..n
read from there. `Campaign.threadFollowUps = false` skips all of this: each step
is a fresh message with no `In-Reply-To`, no `References`, no `threadId`.

### 6.5 `List-Unsubscribe` and one-click

Two headers, both required on every campaign send. RFC 8058 one-click is
effectively mandatory for bulk senders at Gmail and Yahoo, and its absence is a
deliverability problem, not a compliance nicety.

```
List-Unsubscribe: <https://app.example.com/api/u/<token>>, <mailto:unsub@…?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

- `<token>` is an HMAC-SHA256 of `{scheduledEmailId, leadId}` under `AUTH_SECRET`,
  base64url, truncated to 32 chars, with the ids carried alongside. Unguessable
  and not enumerable. It is **not** a signed blob containing the ids —
  `TrackingLink`'s schema comment makes the same point for click tracking, and
  the reasoning is identical: a recipient can forward that URL.
- `/api/u/[token]` accepts **both** `GET` and `POST`. `POST` (with
  `List-Unsubscribe=One-Click` in the body) is what mail clients send and it
  unsubscribes immediately with a 200. `GET` renders a confirmation page for a
  human who clicked a link in the footer.
- Brief §6 forbids state-changing GETs, and a mail client's link prefetcher would
  otherwise unsubscribe recipients who never clicked. The `GET` therefore only
  **renders**; the page's button POSTs. The `POST` route is exempt from the
  origin check because it arrives cross-origin from a mail provider — the HMAC
  token is its authentication, which is why the token must be per-send.
- Effect: `Suppression` row `(workspaceId, EMAIL, <address>)` with
  `reason = UNSUBSCRIBED`, `EmailEvent` `UNSUBSCRIBED` with
  `dedupeKey = unsub:{leadId}:{campaignId}` (`08` §1.3), `Lead.status = UNSUBSCRIBED`,
  and the enrollment stops with `stopReason = UNSUBSCRIBED`. Plus-addressing is
  stripped when writing the `Suppression.value`, per that column's comment.
- `Auto-Submitted` is **not** set on campaign mail. `Auto-Submitted: auto-generated`
  tells the receiving system this is machine mail and suppresses vacation
  auto-replies — but an out-of-office reply is a signal we want (it distinguishes
  "away" from "not interested"), and marking cold outreach as auto-generated is a
  deliverability negative. It **is** set on warmup traffic
  (`ScheduledEmailKind.WARMUP`), which genuinely is machine-to-machine.

### 6.6 Correlation headers

```
X-IM-Send-Token: <128-bit random, base64url>
X-IM-Workspace:  <sha256(workspaceId) truncated to 16 hex chars>
```

`X-IM-Send-Token` is reconciliation strategy B's match key (`06` §6.4). Gmail
preserves unknown `X-` headers, so after a network error of unknown outcome we can
scan the Sent folder and identify our own message even if the `Message-ID` was
rewritten.

**Conflict to resolve:** `06` §6.4 reads this token as `se.sendToken`, and
`ScheduledEmail` has no `sendToken` column. Rather than add one, derive it —
it must be reproducible from the row, and a random column would need to be
written before the send anyway:

```ts
export function sendToken(se: { id: string }): string {
  return base64url(hmacSha256(env.AUTH_SECRET, `send-token:v1:${se.id}`)).slice(0, 22);
}
```

Deterministic, reproducible during reconciliation, unguessable without
`AUTH_SECRET`, and zero schema change. §18.4 flags the `06` reference.

`X-IM-Workspace` is hashed, not the raw id: outbound headers are visible to the
recipient, and leaking a tenant identifier into every email is needless.

No header carries a lead id, a campaign id, or an email address beyond the
envelope. `ScheduledEmail.id` in `Message-ID` is a cuid with no embedded meaning,
which is why it is safe there.

### 6.7 The exact Gmail send call

```ts
// providers/gmail.ts
async send(auth: ProviderAuth, msg: OutboundMessage): Promise<SendResult> {
  const gmail = this.client(auth);
  const mime  = buildRfc5322(msg);                    // gmail-mime.ts, pure

  if (Buffer.byteLength(mime, 'utf8') > this.capabilities.maxRawMessageBytes) {
    throw new ProviderPermanentError('gmail.message_too_large', {
      bytes: Buffer.byteLength(mime, 'utf8'),
    });
  }

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: Buffer.from(mime, 'utf8').toString('base64url'),
      // Present only for follow-ups. Gmail ignores an unknown/foreign threadId
      // by starting a new thread rather than erroring, which is why the
      // subject-match rule in §6.4 is load-bearing.
      ...(msg.providerThreadId ? { threadId: msg.providerThreadId } : {}),
    },
  });

  if (!res.data.id) throw new ProviderTransientError('gmail.send_no_id');

  // Read back the stored Message-ID: Gmail does not guarantee it preserves ours.
  // One extra metadata GET = 5 quota units. Worth it — it is what tells us
  // whether reconciliation strategy A is trustworthy for this mailbox.
  let observedMessageId: string | null = null;
  try {
    const meta = await gmail.users.messages.get({
      userId: 'me', id: res.data.id, format: 'metadata',
      metadataHeaders: ['Message-ID'],
    });
    observedMessageId = headerValue(meta.data, 'Message-ID');
  } catch {
    // Non-fatal: the send SUCCEEDED. Losing the read-back only costs us
    // certainty about fidelity, and must never turn a delivered email into a
    // reported failure.
  }

  return {
    providerMessageId: res.data.id,
    providerThreadId:  res.data.threadId ?? null,
    observedMessageId,
    sentAt: new Date(),
  };
}
```

The `catch {}` on the read-back is deliberate and is the one place in this
document where swallowing an error is correct: the email has already been sent.
Any exception thrown after `messages.send` returns 200 would be classified by the
caller as a send failure and retried, producing the duplicate the entire
`ScheduledEmail` state machine exists to prevent.

### 6.8 What the caller persists

On success, in one transaction (`06` owns this write):

```ts
// ScheduledEmail
state             = 'SENT'
sentAt            = result.sentAt
providerMessageId = result.providerMessageId
providerThreadId  = result.providerThreadId
// rfcMessageId was written BEFORE the send. Never overwritten with
// observedMessageId — our value is the one in the References chain of every
// follow-up we have already materialised.

// EmailEvent (append, ON CONFLICT DO NOTHING)
type = 'SENT', dedupeKey = `sent:${se.id}`, occurredAt = result.sentAt
+ every denormalised dimension: campaignId, campaignLeadId, sequenceStepId,
  variantId, leadId, emailAccountId, scheduledEmailId, threadId

// EmailAccount / MailboxDailyStat
sentCount++, lastSentAt = now(), consecutiveFailures = 0
MailboxDailyStat(emailAccountId, localDate).sentCount++    // or warmupCount

// EmailThread + EmailMessage: created/upserted for the OUTBOUND copy so the
// thread appears in the inbox immediately rather than after the next sync.
// The `@@unique([emailAccountId, providerMessageId])` makes the later sync of
// the same message an upsert, so there is no duplicate.
```

If `observedMessageId !== msg.messageId`, log `send.messageid_rewritten` once per
mailbox per day and record the fidelity downgrade so `reconcile.ts` prefers
strategy B for that mailbox (`06` §6.3). Since `EmailAccount` has no column for
this, the marker is a `WARN`-level log plus an in-process per-mailbox cache with a
24h TTL — deliberately not persisted, because it is an optimisation hint and a
wrong hint costs one extra bounded search, not a wrong send.

---

## 7. Incremental sync

### 7.1 The two phases, and why the cursor is captured first

```
CONNECT
  │  getProfile() → cursor H0        ← captured BEFORE any reading
  ├─ SyncState { status: IDLE, historyId: H0, backfillAfter: now()-30d }
  │
  ├─ MAILBOX_BACKFILL  (status: BACKFILLING)
  │    fetchBackfillPage(after=backfillAfter, pageToken) → ids
  │    → fetchMessage each → upsert EmailThread + EmailMessage
  │    → persist backfillPageToken after EVERY page (resumable)
  │    → last page: backfillCompletedAt = now(), status = INCREMENTAL,
  │                 EmailAccount.status  = CONNECTING → ACTIVE
  │
  └─ MAILBOX_SYNC  (status: INCREMENTAL), from H0 onwards
       fetchChanges(cursor) → changes + nextCursor + nextPageToken
       → process changes
       → advance cursor ONLY when nextPageToken === null
```

`H0` is captured at connect time, before the backfill reads anything, and the
delta sync starts from `H0` — so mail arriving *during* a backfill that takes
twenty minutes is picked up by the first delta rather than falling into a gap
between the two phases. Capturing the cursor when the backfill *finishes* is the
natural-looking implementation and it loses mail silently.

`EmailAccount.status` stays `CONNECTING` throughout the backfill, and the schema
comment on `CONNECTING` says it is not eligible to send. That is right: sending
before we have the mailbox's history means a reply to an earlier conversation is
not recognised as a reply, and we keep emailing someone who already answered.

### 7.2 Gmail history delta

```ts
// providers/gmail.ts
async fetchChanges(auth, cursor, opts): Promise<FetchChangesResult> {
  if (cursor.kind !== 'gmail-history') throw new ProviderPermanentError('gmail.bad_cursor');

  try {
    const res = await this.client(auth).users.history.list({
      userId: 'me',
      startHistoryId: cursor.historyId,
      historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved'],
      maxResults: opts.maxResults ?? 500,
      pageToken: opts.pageToken,
    });

    return {
      kind: 'ok',
      changes: flattenHistory(res.data.history ?? []),
      // Gmail returns the NEW high-water mark on every page. It is only safe to
      // persist after the final page.
      nextCursor: { kind: 'gmail-history', historyId: String(res.data.historyId ?? cursor.historyId) },
      nextPageToken: res.data.nextPageToken ?? null,
    };
  } catch (err) {
    if (statusOf(err) === 404) {
      const fresh = await this.getProfile(auth);          // current historyId
      return { kind: 'cursor_expired', currentCursor: fresh.cursor };
    }
    throw classifyGmailError(err);
  }
}
```

Two Gmail behaviours the implementation must respect:

- **`startHistoryId` is inclusive-ish and duplicates are normal.** The same
  `messageAdded` can appear across pages and across calls. Dedup is not optional;
  it is the design (§7.4).
- **`historyTypes` narrows the response but not the quota.** We omit
  `messageDeleted` deliberately: a message deleted in Gmail stays in our store.
  Deleting our copy would destroy the reply that stopped a sequence and the
  `EmailEvent` chain that references it. The inbox shows it; Gmail no longer does.
  That divergence is correct and is stated in the UI as "Instant Mail keeps its
  own copy".

### 7.3 The 404-expired-historyId recovery path

Gmail expires a `historyId` after roughly **a week**, and immediately if the
mailbox has churned enough. The 404 is not an error condition — it is a normal
outcome for a mailbox that was disconnected for eight days, and for every dev
mailbox after a weekend.

```
fetchChanges → { kind: 'cursor_expired', currentCursor: Hn }
      │
      ├─ SyncState.status = CURSOR_EXPIRED
      │  SyncState.historyId = Hn                    ← the fresh anchor, first
      │  SyncState.backfillAfter = max(lastSyncCompletedAt - 1 day,
      │                                now() - 30 days)
      │  SyncState.backfillPageToken = null
      │
      ├─ enqueue MAILBOX_BACKFILL
      │    dedupeKey "MAILBOX_BACKFILL:<id>:recover:<Hn>"
      │
      └─ on completion: status = INCREMENTAL, resume delta from Hn
```

Three decisions here:

1. **Write the fresh cursor before the re-backfill starts**, same reasoning as
   §7.1. If the recovery backfill crashes halfway, the next delta still runs from
   `Hn` and the resumable `backfillPageToken` finishes the rest.
2. **The re-backfill is bounded**, not a full re-import. `lastSyncCompletedAt - 1 day`
   overlaps the known-good window by a day to absorb clock skew and the
   inclusive-boundary ambiguity. `now() - 30 days` is the floor so a mailbox
   disconnected for a year does not trigger a year-long import.
3. **`CURSOR_EXPIRED` is not an error status.** The mailbox stays sendable
   (`EmailAccount.status` untouched) because the credentials are fine. It is a
   sync-lag condition, and the mailbox page says "catching up" rather than showing
   a failure the user cannot act on.

The `@@index([status, watchExpiresAt])` on `SyncState` serves the sweeper that
finds mailboxes stuck in `CURSOR_EXPIRED` with no in-flight backfill job.

### 7.4 Dedup: why re-processing is free

Three independent layers, and each catches a different failure:

| Layer | Mechanism | Catches |
|---|---|---|
| Push delivery | `WebhookEvent.providerEventId` is globally `@unique`; insert with `ON CONFLICT DO NOTHING` | Pub/Sub at-least-once redelivery. A second push for the same message id is a no-op insert and no job is enqueued. |
| Job enqueue | `Job.dedupeKey` `@unique` — `MAILBOX_SYNC:<emailAccountId>:<historyId>` | Ten pushes in one minute for one mailbox collapse to one sync job, because they carry the same `historyId`. |
| Message store | `EmailMessage.@@unique([emailAccountId, providerMessageId])` — every write is an upsert | Everything else: duplicate history entries, an overlapping re-backfill, a replayed job. Re-running a whole sync is idempotent by construction. |

The third layer is the one that makes the design safe rather than merely tidy. It
means correctness does not depend on getting the first two right, and it is why
the recovery path in §7.3 can re-scan an overlapping window without a moment's
thought about duplicates.

Inbound processing is separately guarded: `PROCESS_INBOUND_MESSAGE` has
`dedupeKey = PROCESS_INBOUND_MESSAGE:<emailMessageId>`, and the `REPLIED`
`EmailEvent` uses `dedupeKey = replied:{providerMessageId}` (`08` §1.3) — so even
a message processed twice cannot count as two replies or stop a sequence twice.

### 7.5 Fetch strategy per change

```
messageAdded
  ├─ EmailMessage exists for (emailAccountId, providerMessageId)?  → skip
  └─ fetchMessage(format=full) → parse → upsert thread + message
       └─ direction INBOUND && from != mailbox.email
            → enqueue PROCESS_INBOUND_MESSAGE   (07 owns the handler)

labelAdded / labelRemoved
  └─ UPDATE EmailMessage.labels only. No re-fetch: a label change is 1 quota
     unit of information and a full message GET is 5 units of bytes we have.
     SPAM/TRASH additions also set EmailThread.isSpam / isArchived.
```

`fetchMessage` uses `format: 'full'` and parses the MIME tree in the provider.
`format: 'raw'` would hand us the original bytes and let us reuse a real MIME
parser, which is tempting, but it costs meaningfully more quota per message and
Gmail's `full` payload tree already gives decoded parts. Body extraction order:

```
1. Walk the part tree depth-first, collecting the FIRST text/plain and the FIRST
   text/html not marked Content-Disposition: attachment.
2. multipart/alternative: prefer html for bodyHtml, plain for bodyText, keep both.
3. Neither found (e.g. a bare application/pdf, or a malformed part tree):
   bodyText = snippet, bodyHtml = null.  Never throw — an unparseable message
   must still land in the inbox, because a message we cannot parse is often
   exactly the bounce we need to see.
4. message/rfc822 sub-parts (forwards, DSN originals) are NOT recursed into for
   the body, but ARE scanned by dsn.ts for bounce attribution (§9.2).
```

Rule 3 is the honest one. A parser that throws on weird MIME loses mail; one
that falls back to the snippet loses fidelity on a small number of messages.
Fidelity is the cheaper loss.

### 7.6 Pub/Sub push setup

One-time Google Cloud setup, documented because it is easy to get subtly wrong
and the failure mode is total silence:

```
1. Create topic:          projects/<project>/topics/instant-mail-gmail
2. Grant Gmail publish:   gmail-api-push@system.gserviceaccount.com
                          → roles/pubsub.publisher on that topic
   ← THE step people miss. Without it users.watch returns 400
     "User not authorized to perform this action" and the message names
     neither Pub/Sub nor the missing role.
3. Push subscription →    https://<APP_URL>/api/webhooks/gmail?token=<GMAIL_PUBSUB_VERIFICATION_TOKEN>
   ack deadline 60s, retry policy exponential 10s→600s,
   dead-letter topic after 10 attempts.
4. Per mailbox:           users.watch { topicName, labelIds: ['INBOX'],
                                        labelFilterBehavior: 'include' }
```

`labelIds: ['INBOX']` narrows notifications to inbox arrivals. Watching all
labels means a notification for every one of our own sends (they land in SENT),
which doubles push volume for zero information — we already know what we sent.

`watch` returns `{ historyId, expiration }` → `SyncState.watchExpiresAt`. **The
watch expires in 7 days maximum** and Gmail does not warn. `MAILBOX_RENEW_WATCH`
runs daily per mailbox and re-watches when `watchExpiresAt < now() + 48h`.
Re-watching early is free and idempotent; letting one lapse means a mailbox goes
quiet with no error anywhere, which is the worst kind of outage.

### 7.7 Webhook verification and handling

```
POST /api/webhooks/gmail?token=<GMAIL_PUBSUB_VERIFICATION_TOKEN>
{ "message": { "data": "<base64>", "messageId": "...", "publishTime": "..." },
  "subscription": "projects/.../subscriptions/..." }

decoded data: { "emailAddress": "user@acme.com", "historyId": 1234567 }
```

```
 1. timingSafeEqual(query.token, env.GMAIL_PUBSUB_VERIFICATION_TOKEN)
    Mismatch → 403, log 'webhook.rejected' { reason: 'bad_token' }. No body read.
 2. zod-parse the envelope. Malformed → 400. Brief §6: an unauthenticated
    payload is DATA, never instructions.
 3. INSERT WebhookEvent { provider: GMAIL, providerEventId: message.messageId,
                          payload: <decoded>, state: RECEIVED }
    ON CONFLICT (providerEventId) DO NOTHING
    → conflict means a redelivery: return 204 immediately, do nothing else.
 4. Resolve the mailbox by EmailAccount.providerAccountId = decoded.emailAddress
    (indexed: @@index([providerAccountId])).
    Ambiguity is possible and expected: two workspaces may connect the same
    shared mailbox (@@unique([workspaceId, email]) permits it). Enqueue a sync
    for EVERY matching non-deleted, non-DISCONNECTED mailbox.
    Zero matches → state = UNMATCHED, workspaceId stays null, return 204.
 5. For each: enqueue MAILBOX_SYNC
      dedupeKey "MAILBOX_SYNC:<emailAccountId>:<historyId>"
    WebhookEvent.state = PROCESSED, processedAt = now()
 6. Return 204 — ALWAYS, unless auth failed.
```

Step 6 is the rule that keeps push working. Pub/Sub retries any non-2xx with
exponential backoff and eventually dead-letters, so returning 500 because our
database was briefly unavailable converts a transient blip into a redelivery
storm. We acknowledge receipt, having durably recorded the payload, and do the
work in the queue. That is the entire reason `WebhookEvent` exists as a table
rather than the route doing the sync inline.

Note the shared-mailbox case in step 4. `providerAccountId` is indexed but not
unique, and the schema deliberately allows two workspaces to connect the same
address. A `findFirst` here would silently starve one tenant's sync — a
cross-tenant bug that no isolation test would catch, because it under-delivers
rather than leaking.

### 7.8 Polling fallback

Push is an optimisation. **Polling is the guarantee.** Push is unavailable
whenever `GMAIL_PUBSUB_TOPIC` is unset (all local dev, all CI), the app runs
without a public HTTPS URL, the topic IAM binding is wrong, or a watch has
lapsed. If sync depended on push, local development would have no working inbox
at all.

```
MAILBOX_SYNC is enqueued by THREE independent triggers:
  1. a verified push notification                          (seconds)
  2. a periodic tick per ACTIVE/PAUSED/THROTTLED mailbox    (see cadence)
  3. an operator pressing "Sync now"                        (rate-limited 1/min)
```

Cadence, from `SyncState.watchExpiresAt`:

| Condition | Interval |
|---|---|
| Watch live (`watchExpiresAt > now()`) | 15 minutes — a safety net against a missed push, not the primary path |
| No watch / push unconfigured | 2 minutes |
| `consecutiveFailures > 0` | exponential backoff from 2 min, capped at 60 min |
| `EmailAccount.status = DISCONNECTED` | no polling at all |

Two minutes is the floor. An empty 2-minute tick costs **2 quota units**
(`history.list`) plus 5 per new message, against a budget of 15,000 units per
user per minute (§8) — negligible. Anything faster is latency theatre for a
product whose units of work are minutes to days apart, per brief §5.

The three triggers all collapse through `Job.dedupeKey`
`MAILBOX_SYNC:<emailAccountId>:<historyId>`, so a push and a poll arriving
together produce one sync, not two.

---

## 8. Quotas and rate limits

Gmail enforces **three unrelated limits**, and conflating them produces a system
that respects the one it measures and trips the two it does not.

### 8.1 API quota units (per-project, per-user-per-minute)

| Limit | Value |
|---|---|
| Per-project | 1,200,000 quota units / minute |
| **Per end user** | **15,000 quota units / minute** |

Units by method (the ones we call):

| Method | Units | Where used |
|---|---|---|
| `users.getProfile` | 1 | connect, cursor capture |
| `users.history.list` | 2 | every delta sync |
| `users.messages.list` | 5 | backfill, reconciliation |
| `users.messages.get` | 5 | every message fetch, send read-back |
| `users.messages.send` | **100** | every send |
| `users.watch` / `stop` | 100 / 50 | daily watch renewal |
| `users.messages.modify` | 5 | not used in v1 (no `gmail.modify` scope) |

Real budget arithmetic for the busiest realistic mailbox — 50 sends/day (our
default `dailySendLimit`), 200 inbound messages/day, 2-minute polling:

```
sends            50 × (100 send + 5 read-back)   =  5,250
inbound fetch   200 ×   5                        =  1,000
delta polls     720 ×   2                        =  1,440
watch renewal     1 × 100                        =    100
                                            total ≈  7,790 units/DAY
```

Against 15,000 units per **minute**, daily usage is under a single minute's
allowance. The per-user API quota is not a constraint for this product and we
should not build machinery to manage it. What *can* trip it is a burst: an
unbounded backfill fetching messages in parallel. Hence:

**Backfill concurrency is capped at 5 concurrent `messages.get` per mailbox**,
and a backfill page is 100 ids. `5 × 5 = 25` units in flight — three orders of
magnitude under the limit, and slow enough that a 10,000-message backfill takes
minutes rather than melting a shared quota.

### 8.2 Sending limits — the ones that actually bite

These are **not API quota** and are invisible to every API response until you
exceed them:

| Account type | Recipients / day |
|---|---|
| gmail.com (consumer) | ~500 |
| Workspace (most tiers) | ~2,000 |
| Workspace, per-message recipient cap | ~100 (irrelevant to us — one recipient per send) |

Plus **undocumented, unqueryable per-minute throttles** and rolling-window
enforcement rather than a midnight reset. Google publishes no API to read your
current usage.

Our position, stated plainly: **`EmailAccount.dailySendLimit` defaults to 50, and
that is a deliverability decision, not a quota decision.** 50/day/mailbox is far
below Gmail's 500 because a cold-outreach mailbox sending 400 messages a day gets
reputational damage long before Gmail refuses it. The schema comment on that
column says exactly this. Gmail's cap is a wall we should never see.

Enforcement is `06`'s (`MailboxDailyStat.sentCount` checked inside the claiming
transaction, `minSecondsBetweenSends` + `sendJitterSeconds` for pacing). This
document owns only the reaction when Gmail says no anyway:

```
403 reason=userRateLimitExceeded  →  a burst tripped a per-minute throttle.
                                     Retryable. THROTTLED for 15 min.
429 rateLimitExceeded             →  same treatment.
403 reason=quotaExceeded          →  the DAILY cap. Not retryable today.
                                     → EmailAccount.status = THROTTLED
                                     → throttledUntil = start of tomorrow in
                                       EmailAccount.timezone
                                     → MailboxDailyStat.sentCount = dailySendLimit
                                       so the scheduler stops selecting it
                                     → deliverability alert
```

Writing `sentCount = dailySendLimit` is the important move. Without it the
scheduler keeps offering sends, each one fails, each burns a retry, and the
dead-letter queue fills with identical failures. The pre-send guard should stop
the work before a provider call happens, and the counter is what the guard reads.

`@@index([status, throttledUntil])` on `EmailAccount` exists to serve the
scheduler's "which mailboxes may send now" scan, which is why `throttledUntil` is
the right place for this rather than a bespoke table.

### 8.3 Backoff with jitter

`06` §7.1 owns the shared policy. Provider-specific inputs:

```ts
export type RetryHint = {
  readonly retryable: boolean;
  /** From a `Retry-After` header when present, else our own floor. */
  readonly retryAfterMs?: number;
  /** Suppress the whole mailbox, not just this job. */
  readonly throttleMailboxMs?: number;
};
```

| Condition | First retry | Policy |
|---|---|---|
| 429 / `userRateLimitExceeded` | 30 s | full jitter, cap 15 min, 5 attempts |
| 5xx `backendError` | 5 s | full jitter, cap 5 min, 5 attempts |
| Network error, unknown outcome | 60 s | **reconcile before attempt 2** (`06` §6.4) |
| `quotaExceeded` (daily) | next local day | not a retry — mailbox throttled |
| `invalid_grant` | never | terminal, disconnect |

**Full jitter**, `random(0, min(cap, base × 2^attempt))`, not
`base × 2^attempt ± 10%`. With N workers hitting one throttled mailbox, decorrelated
jitter is what breaks the synchronised retry wave; a narrow jitter band keeps the
herd together and re-trips the same throttle.

Gmail's 429 rarely carries `Retry-After`. When absent, use the table floor rather
than retrying immediately.

---

## 9. Bounce and failure detection

### 9.1 What Gmail's API does and does not tell us

**Does not:**

- No delivery confirmation. No webhook, no per-message status, no callback. This
  is why `capabilities.reportsDeliveryConfirmation` is `false` and why
  `EmailEventType.DELIVERED` is near-unused for Gmail (the schema comment on that
  member says so).
- No bounce notification API. Nothing pushes a bounce to us.
- No complaint/spam-report feed. Gmail Postmaster Tools reports domain-level
  aggregates, not per-message events, and needs separate DNS-verified setup. We
  do not integrate it in v1 and therefore **`EmailEventType.COMPLAINED` is only
  ever written from an explicit unsubscribe-with-complaint or a manual mark**,
  never inferred.
- Nothing about inbox vs spam placement at the recipient's end. Ever. (`08` §7.2.)

**Does:**

- A `202`/`200` from `messages.send` means Gmail **accepted** the message for
  delivery. Not delivered. Accepted.
- Bounces arrive as **ordinary inbound email** from `mailer-daemon@` or
  `postmaster@`, which our normal sync picks up like any other message. That is
  the entire bounce pipeline: there is no special channel.
- Synchronous 400s for a syntactically invalid recipient — caught before send,
  and a different thing from a bounce.

Consequence: **bounce detection latency is sync latency.** A DSN arriving 4 hours
after the send is detected on the next sync after it arrives, not 4 hours after we
sent. A soft bounce that the receiving server retries for 3 days produces a DSN 3
days later. Any UI implying real-time bounce reporting would be lying.

### 9.2 DSN parsing

```ts
// providers/dsn.ts  — pure, unit-tested against real captured DSNs
export type ParsedDsn = {
  readonly bounceType: BounceType;                  // Prisma enum
  /** e.g. "5.1.1". Null when unparseable → bounceType UNKNOWN. */
  readonly statusCode: string | null;
  readonly diagnosticCode: string | null;           // the remote server's text
  /** The address that ACTUALLY bounced — from the report, never the DSN's From. */
  readonly bouncedRecipient: string | null;
  /** Message-ID of OUR original, from the attached message/rfc822 part. The
   *  attribution key: it joins straight to ScheduledEmail.rfcMessageId. */
  readonly originalMessageId: string | null;
  readonly reportingMta: string | null;
};

export function parseDsn(msg: RawMimeView): ParsedDsn | null;
```

Detection, in order — a message is a DSN if **any** matches:

```
1. Content-Type: multipart/report; report-type=delivery-status   ← the real signal
2. From matches /^(mailer-daemon|postmaster)@/i
3. Subject matches /^(undelivered mail returned|delivery status notification|
                     mail delivery failed|returned mail|undeliverable)/i
4. An X-Failed-Recipients header is present                       (Gmail sets this)
```

Signal 1 is authoritative; 2–4 catch non-conforming senders. All four are needed:
plenty of real MTAs send a `text/plain` bounce with no report part at all.

Extraction from a conforming `multipart/report`:

```
part 2  message/delivery-status
  ├─ Reporting-MTA: dns; mx.example.com
  └─ per-recipient block:
       Final-Recipient: rfc822; nobody@example.com     → bouncedRecipient
       Action: failed
       Status: 5.1.1                                   → statusCode
       Diagnostic-Code: smtp; 550 5.1.1 User unknown   → diagnosticCode
part 3  message/rfc822 (or text/rfc822-headers)
  └─ Message-ID: <our-original@acme.com>               → originalMessageId
```

Fallbacks when there is no report part, applied in order:

```
1. X-Failed-Recipients header                    → bouncedRecipient
2. /\b([45]\.\d{1,3}\.\d{1,3})\b/ in the body    → statusCode
3. /\b(5\d{2}|4\d{2})[ -]/ in the body           → coarse class only
4. Any email address in the body that is NOT ours and NOT mailer-daemon
   → bouncedRecipient (last resort, low confidence)
```

**Why `bouncedRecipient` is a separate column, and the trap it avoids:** the DSN's
`From` is `mailer-daemon@example.com`. Attributing the bounce to *that* address
suppresses `mailer-daemon@example.com` and leaves the actually-dead lead in
rotation to bounce again tomorrow. The schema comment on `bouncedRecipient` calls
this "the whole trick to bounce attribution", and it is. The address must come
from `Final-Recipient` or `X-Failed-Recipients`, never from the envelope.

### 9.3 Hard vs soft

```ts
export function classifyBounce(status: string | null, diagnostic: string | null): BounceType {
  if (status) {
    const [cls, sub] = status.split('.');            // '5.7.1' -> cls '5', sub '7'
    if (cls === '5') {
      // 5.2.2 mailbox full and 5.2.3 message too large are PERMANENT codes for a
      // TEMPORARY condition. Suppressing the address is wrong.
      if (status === '5.2.2' || status === '5.2.3') return 'SOFT';
      if (sub === '7') return 'BLOCKED';                     // 5.7.x = policy/reputation
      return 'HARD';
    }
    if (cls === '4') return 'SOFT';
  }
  if (!diagnostic) return 'UNKNOWN';
  if (BLOCKED_RE.test(diagnostic)) return 'BLOCKED';
  if (HARD_RE.test(diagnostic))    return 'HARD';
  if (SOFT_RE.test(diagnostic))    return 'SOFT';
  return 'UNKNOWN';                        // recognised as a DSN, code unreadable
}

const BLOCKED_RE =
  /\b(spam|blocked|blacklist|blocklist|policy|reputation|rejected due to|rbl|spamhaus|5\.7\.\d)\b/i;
const HARD_RE =
  /\b(user unknown|no such user|does not exist|invalid recipient|unknown recipient|address rejected|recipient not found|no mailbox)\b/i;
const SOFT_RE =
  /\b(mailbox full|over quota|quota exceeded|try again later|temporarily deferred|greylisted?)\b/i;
```

`BLOCKED` earns its own enum member (and the schema comment agrees) because the
correct response differs entirely from `HARD`:

| Type | Address | Enrollment | Deliverability |
|---|---|---|---|
| `HARD` | `Suppression` row, `reason = HARD_BOUNCE`; `Lead.status = BOUNCED` | stop, `HARD_BOUNCE` | counts toward bounce rate |
| `SOFT` | **no suppression** | stop only at the Nth soft bounce, `SOFT_BOUNCE_LIMIT` | tracked, weighted lower |
| `BLOCKED` | **no suppression** — the address is fine, *we* are the problem | stop, `HARD_BOUNCE` (conservative) | **the loud signal**: our reputation or auth is broken; alerts and the mailbox health score |
| `UNKNOWN` | no suppression | stop, `HARD_BOUNCE` | flagged for review; the DSN excerpt is kept in `EmailMessage.headers` |

Suppressing an address because our own IP is blocklisted would permanently
destroy the lead list over a problem that is fixed by a DNS record. That is the
whole reason `BLOCKED` exists as a distinct type.

The soft-bounce threshold is **3 across all campaigns for that lead**, counted
from `EmailEvent` where `type = BOUNCED` and `metadata->>'bounceType' = 'SOFT'`.
Then `SOFT_BOUNCE_LIMIT`. Three consecutive "mailbox full" results over a
sequence means the mailbox is abandoned, whatever the code says.

### 9.4 Mapping to `EmailEvent`

```
inbound message classified BOUNCE
  │
  ├─ EmailMessage: classification = BOUNCE, bounceType, bounceCode,
  │                bouncedRecipient
  │
  ├─ attribute to the original send:
  │     A. dsn.originalMessageId → ScheduledEmail.rfcMessageId  (indexed) ← primary
  │     B. dsn.bouncedRecipient  → ScheduledEmail.toEmail, same mailbox,
  │        state = SENT, sentAt within 14 days, most recent            ← fallback
  │     C. neither → keep the message, classification BOUNCE, NO EmailEvent.
  │        An unattributed bounce is visible in the inbox and counted in the
  │        mailbox's raw bounce total, but it cannot corrupt a campaign metric.
  │
  ├─ ScheduledEmail.state = SENT → BOUNCED
  │
  ├─ EmailEvent {
  │     type: BOUNCED,
  │     dedupeKey: `bounced:${scheduledEmailId}`,      ← FIRST DSN WINS (08 §1.3)
  │     occurredAt: dsn message sentAt,                ← when it bounced, not now
  │     metadata: { bounceType, code: statusCode,
  │                 diagnostic: diagnosticCode?.slice(0, 500) },
  │     + all denormalised dimensions from the ScheduledEmail
  │   }
  │
  ├─ HARD → Suppression + Lead.status = BOUNCED
  ├─ CampaignLead.state = BOUNCED, stopReason per §9.3
  └─ MailboxDailyStat.bouncedCount++, EmailAccount.bouncedCount++
```

Path C is the honest choice. Real mailboxes receive DSNs for mail we never sent
(backscatter, forwarding loops, spoofed bounces). Forcing every DSN onto some
campaign to keep a number tidy would corrupt the fact log, and `EmailEvent` is
append-only precisely so that cannot be repaired later.

The `dedupeKey` is per `scheduledEmailId`, not per DSN message: one failed
delivery commonly generates several reports (the sending MTA, an intermediate
relay, a final retry-exhausted notice). They are one bounce. `08` §1.3 already
specifies this — "first DSN wins".

---

## 10. Open and click tracking

### 10.1 Mechanics

**Open pixel.** A 1×1 transparent GIF appended immediately before `</body>` of
`bodyHtml` at materialisation, when `Campaign.trackOpens` is true:

```html
<img src="https://app.example.com/api/track/open/<token>" width="1" height="1"
     alt="" style="display:block;border:0;outline:none" />
```

`<token>` is an HMAC-SHA256 of `scheduledEmailId` under `AUTH_SECRET`, base64url,
32 chars — per `08` §7.1. Unguessable and non-enumerable, so a curious recipient
cannot walk the space and register opens for other people's mail.

`/api/track/open/[token]`:

```
1. Verify the HMAC → resolve scheduledEmailId. Invalid → serve the GIF anyway.
   A 404 here renders a broken-image icon in a real person's email client; the
   correct response to a bad token is a valid pixel and a log line.
2. Serve the 43-byte GIF with:
     Cache-Control: no-store, no-cache, must-revalidate, private
     Pragma: no-cache
   Without no-store, a corporate proxy caches the pixel and the second open is
   never seen.
3. Fire-and-forget: enqueue the EmailEvent write. NEVER block the response on a
   database write — a slow pixel visibly stalls image loading in the client.
4. EmailEvent { type: OPENED, dedupeKey: `opened:{seId}:{minute}`,
                userAgent, ipAddress, isBot: looksLikeBot(...) }
```

`isFirstForSend` is set on the first `OPENED` for that `scheduledEmailId`, which
is what makes unique-open rates a filtered `COUNT` rather than a `DISTINCT` over
the largest table in the system.

**Link rewriting.** Every `href` in `bodyHtml` is replaced at materialisation when
`Campaign.trackClicks` is true:

```
<a href="https://acme.com/pricing">  →  <a href="https://app.example.com/api/track/click/<token>">
```

One `TrackingLink` row per rewritten link per send: `token` (globally unique and
random — its schema comment explains that the redirect endpoint has no session,
so the token *is* the lookup key), `scheduledEmailId`, `originalUrl`.

`/api/track/click/[token]`:

```
1. Look up TrackingLink by token. Not found → 302 to the app's home page, not a
   404. A recipient clicking a link from a purged send should land somewhere real.
2. 302 to originalUrl.
3. Fire-and-forget: TrackingLink.clickCount++, firstClickAt/lastClickAt,
   EmailEvent { type: CLICKED, dedupeKey: `clicked:{seId}:{sha256(url)[0..16]}:{minute}`,
                metadata: { url } }
```

Excluded from rewriting, and each exclusion is there because of a specific
failure: the `List-Unsubscribe` URL (breaking one-click unsubscribe is a
compliance and deliverability problem), `mailto:` and `tel:` links, anchors
(`#…`), and anything already pointing at our own tracking host (double-rewriting
on a re-materialise produces an infinite redirect).

`originalUrl` is validated as `http`/`https` before storage, and the redirect
sends `Referrer-Policy: no-referrer`. Without validation the endpoint is an open
redirect that also proxies `javascript:` URIs — a stored-XSS vector wearing a
tracking-link costume.

### 10.2 Why open rates are unreliable — the honesty section

Brief §10 requires this, and it is not boilerplate. **The open rate is the most
trusted and least trustworthy number in cold email.** Every mechanism below is
active in normal conditions, and they pull in opposite directions, so the error
is not even a consistent bias we could correct for.

| Mechanism | Direction | Detail |
|---|---|---|
| **Apple Mail Privacy Protection** | **inflates** | Default-on since iOS 15. Proxies and **pre-fetches every remote image on arrival**, whether or not the human opens it. Every APMP recipient registers an "open". Apple Mail is roughly half of consumer opens. |
| **Gmail image proxy** | inflates + distorts | All images route through `googleusercontent.com`. Requests can be prefetched, and the IP and UA are Google's, so geo and device data are fiction. |
| **Corporate security appliances** | inflates | Proofpoint, Mimecast, Barracuda fetch every URL and image to sandbox them. Often within seconds of delivery. |
| **Images blocked by default** | **deflates** | Outlook desktop, many corporate clients, most people who read in the preview pane. A genuine, engaged read registers nothing. |
| **Plain-text readers** | deflates | Never load the pixel. Also disproportionately technical audiences. |
| **Forwarding** | misattributes | A forwarded email's opens count against the original recipient — three "opens" from one lead who forwarded it to two colleagues. |
| **Caching proxies** | deflates repeats | The second and third open never reach us. |
| **The pixel itself** | reduces delivery | A remote image plus a rewritten link domain is a mild spam signal. Tracking makes the number you are measuring smaller. |

The one honest summary: **an open rate measures "a machine somewhere fetched an
image", and the correlation with "a human read this" is unknown and varies by
audience.** A 60% open rate on an APMP-heavy consumer list and a 20% open rate on
a corporate list can represent identical human behaviour.

Product rules, all enforced (and consistent with `08` §7.1):

1. Every open/click figure renders with the `indicative: true` marker and a
   tooltip stating the caveat. No open number appears anywhere without it.
2. **No insight or alert may fire on open rate**, and no A/B test may be decided
   on it. Reply rate is the metric we act on, because a reply is an unforgeable
   human action.
3. `EmailEvent.isBot` filters the obvious machines out of headline rates:
   a fetch within 10 seconds of `sentAt`, a known-proxy UA
   (`GoogleImageProxy`, `YahooMailProxy`, APMP ranges), a UA-less request, or a
   datacentre IP. This reduces the error; it does not remove it. Bot-flagged
   events are still stored, because an inflated number we can decompose beats a
   filtered number we cannot audit.
4. Open tracking is **off by default per campaign**, with the tradeoff stated at
   the toggle. `Workspace.trackOpensDefault` ships `true` in the schema; `08`
   §7.1 requires per-campaign opt-in. **Conflict — §18.5.**
5. Click tracking is one tier more trustworthy (a human usually clicked, though
   scanners click too) and is labelled separately rather than lumped in with
   opens.
6. We never claim inbox placement, spam rate, or a deliverability score derived
   from opens. `08` §7.2 owns that rule; nothing here may work around it.

---

## 11. Provider error taxonomy

### 11.1 The error classes

```ts
// providers/types.ts
export abstract class ProviderError extends AppError {
  abstract readonly retryable: boolean;
  /** Mailbox must be marked DISCONNECTED and the user told. */
  readonly disconnectMailbox: boolean = false;
  /** Throttle the whole mailbox for this long, not just this job. */
  readonly throttleMailboxMs?: number;
  /** Suppress the recipient address — the address itself is bad. */
  readonly suppressRecipient: boolean = false;
  /** The send may or may not have happened. Reconcile before retrying. */
  readonly outcomeUnknown: boolean = false;
  readonly providerStatus?: number;
  readonly providerReason?: string;
}

export class ProviderTransientError  extends ProviderError { retryable = true; }
export class ProviderRateLimited     extends ProviderError { retryable = true; }
export class ProviderPermanentError  extends ProviderError { retryable = false; }
/** Refresh failed but the grant may live. Retry once, then escalate. */
export class ProviderAuthFailed      extends ProviderError { retryable = true; }
/** The grant is gone. invalid_grant. Never retry. */
export class ProviderAuthRevoked     extends ProviderError {
  retryable = false; disconnectMailbox = true;
}
export class ProviderNotImplementedError extends ProviderError { retryable = false; }
export class CapabilityUnsupportedError  extends ProviderError { retryable = false; }
```

These map onto `06`'s `RetryableError` / `TerminalError` / `DeferError` at the job
boundary, in `06`'s runner. Providers throw `ProviderError` subclasses; the job
layer decides scheduling. Keeping the two vocabularies separate is what lets the
provider be tested without a queue.

### 11.2 The table

| Signal | Class | Retry | Mailbox | Notes |
|---|---|---|---|---|
| `429` | `ProviderRateLimited` | 30 s, full jitter, ×5 | `THROTTLED` 15 min | |
| `403 userRateLimitExceeded` | `ProviderRateLimited` | 30 s | `THROTTLED` 15 min | per-minute burst |
| `403 rateLimitExceeded` | `ProviderRateLimited` | 30 s | `THROTTLED` 15 min | |
| `403 quotaExceeded` | `ProviderRateLimited` | next local day | `THROTTLED` until tomorrow in mailbox tz | daily send cap (§8.2) |
| `500` / `502` / `503` / `504` | `ProviderTransientError` | 5 s, ×5 | — | |
| `401` | `ProviderAuthFailed` | refresh once in-band, then ×1 | `ERROR` after 3 consecutive | a fresh token usually fixes it |
| `400 invalid_grant` | **`ProviderAuthRevoked`** | **never** | **`DISCONNECTED`** | §5.4. The path that must not be retried. |
| missing required scope | `ProviderAuthRevoked` | never | `DISCONNECTED` + `needsReconsent` | different UI copy from revoked |
| `403 domainPolicy` | `ProviderPermanentError` | never | `DISCONNECTED` | Workspace admin blocked the app |
| `403 forbidden` on `watch` | `CapabilityUnsupportedError` | never | — | topic IAM misconfigured (§7.6 step 2); falls back to polling and alerts an operator |
| `400 Invalid To header` | `ProviderPermanentError` + `suppressRecipient` | never | — | dead lead, not a mailbox fault |
| `400` message too large | `ProviderPermanentError` | never | — | checked pre-send (§6.3) |
| `404` on `history.list` | *not an error* | — | — | `cursor_expired` (§7.3) |
| `404` on `messages.get` | *not an error* | — | — | message deleted between list and get; skip it |
| `ECONNRESET` / `ETIMEDOUT` / abort **on send** | `ProviderTransientError` + `outcomeUnknown` | 60 s, **reconcile first** | — | ⚠ the dangerous one |
| `ECONNRESET` on a read | `ProviderTransientError` | 5 s | — | reads are safely repeatable |
| unrecognised | `ProviderTransientError` | 5 s, ×3 | — | logged at `warn` with status + reason so it can be classified properly later |

### 11.3 The three that matter most

**`outcomeUnknown` on send.** A network error after the request left our process
means Gmail may have accepted the message. Treating that as "not sent" and
retrying is the single most likely way this system double-sends. The flag forces
attempt N+1 through `reconcile.ts`, and if reconciliation cannot reach a verdict
the row waits for a human (`06` §6.4). **A stuck email beats a duplicate** —
brief invariant 3 is not negotiable, and a stuck send is visible while a
duplicate is embarrassing and irreversible.

**`invalid_grant` must never be retried.** It cannot succeed. A retry loop on it
wastes quota, delays the disconnect notification the user needs, and buries the
real problem under identical dead-letter entries.

**Default is retryable.** An unrecognised error retries a bounded 3 times and is
logged for classification. The alternative — dead-lettering anything unfamiliar —
turns every new Gmail error string into a stalled campaign. Bounded retries plus
a `warn` log means an unknown error costs 3 attempts and produces the evidence
needed to classify it properly.

### 11.4 Consecutive-failure escalation

`EmailAccount.consecutiveFailures` is incremented on every provider failure and
zeroed on any success (send or sync):

```
 1-2   normal retry behaviour
 3     status = THROTTLED, throttledUntil = now() + 30 min
 5     status = ERROR, statusMessage = <last classified reason>
       → no further sends until a human acts (schema comment on ERROR)
       → notification to workspace owners
```

This is the backstop for a failure mode the per-error table cannot catch: a
mailbox failing for a reason we classified as retryable, but permanently. Without
the counter it retries forever at the cap interval, burning quota and reputation
while the campaign quietly makes no progress.

---

## 12. Outlook / Microsoft Graph mapping (phase 11)

The abstraction holds. Method-by-method:

| `MailProvider` method | Graph equivalent | Fidelity |
|---|---|---|
| `getAuthorizationUrl` | `/{tenant}/oauth2/v2.0/authorize` | Same shape. Needs `scope=offline_access Mail.Send Mail.Read User.Read` and PKCE for a public client — `AuthorizationUrl.codeVerifier` exists for this. |
| `exchangeCode` | `/{tenant}/oauth2/v2.0/token` | Same. |
| `refreshAuth` | same endpoint | **Rotates the refresh token.** `RefreshedCredentials.rotatedRefreshToken` exists for exactly this, and it must be persisted in the same transaction or the mailbox bricks on the next refresh. |
| `getProfile` | `GET /me` | `mail ?? userPrincipalName`. `cursor` requires a priming `GET /me/mailFolders/inbox/messages/delta` call. |
| `send` | `POST /me/sendMail` | **The lossy one — see below.** |
| `fetchChanges` | `/me/mailFolders/inbox/messages/delta` | Native delta with `@odata.deltaLink`/`nextLink`. Maps cleanly onto `SyncCursor.delta-token` and the `nextCursor`/`nextPageToken` split, which is *why* that split is in the interface rather than being Gmail-shaped. |
| `fetchMessage` | `GET /me/messages/{id}` | Rich JSON — easier to parse than Gmail's part tree. `internetMessageHeaders` gives the headers we keep. |
| `fetchAttachment` | `GET /me/messages/{id}/attachments/{aid}/$value` | Direct. |
| `watch` / `unwatch` | `POST /subscriptions` (webhooks) | Different verification handshake (a validation token echo) but the same lifecycle. **Max ~3 days** vs Gmail's 7, so the renewal job runs more often — a parameter, not a redesign. |
| `findByRfcMessageId` | `GET /me/messages?$filter=internetMessageId eq '<id>'` | Supported. |
| `setReadState` | `PATCH /me/messages/{id}` `{ isRead }` | Supported without an extra scope, so `supportsReadStateWriteback: true` — Graph is *more* capable than our Gmail integration here. |

**The send divergence, which the capability flags exist to expose.** Graph's
`sendMail` takes a JSON message and supports only a whitelist of headers;
`internetMessageHeaders` accepts custom headers but **only `X-` prefixed ones**.
`List-Unsubscribe` is not `X-` prefixed and cannot be set on that path.

Graph does offer `POST /me/sendMail` with `Content-Type: text/plain` carrying a
base64 MIME message, which accepts arbitrary headers and lets us reuse
`gmail-mime.ts` verbatim (renamed `rfc5322.ts` at that point — it was never
Gmail-specific). So:

```ts
readonly capabilities: ProviderCapabilities = {
  supportsThreadIds: true,          // conversationId
  supportsIncrementalSync: true,
  supportsPush: true,
  supportsLabels: true,             // categories — mapped onto EmailMessage.labels
  supportsReadStateWriteback: true, // MORE capable than our Gmail v1
  supportsMessageIdSearch: true,
  reportsDeliveryConfirmation: false,
  preservesCustomHeaders: true,     // X- only on the JSON path; all on MIME
  messageIdFidelity: 'rewritten',   // Graph assigns its own internetMessageId
  supportsArbitraryHeaders: true,   // via the MIME send path only
  maxRawMessageBytes: 4 * 1024 * 1024,   // 4MB on the simple path
};
```

`messageIdFidelity: 'rewritten'` means reconciliation uses strategy B from day
one for Outlook. The interface already carries that concept, so `reconcile.ts`
needs no change — which is the actual test of whether the abstraction holds.

`Campaign.threadFollowUps` maps to `conversationId` plus the same
`In-Reply-To`/`References` headers, so the threading logic in §6.4 is unchanged.

Not slotting in: `EmailProvider.OUTLOOK` covers Microsoft 365 / Graph. Legacy
on-premises Exchange without Graph is **SMTP/IMAP**, not `OUTLOOK`.

## 13. SMTP / IMAP mapping (phase 11)

The stress test for the abstraction, because SMTP/IMAP is missing capabilities
rather than merely spelling them differently.

| Method | SMTP/IMAP | Fidelity |
|---|---|---|
| `getAuthorizationUrl` / `exchangeCode` | **N/A** | No OAuth. Credentials come from a form: `smtpHost`, `smtpPort`, `smtpUsername`, `encryptedSmtpPassword`, `imapHost`, `imapPort` — all already on `EmailAccount`. The two methods throw `CapabilityUnsupportedError`; the connect **UI** branches on provider kind, which it must do anyway (a password form vs a redirect). |
| `refreshAuth` | no-op | Returns the stored password as the "access token" with a far-future expiry. `tokens.ts` needs no special case — the single-flight path degenerates to a cache hit. |
| `revokeAuth` | no-op | Nothing to revoke server-side. |
| `getProfile` | SMTP `EHLO` + `AUTH`, IMAP `LOGIN` + `SELECT INBOX` | A **credential validation** call. `cursor` = `{ kind: 'imap-uid', uidValidity, uidNext }` from `SELECT`. |
| `send` | `nodemailer` SMTP | **Highest fidelity of any provider.** We hand over the exact RFC 5322 bytes `gmail-mime.ts` produced. `Message-ID` is genuinely preserved ⇒ `messageIdFidelity: 'preserved'`. |
| `fetchChanges` | `UID FETCH {uidNext}:* (…)` | Works, with one hard caveat below. |
| `fetchMessage` | `UID FETCH <uid> BODY.PEEK[]` | Full raw MIME — a real parser, better fidelity than Gmail's part tree. `BODY.PEEK` not `BODY`, or fetching marks the message read. |
| `watch` / `unwatch` | **absent** | IMAP `IDLE` is a held connection, not an HTTP push. A serverless-friendly design cannot hold thousands of long-lived IMAP sockets, so `supportsPush: false` and polling is the only path. §2.8 row 2 already says what the UI shows. |
| `findByRfcMessageId` | `UID SEARCH HEADER Message-ID "<id>"` | Supported, and IMAP `SEARCH` is exact. |
| `setReadState` | `UID STORE +FLAGS (\Seen)` | Supported. |

**The `uidValidity` caveat, stated plainly:** IMAP UIDs are only meaningful within
a `uidValidity` generation. If the server changes `uidValidity` (mailbox
recreated, some server migrations), **every stored UID is meaningless** and the
only correct response is a full re-backfill. `fetchChanges` therefore returns
`{ kind: 'cursor_expired' }` when `SELECT` reports a different `uidValidity` than
the cursor holds — reusing the Gmail 404 recovery path (§7.3) exactly. Two
providers, two unrelated causes, one recovery mechanism. That reuse is the
strongest evidence the cursor abstraction is right.

```ts
readonly capabilities: ProviderCapabilities = {
  supportsThreadIds: false,          // ← the interesting one
  supportsIncrementalSync: true,     // UID-based, with the caveat above
  supportsPush: false,
  supportsLabels: true,              // IMAP folders, mapped onto `labels`
  supportsReadStateWriteback: true,
  supportsMessageIdSearch: true,
  reportsDeliveryConfirmation: false,
  preservesCustomHeaders: true,
  messageIdFidelity: 'preserved',
  supportsArbitraryHeaders: true,
  maxRawMessageBytes: 25 * 1024 * 1024,
};
```

`supportsThreadIds: false` is the capability that proves the abstraction, because
it forces a real fallback rather than a cosmetic one. `EmailThread.providerThreadId`
stays null; association uses `rootMessageId` and the `references` array — and the
schema already provides both, with a GIN index on `references` and an
`@@index([emailAccountId, rootMessageId])`, precisely so this works. The
`@@unique([emailAccountId, providerThreadId])` constraint tolerates it: Postgres
treats nulls as distinct, so many null-thread rows coexist.

SMTP also has genuinely better bounce handling available: a `Return-Path` we
control means DSNs land in a mailbox we own rather than depending on the provider
surfacing them. Out of scope for v1, but the reason `ScheduledEmail` keeps
`rfcMessageId` is that this path stays open.

---

## 14. Security

### 14.1 Credentials never reach the client

Six mechanisms, defence in depth (§5.6 has the detail):

1. `import 'server-only'` at the top of every credential-touching file — a client
   import is a build failure, not a review catch.
2. `MailboxView` is the only mailbox type crossing a module boundary. It has no
   `encrypted*` field, so a server component cannot leak what it cannot name.
3. `next.config.ts` lists `@prisma/client`, `@prisma/adapter-pg`, and `pg` in
   `serverExternalPackages` (already done per INTEGRATION-NOTES §1), so a stray
   client-side Prisma import fails at build.
4. `getProvider` is server-only; there is no provider instance in a browser bundle.
5. No Server Action returns a mailbox object; actions return
   `Result<MailboxView, E>` or `Result<void, E>`.
6. A CI grep test asserts `encryptedRefreshToken` and `encryptedAccessToken`
   appear in no file under `src/app/**` or `src/components/**`.

### 14.2 Redaction

`09` §5.1's deny-list plus, from this document: `encryptedRefreshToken`,
`encryptedAccessToken`, `smtpPassword`, `encryptedSmtpPassword`, `code`
(the OAuth authorization code), `state`, `nonce`, `raw` (a base64 MIME body is an
email body), `id_token`.

The non-obvious ones and why:

- **`code`** — an unredeemed OAuth authorization code is a credential for ~10
  minutes. Logging the callback query string leaks it.
- **`raw`** — the base64 MIME blob is the full email body, which brief §9 forbids
  logging. It is easy to log by accident because it looks like an opaque string.
- **`state` / `nonce`** — a logged, unconsumed state is a CSRF token.
- Email addresses are logged as `sha256(addr).slice(0,12)` unless the line is an
  audit record (`09` §5.1). Provider log lines therefore carry `emailAccountId`,
  never the address.
- **Gmail error objects are never logged verbatim.** `googleapis` attaches
  `config.headers.Authorization` to thrown errors; logging one writes a live
  bearer token to stdout. `gmail-errors.ts` constructs a fresh `ProviderError`
  with an explicit field list and does not attach the original as `cause` on any
  path reaching the logger. A test asserts no serialised provider error contains
  `Bearer `.

### 14.3 Scope-creep review gate

Adding an OAuth scope is a **reviewed decision with a written justification**,
not a line change, because escalating to `gmail.modify` silently grants us the
ability to delete a customer's mail.

```
1. REQUIRED_SCOPES in providers/gmail.ts is the single source of truth,
   with a comment per scope stating what needs it (§4.1).
2. A change to that array requires: the product reason, the least-privilege
   alternative considered, and the re-consent plan for existing mailboxes.
3. A unit test pins the array. Changing a scope fails the test, so the diff
   cannot pass unnoticed.
4. Adding a scope forces every connected mailbox through re-consent.
   missingScopes() (§4.1) detects it and shows "Reconnect to grant …" instead of
   failing at send time. A scope change without that migration path silently
   breaks every existing mailbox.
5. The audit log records the scope set at each connect
   (`mailbox.connected` metadata), so "when did this mailbox gain read access"
   is answerable.
```

### 14.4 Webhook and tracking endpoints

These are the only unauthenticated routes in the system, so each needs its own
reasoning:

| Endpoint | Auth | Abuse posture |
|---|---|---|
| `POST /api/webhooks/gmail` | `GMAIL_PUBSUB_VERIFICATION_TOKEN` compared with `timingSafeEqual` | Payload is data, never instructions (brief §6). Mailbox resolution is by `providerAccountId` lookup against **our** rows — a forged payload naming an unknown address becomes an `UNMATCHED` `WebhookEvent` and nothing else. It cannot cause a write to a workspace it does not name. |
| `GET /api/track/open/[token]` | HMAC token | Always returns a valid GIF. Rate-limited per IP. Worst case is a forged open event on a send whose id the attacker already knows — noise in a metric we already label as indicative. |
| `GET /api/track/click/[token]` | random token, unguessable | `originalUrl` validated `http`/`https` at write time, so it cannot be an open redirect or a `javascript:` URI. `Referrer-Policy: no-referrer`. |
| `GET/POST /api/u/[token]` | HMAC token | `POST` is exempt from the origin check (it arrives from a mail provider); the token is its authentication. `GET` only renders — a prefetcher must not be able to unsubscribe anyone. |
| `POST /api/test/fake-provider/*` | none | **404 unless `E2E_FAKE_PROVIDER=1`**, and the env schema makes that flag a boot failure in production. Two independent guards. |

The tracking endpoints deliberately leak one bit: whether a token is valid.
Making them indistinguishable would require serving a valid GIF and a plausible
redirect for every random token — which is what the open endpoint already does,
and which for the click endpoint would mean redirecting an unknown token
somewhere arbitrary. Redirecting to our home page is the honest compromise.

### 14.5 Workspace isolation in the provider layer

The provider layer is where tenancy is easiest to lose, because a provider call
has no `Ctx`:

1. Every `repo.ts` function takes `Ctx` first and filters on `ctx.workspaceId`
   (brief §4.3–4.4). `getCredentials(ctx, id)` returns null for another
   workspace's mailbox — so a cross-tenant id in a job payload yields a 404-shaped
   failure, not a token.
2. **Job payloads carry ids, and the handler re-resolves them under the job's
   `Ctx` built from `Job.workspaceId`.** A payload's `emailAccountId` is never
   trusted to belong to that workspace; the repo query proves it or fails.
3. The webhook route resolves mailboxes by `providerAccountId` across all
   workspaces **by design** (§7.7 step 4) — the payload has no workspace context.
   Every downstream enqueue then carries that mailbox's own `workspaceId`, and
   each `MAILBOX_SYNC` job runs in exactly one workspace's `Ctx`. This is the one
   place a query legitimately crosses workspaces, and it is worth stating so it
   is not "fixed" into a `findFirst` that starves a tenant.
4. `getProvider` takes only `{ provider }` — it cannot leak data because it holds
   none.
5. The tracking endpoints resolve a token to exactly one `TrackingLink` or
   `ScheduledEmail` row and use **that row's** `workspaceId` for the event write.
   They never read a workspace id from the request.

---

## 15. Deliberately not built

Called out so nobody adds them thinking they were forgotten. Each has a real cost
and no phase-2 payoff.

| Not building | Why |
|---|---|
| A provider plugin system (dynamic registration, config-driven adapters) | Three providers ever, all known. A `switch` in one file is the right amount of machinery; a registry with dynamic loading makes the seam harder to grep and harder to type. |
| Gmail batch API (`/batch` multipart) | Saves HTTP round trips, not quota units. Our quota headroom is three orders of magnitude (§8.1). It would add a bespoke multipart encoder and a partial-failure model to a path that is not slow. |
| A resumable upload path for large attachments | Cold outreach with a >25 MB attachment is a mistake we should surface, not support. `ProviderPermanentError` with a clear message is the right answer. |
| `gmail.modify` for read-state writeback | §4.1. A large scope escalation for a convenience feature, and `supportsReadStateWriteback: false` makes the gap honest. |
| Gmail Postmaster Tools integration | Domain-level aggregates on a delay, separate DNS verification, and it cannot attribute anything to a send. `08` already forbids placement claims. |
| Our own MTA / `Return-Path` control | Real bounce handling, and a months-long reputation project. Phase 11 at the earliest, via SMTP. |
| IMAP `IDLE` | Requires holding a socket per mailbox. Incompatible with the process model; polling is correct for us. |
| Draft-then-send | Two API calls, two failure windows, and a draft left behind on a crash. `messages.send` is atomic from our side. |
| Per-mailbox quota accounting for API units | §8.1 shows the headroom. Tracking it would be instrumentation for a limit we cannot approach. |
| Caching decrypted access tokens in process memory across requests | The DB read is sub-millisecond and the ciphertext is already cached there. An in-process plaintext cache adds a second invalidation path and puts plaintext tokens in a heap dump. |

## 16. Phase-2 acceptance criteria

`09` §13 lists the phase-2 gate. Restated as what this document must deliver,
each item independently checkable:

```
[ ] MailProvider interface complete; every Gmail interaction is a method on it
[ ] `googleapis` imported in exactly ONE file            (grep test)
[ ] `new GmailProvider(` appears in exactly ONE file     (grep test)
[ ] getProvider() is the only construction path          (grep test)
[ ] FakeProvider passes the same contract suite as GmailProvider
[ ] E2E_FAKE_PROVIDER=1 completes the whole OAuth round trip with no network
[ ] E2E_FAKE_PROVIDER=1 + NODE_ENV=production fails at boot
[ ] /api/test/** returns 404 when the flag is unset
[ ] crypto round-trip + key-rotation unit tests green
[ ] a plaintext refresh/access token appears in NO log line (captured-output test)
[ ] no serialised provider error contains `Bearer `
[ ] OAuth state: replay rejected, expiry rejected, tampered signature rejected
[ ] concurrent getAuth() on one mailbox triggers exactly ONE refreshAuth call
[ ] invalid_grant → DISCONNECTED, zero retries, banner visible in the UI
[ ] MIME builder: UTF-8 subject, quoted display name, CRLF injection rejected,
    text+HTML alternative, attachment, base64url output
[ ] References chain capping keeps root + last 8 and stays under 900 bytes
[ ] fetchChanges does not advance the cursor mid-pagination
[ ] cursor_expired triggers a BOUNDED re-backfill, not a full re-import
[ ] webhook: bad token 403, replay 204 + no job, unmatched → UNMATCHED row
[ ] webhook resolves ALL mailboxes sharing a providerAccountId, not just one
[ ] DSN parsing: hard / soft / blocked / unknown, and bouncedRecipient is taken
    from Final-Recipient rather than the mailer-daemon From
[ ] an unattributable DSN produces NO EmailEvent
[ ] polling works with GMAIL_PUBSUB_TOPIC unset (the local-dev default)
```

The `getAuth` single-flight test is the one worth writing carefully: fire 10
concurrent `getAuth` calls against a mailbox with an expired token and assert
`FakeProvider.refreshAuthCallCount === 1`. It is the only way to catch a
regression in §5.3, and the bug it catches is invisible in normal operation until
Google starts rate-limiting the token endpoint.

---

## 17. Conflicts for the lead engineer to resolve

Each is a real inconsistency between existing committed artifacts, not a
preference. Listed with a recommendation.

### 17.1 `EmailProvider` vs `MailProvider` (doc-only, one word)

`06-jobs-and-sending-engine.md` line 363 and line 935 call the interface
`EmailProvider`. That name is already a **Prisma enum** (`GMAIL | OUTLOOK | SMTP`),
so both cannot coexist without an import alias in every file touching both.
`09-deployment-and-testing.md` uses `MailProvider` throughout.

**Recommendation:** `MailProvider` (this doc, `09`). `06` needs the rename in two
places.

### 17.2 The credential storage shape — schema vs `09` §4.2

`09` §4.2 documents key rotation against a `MailboxCredential` model with
`ciphertext Bytes` laid out `iv(12) ‖ tag(16) ‖ ct`. **That model does not exist
in `prisma/schema.prisma`.** The schema stores credentials as columns on
`EmailAccount` (`encryptedRefreshToken String?`, `encryptedAccessToken String?`,
`encryptionKeyVersion Int`) with the envelope documented as
`base64(iv ‖ ciphertext ‖ authTag)` — a different byte order and a different type.

**Recommendation:** the schema wins; this document is written to it. Two
consequences for `09` §4.2:

1. `encryptSecret`/`decryptSecret` take and return **`string`** (base64), not
   `Buffer`, and the layout is `iv ‖ ct ‖ tag`.
2. The rotation procedure's step 3 re-encrypt loop must iterate
   **`EmailAccount` rows with two credential columns**, not `MailboxCredential`
   rows. The `WHERE keyVersion = 1` idempotency guard still works, but a mailbox
   has two ciphertexts sharing one `encryptionKeyVersion`, so both must be
   re-encrypted in the same `UPDATE` or the column no longer describes both. That
   is a real change to the documented SQL, not a rename.

An alternative — add a `MailboxCredential` model and migrate — is more schema
churn for no functional gain, and the schema's approach is fine: two nullable
columns, one version, on a row that is already loaded on the send path.

### 17.3 `OAuthState` table (new database object)

§4.3 requires a small table for single-use OAuth `state` nonces. It is not in the
schema. It is deliberately **not** a Prisma model (infrastructure, not domain
data; swept by `MAINTENANCE`) and is created in hand-written migration SQL, the
same mechanism the schema header §4 already uses for partial and GIN indexes.

**Recommendation:** schema owner adds the `CREATE TABLE` to migration SQL. If the
lead prefers a Prisma model instead, note that it needs a nullable `workspaceId`
and would become the **fourth** documented exception to the non-null-workspace
rule — the migration-SQL route avoids amending that invariant.

The alternative (a signed cookie holding the nonce) breaks in the two cases that
actually occur: finishing the flow in a different browser, and Safari dropping
the cookie on the cross-site return from Google.

### 17.4 `ScheduledEmail.sendToken` does not exist

`06` §6.4 reconciliation strategy B matches on `se.sendToken`. There is no such
column.

**Recommendation:** derive it, per §6.6 —
`base64url(hmacSha256(AUTH_SECRET, 'send-token:v1:' + se.id)).slice(0, 22)`.
Deterministic, reproducible during reconciliation, unguessable without
`AUTH_SECRET`, and no schema change. `06` needs the one-line correction.

`06` §6.3 also references `observedMessageId` as though persisted; it is a
`SendResult` field consumed in-process (§6.8), with the fidelity downgrade kept as
a logged warning plus an in-process 24h cache. If the lead wants it durable, that
is a new `EmailAccount` column (`messageIdFidelity`), which I would not add — a
wrong hint costs one extra bounded search, not a wrong send.

### 17.5 Open tracking default: schema `true` vs `08` "off by default"

`Workspace.trackOpensDefault` and `Campaign.trackOpens` both default `true` in the
schema. `08` §7.1 states open tracking is "off by default per campaign, with the
tradeoff stated at the toggle", and the brief §10 honesty rule points the same way.

**Recommendation:** change the schema defaults on `Campaign.trackOpens` and
`Workspace.trackOpensDefault` to `false`. A default that silently degrades
deliverability for a metric we label as untrustworthy is a wrong default, and this
is cheap to change now and awkward later (existing rows would need a data
migration and users would experience a behaviour change).

`trackClicks` can stay `true`: click data is meaningfully more reliable and the
deliverability cost of link rewriting is lower than a remote image.

### 17.6 `gmail.modify` is not requested — a product limitation to sign off

§4.1 requests only `gmail.send` + `gmail.readonly`. The visible consequence:
**marking a thread read or archiving it in Instant Mail does not change the
user's Gmail.** `capabilities.supportsReadStateWriteback: false` makes it honest
in the UI, but it is a real gap a user will notice, and it is a product decision
rather than a technical one.

**Recommendation:** ship v1 without `gmail.modify`. Revisit when writeback is
actually requested, at which point it needs the §14.3 scope-change process
including forced re-consent for every connected mailbox.

### 17.7 Google verification is a deployment blocker, not a code task

§4.2: both requested scopes are **restricted**. Publishing to arbitrary external
users requires OAuth brand verification plus a **CASA third-party security
assessment**, on a weeks-to-months timeline with a recurring annual cost. Until
then: a 100-user cap and an "unverified app" interstitial. In `testing` publishing
status, **refresh tokens die after 7 days**, so every dev mailbox disconnects
weekly — which is not a bug in §5.4 and should be documented at the disconnect
banner, or it will be "fixed" repeatedly.

**Recommendation:** decide the deployment model before phase 2 ends, because it
changes what "connected" means for real users. Single-tenant / internal-Workspace
deployment avoids the assessment entirely and is the realistic v1 path.
