/**
 * Demo seed — makes the app demoable the moment someone clones it.
 *
 * Run with `bun run db:seed`. Safe to run repeatedly.
 *
 * ── IDEMPOTENCY ───────────────────────────────────────────────────────────
 * Everything is upserted under a deterministic id derived from a natural key
 * (`sd_ws_acme`, `sd_lead_priya-raman`, …). Deterministic ids ARE the natural
 * keys here: they let a re-run target the same row and let a child row name its
 * parent without a lookup round trip.
 *
 * `EmailEvent` cannot participate in that scheme, and it also cannot be cleared
 * and rebuilt: migration SQL installs `EmailEvent_no_update`, a
 * `BEFORE UPDATE OR DELETE` trigger. That trigger fires on cascades too — so
 * deleting the demo Workspace, or even a Campaign (which would `SET NULL` the
 * event's `campaignId`), raises `P0001` once a single event row exists. Events
 * are therefore inserted with `createMany({ skipDuplicates: true })` against
 * their unique `dedupeKey`; the second run inserts zero rows. The keys are
 * namespaced `sd:v1:…` so that if this seed's event set is ever reshaped, the
 * stale rows are identifiable rather than silently mixed in.
 *
 * Three tables are pure joins or derived presentation with no dependents and no
 * trigger — `LeadListMembership`, `LeadTagLink`, `Activity`. Those are deleted
 * within the demo workspace and re-inserted, so removing a row from this file
 * actually removes it from the database.
 *
 * ── DETERMINISM ───────────────────────────────────────────────────────────
 * No `Math.random()`. Timestamps are anchored to the start of the current UTC
 * day, so two runs on the same day produce byte-identical data while the demo
 * data stays recent instead of ageing into an empty analytics window.
 *
 * ── WHAT IS DELIBERATELY NOT SEEDED ───────────────────────────────────────
 * `Job` (a worker would immediately try to send), `AuditLog` (append-only, it
 * earns its rows from real actions), `WebhookEvent`, and any real credential.
 * No `DELIVERED` events either: the Gmail API does not report delivery, and
 * seeding a metric we cannot actually observe would teach the dashboard to lie.
 *
 * ── IMPORTS ───────────────────────────────────────────────────────────────
 * `@prisma/client` is imported directly. eslint.config.mjs scopes its
 * `no-restricted-imports` block to `src/**`, and the product brief names
 * `prisma/` as one of the three places Prisma may be reached — so this is the
 * sanctioned path, not an exception. `src/lib/db.ts` is not reusable here: it
 * imports `server-only`, which throws outside the `react-server` condition that
 * `bun run` does not set.
 */

import 'dotenv/config'
import { Prisma, PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

// ═══════════════════════════════════════════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════════════════════════════════════════

const connectionString = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.')
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Printed at the end so a developer can log in immediately. */
const DEMO_EMAIL = 'owner@acme.test'
const DEMO_PASSWORD = 'instant-mail-demo-2026'

/**
 * From docs/architecture/07-auth-and-security.md §4.1. `parallelism` is
 * deliberately absent: Bun pins p=1 and ignores the option.
 */
const ARGON2 = {
  algorithm: 'argon2id',
  memoryCost: 65_536,
  timeCost: 3,
} as const satisfies Parameters<typeof Bun.password.hash>[1]

/** Non-UTC on purpose, so sending-window and daily-cap bugs surface locally. */
const TZ = 'Europe/Berlin'

const WS = 'sd_ws_acme'
const USER = 'sd_user_owner'
const MAILBOX = 'sd_mbx_outreach'
const DOMAIN = 'sd_dom_acme'
const MAILBOX_EMAIL = 'outreach@acme.test'
const CAMPAIGN_LIVE = 'sd_camp_q3'
const CAMPAIGN_DRAFT = 'sd_camp_autumn'
const SEQ_LIVE = 'sd_seq_q3'
const SEQ_DRAFT = 'sd_seq_autumn'
const EXPERIMENT = 'sd_exp_step1_subject'

/** Namespace for every seeded `EmailEvent.dedupeKey`. See the header. */
const EVENT_NS = 'sd:v1'

// ═══════════════════════════════════════════════════════════════════════════
// TIME — all UTC, anchored to the start of today.
// ═══════════════════════════════════════════════════════════════════════════

const BASE = (() => {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
})()

const DAY_MS = 86_400_000

/** `at(-3, 9 * 60)` → 09:00 UTC three days ago. */
function at(dayOffset: number, minuteOfDay = 0): Date {
  return new Date(BASE + dayOffset * DAY_MS + minuteOfDay * 60_000)
}

/**
 * The mailbox's LOCAL calendar day for an instant, as a date with no time
 * component — what `MailboxDailyStat.localDate` stores. Intl does the DST
 * arithmetic; a fixed offset would be wrong twice a year.
 */
const localDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function localDate(instant: Date): Date {
  return new Date(`${localDayFormatter.format(instant)}T00:00:00.000Z`)
}

// ═══════════════════════════════════════════════════════════════════════════
// DEMO DATA — declarative. Everything below is derived from these tables, so
// counters cannot drift from the events that justify them.
//
// Every person and company is invented. Domains use the RFC 2606 reserved TLDs
// `.example` and `.test`, which can never resolve, so a stray send in a
// misconfigured environment cannot reach a real inbox.
// ═══════════════════════════════════════════════════════════════════════════

const COMPANIES = {
  northwind: { name: 'Northwind Robotics', domain: 'northwind.example', industry: 'Manufacturing' },
  meridian: { name: 'Meridian Analytics', domain: 'meridian.example', industry: 'Software' },
  kestrel: { name: 'Kestrel Freight', domain: 'kestrel.example', industry: 'Logistics' },
  lumen: { name: 'Lumen Health', domain: 'lumen.example', industry: 'Healthcare' },
  harbour: {
    name: 'Harbour & Vale',
    domain: 'harbourvale.example',
    industry: 'Professional Services',
  },
  solstice: { name: 'Solstice Media', domain: 'solstice.example', industry: 'Media' },
} as const

type CompanyKey = keyof typeof COMPANIES
type LeadStatusName =
  'NEW' | 'CONTACTED' | 'ENGAGED' | 'REPLIED' | 'UNSUBSCRIBED' | 'BOUNCED' | 'DISQUALIFIED'

interface LeadSpec {
  key: string
  first: string
  last: string
  company: CompanyKey
  /** Local part of the address. Split out because the near-duplicate pair below
   *  differs only here. */
  local: string
  title: string
  status: LeadStatusName
  city: string
  country: string
  score: number | null
  employees: number
  renewal: string
  tags: readonly string[]
  lists: readonly string[]
}

const LEADS: readonly LeadSpec[] = [
  // ── Northwind Robotics ──
  {
    key: 'priya',
    first: 'Priya',
    last: 'Raman',
    company: 'northwind',
    local: 'priya.raman',
    title: 'VP Engineering',
    status: 'REPLIED',
    city: 'Rotterdam',
    country: 'Netherlands',
    score: 88,
    employees: 640,
    renewal: '2027-01-31',
    tags: ['champion', 'enterprise'],
    lists: ['q3'],
  },
  //  ↓ THE DELIBERATE NEAR-DUPLICATE. Same human as the row above, imported from
  //    a second source with an initial-form address. `@@unique([workspaceId,
  //    email])` cannot catch this — the addresses genuinely differ — so it is
  //    exactly the case fuzzy duplicate detection has to earn its keep on.
  {
    key: 'priya-dup',
    first: 'Priya',
    last: 'Raman',
    company: 'northwind',
    local: 'p.raman',
    title: 'VP of Engineering',
    status: 'NEW',
    city: 'Rotterdam',
    country: 'Netherlands',
    score: null,
    employees: 640,
    renewal: '2027-01-31',
    tags: [],
    lists: ['conference'],
  },
  {
    key: 'tobias',
    first: 'Tobias',
    last: 'Lindqvist',
    company: 'northwind',
    local: 't.lindqvist',
    title: 'Head of Platform',
    status: 'ENGAGED',
    city: 'Malmö',
    country: 'Sweden',
    score: 71,
    employees: 640,
    renewal: '2027-01-31',
    tags: ['enterprise'],
    lists: ['q3'],
  },
  {
    key: 'aiko',
    first: 'Aiko',
    last: 'Tanaka',
    company: 'northwind',
    local: 'aiko.tanaka',
    title: 'Director of Operations',
    status: 'CONTACTED',
    city: 'Rotterdam',
    country: 'Netherlands',
    score: 54,
    employees: 640,
    renewal: '2027-01-31',
    tags: [],
    lists: ['q3'],
  },
  {
    key: 'marcus',
    first: 'Marcus',
    last: 'Oyelaran',
    company: 'northwind',
    local: 'marcus.oyelaran',
    title: 'Chief Technology Officer',
    status: 'CONTACTED',
    city: 'Lagos',
    country: 'Nigeria',
    score: 62,
    employees: 640,
    renewal: '2027-01-31',
    tags: ['enterprise'],
    lists: ['q3'],
  },

  // ── Meridian Analytics ──
  {
    key: 'elena',
    first: 'Elena',
    last: 'Vasquez',
    company: 'meridian',
    local: 'elena.vasquez',
    title: 'Head of Growth',
    status: 'REPLIED',
    city: 'Madrid',
    country: 'Spain',
    score: 84,
    employees: 180,
    renewal: '2026-11-15',
    tags: ['champion'],
    lists: ['q3'],
  },
  {
    key: 'daniel',
    first: 'Daniel',
    last: 'Okonkwo',
    company: 'meridian',
    local: 'daniel.okonkwo',
    title: 'Data Lead',
    status: 'CONTACTED',
    city: 'Berlin',
    country: 'Germany',
    score: 49,
    employees: 180,
    renewal: '2026-11-15',
    tags: [],
    lists: ['q3'],
  },
  {
    key: 'sofia',
    first: 'Sofia',
    last: 'Bergström',
    company: 'meridian',
    local: 'sofia.bergstrom',
    title: 'Chief Operating Officer',
    status: 'ENGAGED',
    city: 'Stockholm',
    country: 'Sweden',
    score: 76,
    employees: 180,
    renewal: '2026-11-15',
    tags: ['enterprise'],
    lists: ['q3'],
  },
  {
    key: 'rahul',
    first: 'Rahul',
    last: 'Mehta',
    company: 'meridian',
    local: 'rahul.mehta',
    title: 'VP Product',
    status: 'NEW',
    city: 'Bengaluru',
    country: 'India',
    score: null,
    employees: 180,
    renewal: '2026-11-15',
    tags: [],
    lists: ['conference'],
  },
  {
    key: 'chloe',
    first: 'Chloé',
    last: 'Dubois',
    company: 'meridian',
    local: 'chloe.dubois',
    title: 'Marketing Director',
    status: 'BOUNCED',
    city: 'Lyon',
    country: 'France',
    score: 12,
    employees: 180,
    renewal: '2026-11-15',
    tags: ['do-not-contact'],
    lists: ['q3'],
  },

  // ── Kestrel Freight ──
  {
    key: 'werner',
    first: 'Werner',
    last: 'Haas',
    company: 'kestrel',
    local: 'werner.haas',
    title: 'Logistics Director',
    status: 'CONTACTED',
    city: 'Hamburg',
    country: 'Germany',
    score: 58,
    employees: 2100,
    renewal: '2027-04-01',
    tags: ['enterprise'],
    lists: ['q3'],
  },
  {
    key: 'nadia',
    first: 'Nadia',
    last: 'Farouk',
    company: 'kestrel',
    local: 'nadia.farouk',
    title: 'Head of Procurement',
    status: 'NEW',
    city: 'Cairo',
    country: 'Egypt',
    score: null,
    employees: 2100,
    renewal: '2027-04-01',
    tags: [],
    lists: ['conference'],
  },
  {
    key: 'jonas',
    first: 'Jonas',
    last: 'Rytter',
    company: 'kestrel',
    local: 'jonas.rytter',
    title: 'Fleet Manager',
    status: 'NEW',
    city: 'Aarhus',
    country: 'Denmark',
    score: 31,
    employees: 2100,
    renewal: '2027-04-01',
    tags: [],
    lists: ['conference'],
  },
  {
    key: 'isabel',
    first: 'Isabel',
    last: 'Ferreira',
    company: 'kestrel',
    local: 'isabel.ferreira',
    title: 'Chief Financial Officer',
    status: 'NEW',
    city: 'Lisbon',
    country: 'Portugal',
    score: null,
    employees: 2100,
    renewal: '2027-04-01',
    tags: ['enterprise'],
    lists: [],
  },

  // ── Lumen Health ──
  {
    key: 'amara',
    first: 'Amara',
    last: 'Nwosu',
    company: 'lumen',
    local: 'amara.nwosu',
    title: 'Chief Medical Officer',
    status: 'REPLIED',
    city: 'Manchester',
    country: 'United Kingdom',
    score: 79,
    employees: 950,
    renewal: '2026-09-30',
    tags: ['champion', 'enterprise'],
    lists: ['q3'],
  },
  {
    key: 'stefan',
    first: 'Stefan',
    last: 'Kowalski',
    company: 'lumen',
    local: 'stefan.kowalski',
    title: 'IT Director',
    status: 'CONTACTED',
    city: 'Kraków',
    country: 'Poland',
    score: 44,
    employees: 950,
    renewal: '2026-09-30',
    tags: [],
    lists: ['q3'],
  },
  {
    key: 'hana',
    first: 'Hana',
    last: 'Yilmaz',
    company: 'lumen',
    local: 'hana.yilmaz',
    title: 'Head of Compliance',
    status: 'NEW',
    city: 'Istanbul',
    country: 'Türkiye',
    score: null,
    employees: 950,
    renewal: '2026-09-30',
    tags: [],
    lists: ['conference'],
  },
  {
    key: 'grace',
    first: 'Grace',
    last: 'Mbeki',
    company: 'lumen',
    local: 'grace.mbeki',
    title: 'Operations Manager',
    status: 'UNSUBSCRIBED',
    city: 'Nairobi',
    country: 'Kenya',
    score: 8,
    employees: 950,
    renewal: '2026-09-30',
    tags: ['do-not-contact'],
    lists: ['q3'],
  },
  {
    key: 'lukas',
    first: 'Lukas',
    last: 'Brenner',
    company: 'lumen',
    local: 'lukas.brenner',
    title: 'Procurement Lead',
    status: 'NEW',
    city: 'Zürich',
    country: 'Switzerland',
    score: null,
    employees: 950,
    renewal: '2026-09-30',
    tags: [],
    lists: [],
  },

  // ── Harbour & Vale ──
  {
    key: 'camille',
    first: 'Camille',
    last: 'Roux',
    company: 'harbour',
    local: 'camille.roux',
    title: 'Partner',
    status: 'CONTACTED',
    city: 'Paris',
    country: 'France',
    score: 66,
    employees: 75,
    renewal: '2027-02-28',
    tags: [],
    lists: ['q3'],
  },
  {
    key: 'oliver',
    first: 'Oliver',
    last: 'Ashworth',
    company: 'harbour',
    local: 'oliver.ashworth',
    title: 'Managing Director',
    status: 'NEW',
    city: 'London',
    country: 'United Kingdom',
    score: null,
    employees: 75,
    renewal: '2027-02-28',
    tags: [],
    lists: ['conference'],
  },
  {
    key: 'yuki',
    first: 'Yuki',
    last: 'Nakamura',
    company: 'harbour',
    local: 'yuki.nakamura',
    title: 'Associate',
    status: 'NEW',
    city: 'Tokyo',
    country: 'Japan',
    score: 22,
    employees: 75,
    renewal: '2027-02-28',
    tags: [],
    lists: [],
  },

  // ── Solstice Media ──
  {
    key: 'beatriz',
    first: 'Beatriz',
    last: 'Alves',
    company: 'solstice',
    local: 'beatriz.alves',
    title: 'Head of Content',
    status: 'ENGAGED',
    city: 'São Paulo',
    country: 'Brazil',
    score: 69,
    employees: 310,
    renewal: '2026-12-01',
    tags: ['champion'],
    lists: ['q3'],
  },
  {
    key: 'finn',
    first: 'Finn',
    last: 'Halvorsen',
    company: 'solstice',
    local: 'finn.halvorsen',
    title: 'Editorial Director',
    status: 'NEW',
    city: 'Oslo',
    country: 'Norway',
    score: 37,
    employees: 310,
    renewal: '2026-12-01',
    tags: [],
    lists: ['q3'],
  },
  {
    key: 'zainab',
    first: 'Zainab',
    last: 'Idris',
    company: 'solstice',
    local: 'zainab.idris',
    title: 'Publisher',
    status: 'DISQUALIFIED',
    city: 'Abuja',
    country: 'Nigeria',
    score: 5,
    employees: 310,
    renewal: '2026-12-01',
    tags: ['do-not-contact'],
    lists: ['q3'],
  },
]

const leadById = new Map(LEADS.map((l) => [l.key, l]))

function lead(key: string): LeadSpec {
  const found = leadById.get(key)
  if (!found) throw new Error(`Unknown lead key: ${key}`)
  return found
}

const leadEmail = (l: LeadSpec) => `${l.local}@${COMPANIES[l.company].domain}`
const leadRowId = (key: string) => `sd_lead_${key}`

/** `colorToken` values are semantic design-system names, never hex. */
const TAGS = [
  { key: 'champion', name: 'Champion', colorToken: 'success' },
  { key: 'enterprise', name: 'Enterprise', colorToken: 'info' },
  { key: 'do-not-contact', name: 'Do not contact', colorToken: 'danger' },
  { key: 'inbound', name: 'Inbound', colorToken: 'warning' },
] as const

const LISTS = [
  { key: 'q3', name: 'Q3 Prospects', description: 'Primary outbound list for the Q3 push.' },
  {
    key: 'conference',
    name: 'Conference Leads',
    description: 'Scanned badges from the Rotterdam expo.',
  },
] as const

/**
 * Personalisation tokens must match `Lead` column names or substitution silently
 * renders an empty string, so these are `{{firstName}}` and `{{companyName}}` —
 * the names the schema's own doc comment specifies. `{{industry}}` resolves
 * through the CustomFieldDefinition below.
 */
const CUSTOM_FIELDS = [
  {
    key: 'industry',
    label: 'Industry',
    type: 'SELECT' as const,
    position: 0,
    options: [
      'Manufacturing',
      'Software',
      'Logistics',
      'Healthcare',
      'Professional Services',
      'Media',
    ],
    required: false,
  },
  {
    key: 'employees',
    label: 'Employees',
    type: 'NUMBER' as const,
    position: 1,
    options: [] as string[],
    required: false,
  },
  {
    key: 'renewalDate',
    label: 'Renewal date',
    type: 'DATE' as const,
    position: 2,
    options: [] as string[],
    required: false,
  },
] as const

// ── Live campaign step content ────────────────────────────────────────────

const LIVE_STEP1_A = {
  label: 'A',
  subject: 'Quick question about {{companyName}}',
  bodyText:
    'Hi {{firstName}},\n\n' +
    'I noticed {{companyName}} is scaling its {{industry}} operations. Teams your size usually hit the same wall: the tooling that got them here stops fitting somewhere around the fifth new hire.\n\n' +
    'We helped two other teams in your space cut their reporting cycle from a fortnight to an afternoon.\n\n' +
    'Worth fifteen minutes to compare notes?\n\n' +
    'Best,\nAlex Fenwick\nAcme',
  bodyHtml:
    '<p>Hi {{firstName}},</p>' +
    '<p>I noticed {{companyName}} is scaling its {{industry}} operations. Teams your size usually hit the same wall: the tooling that got them here stops fitting somewhere around the fifth new hire.</p>' +
    '<p>We helped two other teams in your space cut their reporting cycle from a fortnight to an afternoon.</p>' +
    '<p>Worth fifteen minutes to compare notes?</p>' +
    '<p>Best,<br />Alex Fenwick<br />Acme</p>',
  weight: 50,
}

const LIVE_STEP1_B = {
  label: 'B',
  subject: '{{firstName}} — 15 minutes on {{companyName}}’s reporting?',
  bodyText:
    'Hi {{firstName}},\n\n' +
    'Most {{industry}} teams we speak to are stitching four tools together to answer one question. It works until it does not.\n\n' +
    'If that sounds like {{companyName}}, I can show you what we did for a team of a similar size in about fifteen minutes.\n\n' +
    'Open to it?\n\n' +
    'Best,\nAlex Fenwick\nAcme',
  bodyHtml:
    '<p>Hi {{firstName}},</p>' +
    '<p>Most {{industry}} teams we speak to are stitching four tools together to answer one question. It works until it does not.</p>' +
    '<p>If that sounds like {{companyName}}, I can show you what we did for a team of a similar size in about fifteen minutes.</p>' +
    '<p>Open to it?</p>' +
    '<p>Best,<br />Alex Fenwick<br />Acme</p>',
  weight: 50,
}

/** Empty subject = reply in the existing thread, per the schema's variant docs. */
const LIVE_STEP3_A = {
  label: 'A',
  subject: '',
  bodyText:
    'Hi {{firstName}},\n\n' +
    'Bumping this once in case it slipped past — I know inboxes at {{companyName}} are busy.\n\n' +
    'If the timing is wrong, just say so and I will stop following up.\n\n' +
    'Best,\nAlex',
  bodyHtml:
    '<p>Hi {{firstName}},</p>' +
    '<p>Bumping this once in case it slipped past — I know inboxes at {{companyName}} are busy.</p>' +
    '<p>If the timing is wrong, just say so and I will stop following up.</p>' +
    '<p>Best,<br />Alex</p>',
  weight: 100,
}

// ── Draft campaign step content (email → wait → email) ────────────────────

const DRAFT_STEP1 = {
  label: 'A',
  subject: 'Ideas for {{companyName}} ahead of {{renewalDate}}',
  bodyText:
    'Hi {{firstName}},\n\n' +
    'You have a renewal coming up at {{companyName}}, which is usually the moment teams take an honest look at what they are paying for.\n\n' +
    'I have three observations specific to {{industry}} that might be useful either way.\n\n' +
    'Want me to send them over?\n\n' +
    'Best,\nAlex Fenwick\nAcme',
  bodyHtml:
    '<p>Hi {{firstName}},</p>' +
    '<p>You have a renewal coming up at {{companyName}}, which is usually the moment teams take an honest look at what they are paying for.</p>' +
    '<p>I have three observations specific to {{industry}} that might be useful either way.</p>' +
    '<p>Want me to send them over?</p>' +
    '<p>Best,<br />Alex Fenwick<br />Acme</p>',
  weight: 100,
}

const DRAFT_STEP3 = {
  label: 'A',
  subject: '',
  bodyText:
    'Hi {{firstName}},\n\n' +
    'Last note from me. If the renewal review at {{companyName}} is already settled, I will leave you to it.\n\n' +
    'If not, the offer of those three observations stands.\n\n' +
    'Best,\nAlex',
  bodyHtml:
    '<p>Hi {{firstName}},</p>' +
    '<p>Last note from me. If the renewal review at {{companyName}} is already settled, I will leave you to it.</p>' +
    '<p>If not, the offer of those three observations stands.</p>' +
    '<p>Best,<br />Alex</p>',
  weight: 100,
}

/** Substitutes the same tokens the sequence bodies use. Personalisation is
 *  resolved once, at materialisation, so the stored body is what was sent. */
function render(template: string, l: LeadSpec): string {
  const c = COMPANIES[l.company]
  return template
    .replaceAll('{{firstName}}', l.first)
    .replaceAll('{{lastName}}', l.last)
    .replaceAll('{{fullName}}', `${l.first} ${l.last}`)
    .replaceAll('{{companyName}}', c.name)
    .replaceAll('{{jobTitle}}', l.title)
    .replaceAll('{{industry}}', c.industry)
    .replaceAll('{{employees}}', String(l.employees))
    .replaceAll('{{renewalDate}}', l.renewal)
}

// ── Enrollments in the live campaign ──────────────────────────────────────
//
// `step3` is deliberately three-valued: a day number means it was sent, a
// positive `pending` day means a SCHEDULED row exists, and `cancelled` means the
// enrollment ended before the follow-up went out — the case that proves "a reply
// stops the sequence" left a trace instead of quietly vanishing.

type Step3 =
  | { kind: 'sent'; day: number; opens: readonly number[] }
  | { kind: 'pending'; day: number }
  | { kind: 'cancelled'; reason: 'HUMAN_REPLY' | 'HARD_BOUNCE' | 'UNSUBSCRIBED' | 'MANUAL' }
  | { kind: 'none' }

interface Inbound {
  day: number
  minute: number
  classification: 'HUMAN_REPLY' | 'OUT_OF_OFFICE' | 'BOUNCE' | 'UNSUBSCRIBE_REQUEST'
  subject: string
  text: string
  /** Only for classification BOUNCE. */
  bounce?: { type: 'HARD' | 'SOFT'; code: string }
}

interface EnrollmentSpec {
  leadKey: string
  state:
    | 'PENDING'
    | 'ACTIVE'
    | 'WAITING'
    | 'COMPLETED'
    | 'STOPPED'
    | 'REPLIED'
    | 'BOUNCED'
    | 'UNSUBSCRIBED'
    | 'FAILED'
  stopReason?:
    'HUMAN_REPLY' | 'HARD_BOUNCE' | 'UNSUBSCRIBED' | 'LEAD_DISQUALIFIED' | 'NO_ELIGIBLE_MAILBOX'
  variant: 'A' | 'B'
  /** Day offset of the step-1 send. `null` = never materialised. */
  step1Day: number | null
  opens: readonly number[]
  clicks: readonly number[]
  step3: Step3
  inbound?: Inbound
  /** Days from now until the next step. Future-dated on purpose: see the
   *  campaign-status note in `main()`. */
  nextStepInDays?: number
}

const ENROLLMENTS: readonly EnrollmentSpec[] = [
  // ── Replied. The sequence stopped and the follow-up was cancelled. ──
  {
    leadKey: 'priya',
    state: 'REPLIED',
    stopReason: 'HUMAN_REPLY',
    variant: 'A',
    step1Day: -12,
    opens: [-12, -11],
    clicks: [-11],
    step3: { kind: 'cancelled', reason: 'HUMAN_REPLY' },
    inbound: {
      day: -10,
      minute: 8 * 60 + 42,
      classification: 'HUMAN_REPLY',
      subject: 'Re: Quick question about Northwind Robotics',
      text: 'Hi Alex,\n\nGood timing — we are reviewing exactly this next quarter. Can you do Thursday afternoon?\n\nPriya',
    },
  },
  {
    leadKey: 'elena',
    state: 'REPLIED',
    stopReason: 'HUMAN_REPLY',
    variant: 'B',
    step1Day: -11,
    opens: [-11],
    clicks: [],
    step3: { kind: 'cancelled', reason: 'HUMAN_REPLY' },
    inbound: {
      day: -9,
      minute: 15 * 60 + 6,
      classification: 'HUMAN_REPLY',
      subject: 'Re: Elena — 15 minutes on Meridian Analytics’s reporting?',
      text: 'Thanks for reaching out. Not a priority this quarter, but keep me on your list for January.\n\nElena',
    },
  },
  {
    leadKey: 'amara',
    state: 'REPLIED',
    stopReason: 'HUMAN_REPLY',
    variant: 'A',
    step1Day: -10,
    opens: [-10, -9],
    clicks: [-9],
    step3: { kind: 'cancelled', reason: 'HUMAN_REPLY' },
    inbound: {
      day: -8,
      minute: 11 * 60 + 19,
      classification: 'HUMAN_REPLY',
      subject: 'Re: Quick question about Lumen Health',
      text: 'This is relevant to us. Sending you our procurement contact — can we get something on the calendar for next week?\n\nAmara',
    },
  },

  // ── Mid-flight. Follow-up already sent, waiting out the next gap. ──
  {
    leadKey: 'tobias',
    state: 'WAITING',
    variant: 'B',
    step1Day: -9,
    opens: [-9, -8],
    clicks: [-8],
    step3: { kind: 'sent', day: -6, opens: [-5] },
    nextStepInDays: 2,
  },
  {
    leadKey: 'sofia',
    state: 'WAITING',
    variant: 'A',
    step1Day: -9,
    opens: [-9],
    clicks: [],
    step3: { kind: 'sent', day: -6, opens: [] },
    nextStepInDays: 3,
  },

  // ── An auto-reply that must NOT stop the sequence. The whole point of
  //    classifying inbound mail rather than treating any reply as a reply. ──
  {
    leadKey: 'beatriz',
    state: 'ACTIVE',
    variant: 'B',
    step1Day: -8,
    opens: [-8, -7],
    clicks: [-7],
    step3: { kind: 'pending', day: 1 },
    inbound: {
      day: -8,
      minute: 9 * 60 + 4,
      classification: 'OUT_OF_OFFICE',
      subject: 'Automatic reply: Beatriz — 15 minutes on Solstice Media’s reporting?',
      text: 'I am out of the office until the 14th with limited access to email. For urgent matters please contact the desk.',
    },
    nextStepInDays: 1,
  },

  // ── Ran to the end with no reply. ──
  {
    leadKey: 'aiko',
    state: 'COMPLETED',
    variant: 'A',
    step1Day: -13,
    opens: [-13],
    clicks: [],
    step3: { kind: 'sent', day: -10, opens: [] },
  },
  {
    leadKey: 'marcus',
    state: 'COMPLETED',
    variant: 'B',
    step1Day: -13,
    opens: [],
    clicks: [],
    step3: { kind: 'sent', day: -10, opens: [] },
  },
  {
    leadKey: 'daniel',
    state: 'COMPLETED',
    variant: 'A',
    step1Day: -12,
    opens: [-11],
    clicks: [],
    step3: { kind: 'sent', day: -9, opens: [-9] },
  },

  // ── In flight, follow-up scheduled. ──
  {
    leadKey: 'werner',
    state: 'ACTIVE',
    variant: 'B',
    step1Day: -7,
    opens: [-7],
    clicks: [],
    step3: { kind: 'pending', day: 2 },
    nextStepInDays: 2,
  },
  {
    leadKey: 'stefan',
    state: 'ACTIVE',
    variant: 'A',
    step1Day: -6,
    opens: [],
    clicks: [],
    step3: { kind: 'pending', day: 2 },
    nextStepInDays: 2,
  },
  {
    leadKey: 'camille',
    state: 'ACTIVE',
    variant: 'B',
    step1Day: -5,
    opens: [-5, -4],
    clicks: [],
    step3: { kind: 'pending', day: 3 },
    nextStepInDays: 3,
  },

  // ── Terminal failures, each with the artefact that caused it. ──
  {
    leadKey: 'chloe',
    state: 'BOUNCED',
    stopReason: 'HARD_BOUNCE',
    variant: 'A',
    step1Day: -11,
    opens: [],
    clicks: [],
    step3: { kind: 'cancelled', reason: 'HARD_BOUNCE' },
    inbound: {
      day: -11,
      minute: 9 * 60 + 2,
      classification: 'BOUNCE',
      subject: 'Undelivered Mail Returned to Sender',
      text: 'This is the mail system at host mx.meridian.example.\n\nYour message could not be delivered to one or more recipients.\n\n<chloe.dubois@meridian.example>: host mx.meridian.example said: 550 5.1.1 User unknown',
      bounce: { type: 'HARD', code: '5.1.1' },
    },
  },
  {
    leadKey: 'grace',
    state: 'UNSUBSCRIBED',
    stopReason: 'UNSUBSCRIBED',
    variant: 'B',
    step1Day: -10,
    opens: [-10],
    clicks: [],
    step3: { kind: 'cancelled', reason: 'UNSUBSCRIBED' },
    inbound: {
      day: -9,
      minute: 7 * 60 + 51,
      classification: 'UNSUBSCRIBE_REQUEST',
      subject: 'Re: Grace — 15 minutes on Lumen Health’s reporting?',
      text: 'Please remove me from this list and do not contact me again.',
    },
  },
  {
    leadKey: 'zainab',
    state: 'STOPPED',
    stopReason: 'LEAD_DISQUALIFIED',
    variant: 'A',
    step1Day: -12,
    opens: [],
    clicks: [],
    step3: { kind: 'cancelled', reason: 'MANUAL' },
  },

  // ── Enrolled but nothing materialised yet. ──
  {
    leadKey: 'finn',
    state: 'PENDING',
    variant: 'A',
    step1Day: null,
    opens: [],
    clicks: [],
    step3: { kind: 'none' },
    nextStepInDays: 1,
  },
  // ── An honest failure: enrolled while no mailbox could send for them. ──
  {
    leadKey: 'jonas',
    state: 'FAILED',
    stopReason: 'NO_ELIGIBLE_MAILBOX',
    variant: 'A',
    step1Day: null,
    opens: [],
    clicks: [],
    step3: { kind: 'none' },
  },
]

// ═══════════════════════════════════════════════════════════════════════════
// SEED STAGES
// ═══════════════════════════════════════════════════════════════════════════

async function seedIdentity() {
  const passwordHash = await Bun.password.hash(DEMO_PASSWORD, ARGON2)

  // The hash is re-derived on every run (argon2 salts randomly), so it is set on
  // create only. Overwriting it each run would churn the row for no benefit and
  // invalidate a password the developer may have deliberately changed.
  await db.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: DEMO_EMAIL,
      passwordHash,
      name: 'Alex Fenwick',
      emailVerifiedAt: at(-30),
      timezone: TZ,
    },
    update: { email: DEMO_EMAIL, name: 'Alex Fenwick', timezone: TZ, deletedAt: null },
  })

  const workspace = {
    name: 'Acme Outreach',
    slug: 'acme',
    timezone: TZ,
    dailySendLimit: 200,
    trackOpensDefault: true,
    trackClicksDefault: true,
    unsubscribeFooterHtml:
      '<p style="font-size:12px">Not relevant? <a href="{{unsubscribeUrl}}">Unsubscribe</a>. ' +
      'Acme, 14 Kanalstraat, Rotterdam.</p>',
  }

  await db.workspace.upsert({
    where: { id: WS },
    create: { id: WS, ...workspace },
    update: { ...workspace, deletedAt: null },
  })

  await db.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: WS, userId: USER } },
    create: {
      id: 'sd_member_owner',
      workspaceId: WS,
      userId: USER,
      role: 'OWNER',
      status: 'ACTIVE',
    },
    update: { role: 'OWNER', status: 'ACTIVE' },
  })
}

async function seedMailbox() {
  // A mixed verdict on purpose: the deliverability page must be able to render
  // PASS, WARN and a real record side by side, not a column of green.
  const domain = {
    workspaceId: WS,
    name: 'acme.test',
    spfStatus: 'PASS' as const,
    dkimStatus: 'PASS' as const,
    dmarcStatus: 'WARN' as const,
    mxStatus: 'PASS' as const,
    spfRecord: 'v=spf1 include:_spf.google.com ~all',
    dkimRecord: 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA-example-public-key',
    dmarcRecord: 'v=DMARC1; p=none; rua=mailto:dmarc@acme.test',
    dkimSelector: 'google',
    dmarcPolicy: 'none',
    issues: {
      dmarc:
        'Policy is p=none, so nothing is enforced. Move to quarantine once reports look clean.',
    },
    healthScore: 74,
    lastCheckedAt: at(0, 6 * 60),
  }

  await db.domain.upsert({
    where: { id: DOMAIN },
    create: { id: DOMAIN, ...domain },
    update: domain,
  })

  /**
   * ── WHY THIS MAILBOX IS `DISCONNECTED`, NOT `ACTIVE` ────────────────────
   *
   * A seed has no OAuth grant, so it cannot produce a usable refresh token. The
   * three options were:
   *
   *   1. `ACTIVE` with `encryptedRefreshToken: null` — what
   *      01-database.md §9.4 describes. Rejected: `ACTIVE` means "eligible to
   *      send", the mailboxes page would render a green mailbox, and the first
   *      real send attempt would fail deep in the worker. The UI would be
   *      lying, which the brief's no-fake-functionality rule forbids.
   *   2. A fake ciphertext under a real `encrypt()`. Rejected: it decrypts to
   *      garbage that Google rejects with `invalid_grant`, so the failure
   *      surfaces as a provider error rather than as "you have not connected
   *      this mailbox yet". Wrong diagnosis, harder to act on. It would also
   *      mean duplicating AES-GCM here, because `src/lib/crypto.ts` imports
   *      `server-only`, which throws outside Next's `react-server` condition.
   *   3. `DISCONNECTED` with a null token and a `statusMessage` — chosen. The
   *      enum's own documentation is "needs reconnect", which is precisely
   *      true, and it drives the disconnected UI state the brief requires
   *      every mailbox surface to ship.
   *
   * Configuration (limits, window, timezone) is fully populated, so connecting a
   * real mailbox is the only missing step rather than a setup exercise.
   */
  const mailbox = {
    workspaceId: WS,
    provider: 'GMAIL' as const,
    email: MAILBOX_EMAIL,
    fromName: 'Alex Fenwick',
    status: 'DISCONNECTED' as const,
    statusMessage:
      'Seeded demo mailbox — never connected to Google. Use Connect mailbox to complete OAuth; ' +
      'sending stays disabled until then.',
    encryptedRefreshToken: null,
    encryptedAccessToken: null,
    accessTokenExpiresAt: null,
    grantedScopes: null,
    dailySendLimit: 50,
    minSecondsBetweenSends: 90,
    sendJitterSeconds: 120,
    timezone: TZ,
    sendWindowStartMinute: 480,
    sendWindowEndMinute: 1020,
    sendWindowDays: [1, 2, 3, 4, 5],
    warmupStatus: 'DISABLED' as const,
    domainId: DOMAIN,
    connectedByUserId: USER,
    lastErrorAt: at(-1, 6 * 60),
  }

  await db.emailAccount.upsert({
    where: { id: MAILBOX },
    create: { id: MAILBOX, ...mailbox },
    update: { ...mailbox, deletedAt: null },
  })

  // No cursor and no watch: nothing has ever synced. `IDLE` with a null
  // historyId is the honest representation of "never ran".
  const sync = {
    workspaceId: WS,
    emailAccountId: MAILBOX,
    status: 'IDLE' as const,
    historyId: null,
    watchExpiresAt: null,
    backfillCompletedAt: null,
    lastError: 'Mailbox is not connected, so no sync has run.',
  }

  await db.syncState.upsert({
    where: { emailAccountId: MAILBOX },
    create: { id: 'sd_sync_outreach', ...sync },
    update: sync,
  })
}

async function seedTaxonomy() {
  for (const t of TAGS) {
    const data = { workspaceId: WS, name: t.name, colorToken: t.colorToken }
    await db.leadTag.upsert({
      where: { id: `sd_tag_${t.key}` },
      create: { id: `sd_tag_${t.key}`, ...data },
      update: data,
    })
  }

  for (const l of LISTS) {
    const data = { workspaceId: WS, name: l.name, description: l.description }
    await db.leadList.upsert({
      where: { id: `sd_list_${l.key}` },
      create: { id: `sd_list_${l.key}`, ...data },
      update: { ...data, deletedAt: null },
    })
  }

  for (const f of CUSTOM_FIELDS) {
    const data = {
      workspaceId: WS,
      key: f.key,
      label: f.label,
      type: f.type,
      options: [...f.options],
      required: f.required,
      position: f.position,
    }
    await db.customFieldDefinition.upsert({
      where: { workspaceId_key: { workspaceId: WS, key: f.key } },
      create: { id: `sd_cf_${f.key}`, ...data },
      update: data,
    })
  }
}

/**
 * Per-lead engagement counters derived from ENROLLMENTS, so the caches on `Lead`
 * agree with the events that justify them. Inconsistent seed data teaches
 * developers to distrust the dashboard.
 */
interface Engagement {
  sentCount: number
  openCount: number
  clickCount: number
  replyCount: number
  lastContactedAt: Date | null
  lastOpenedAt: Date | null
  lastRepliedAt: Date | null
}

const engagementByLead = new Map<string, Engagement>()

for (const e of ENROLLMENTS) {
  const sendDays: number[] = []
  if (e.step1Day !== null) sendDays.push(e.step1Day)
  if (e.step3.kind === 'sent') sendDays.push(e.step3.day)

  const openDays = [...e.opens, ...(e.step3.kind === 'sent' ? e.step3.opens : [])]
  const isHumanReply = e.inbound?.classification === 'HUMAN_REPLY'

  engagementByLead.set(e.leadKey, {
    sentCount: sendDays.length,
    openCount: openDays.length,
    clickCount: e.clicks.length,
    replyCount: isHumanReply ? 1 : 0,
    lastContactedAt: sendDays.length > 0 ? at(Math.max(...sendDays), 9 * 60) : null,
    lastOpenedAt: openDays.length > 0 ? at(Math.max(...openDays), 10 * 60 + 30) : null,
    lastRepliedAt: isHumanReply && e.inbound ? at(e.inbound.day, e.inbound.minute) : null,
  })
}

const NO_ENGAGEMENT: Engagement = {
  sentCount: 0,
  openCount: 0,
  clickCount: 0,
  replyCount: 0,
  lastContactedAt: null,
  lastOpenedAt: null,
  lastRepliedAt: null,
}

async function seedLeads() {
  for (const [index, l] of LEADS.entries()) {
    const company = COMPANIES[l.company]
    const email = leadEmail(l)
    const eng = engagementByLead.get(l.key) ?? NO_ENGAGEMENT

    const data = {
      workspaceId: WS,
      email,
      // What the customer's CSV literally contained, before normalisation.
      emailRaw: `${l.first} ${l.last} <${l.local}@${company.domain.toUpperCase()}>`,
      firstName: l.first,
      lastName: l.last,
      fullName: `${l.first} ${l.last}`,
      companyName: company.name,
      jobTitle: l.title,
      websiteUrl: `https://www.${company.domain}`,
      linkedinUrl: `https://www.linkedin.com/in/${l.key}-demo`,
      emailDomain: company.domain,
      city: l.city,
      country: l.country,
      status: l.status,
      // Nothing here has been through a verification provider, so claiming
      // VALID would be inventing a result. UNVERIFIED is the truth.
      verificationStatus: 'UNVERIFIED' as const,
      score: l.score,
      customFields: {
        industry: company.industry,
        employees: l.employees,
        renewalDate: l.renewal,
      } satisfies Prisma.InputJsonValue,
      source: l.lists.includes('conference') ? 'csv:conference-rotterdam' : 'csv:demo-seed',
      ownerUserId: USER,
      sentCount: eng.sentCount,
      openCount: eng.openCount,
      clickCount: eng.clickCount,
      replyCount: eng.replyCount,
      lastContactedAt: eng.lastContactedAt,
      lastOpenedAt: eng.lastOpenedAt,
      lastRepliedAt: eng.lastRepliedAt,
      // Staggered so the leads table has a meaningful default sort rather than
      // 25 rows sharing one timestamp.
      createdAt: at(-20, 8 * 60 + index * 7),
    }

    await db.lead.upsert({
      where: { workspaceId_email: { workspaceId: WS, email } },
      create: { id: leadRowId(l.key), ...data },
      update: { ...data, deletedAt: null },
    })
  }

  // Joins with no dependents and no append-only trigger: replaced wholesale, so
  // editing this file actually removes memberships rather than only adding them.
  await db.leadListMembership.deleteMany({ where: { workspaceId: WS } })
  await db.leadTagLink.deleteMany({ where: { workspaceId: WS } })

  await db.leadListMembership.createMany({
    data: LEADS.flatMap((l) =>
      l.lists.map((listKey) => ({
        workspaceId: WS,
        leadListId: `sd_list_${listKey}`,
        leadId: leadRowId(l.key),
      })),
    ),
    skipDuplicates: true,
  })

  await db.leadTagLink.createMany({
    data: LEADS.flatMap((l) =>
      l.tags.map((tagKey) => ({
        workspaceId: WS,
        leadTagId: `sd_tag_${tagKey}`,
        leadId: leadRowId(l.key),
      })),
    ),
    skipDuplicates: true,
  })

  // `leadCount` is a cache; recompute it from the memberships just written.
  for (const l of LISTS) {
    const leadCount = await db.leadListMembership.count({
      where: { workspaceId: WS, leadListId: `sd_list_${l.key}` },
    })
    await db.leadList.update({ where: { id: `sd_list_${l.key}` }, data: { leadCount } })
  }
}

async function seedSuppressions() {
  const rows = [
    {
      id: 'sd_supp_grace',
      scope: 'EMAIL' as const,
      value: leadEmail(lead('grace')),
      reason: 'UNSUBSCRIBED' as const,
      note: 'Replied asking to be removed. Honoured immediately.',
      sourceLeadId: leadRowId('grace'),
      sourceCampaignId: CAMPAIGN_LIVE,
    },
    {
      id: 'sd_supp_chloe',
      scope: 'EMAIL' as const,
      value: leadEmail(lead('chloe')),
      reason: 'HARD_BOUNCE' as const,
      note: '550 5.1.1 User unknown — address does not exist.',
      sourceLeadId: leadRowId('chloe'),
      sourceCampaignId: CAMPAIGN_LIVE,
    },
    {
      id: 'sd_supp_competitor',
      scope: 'DOMAIN' as const,
      value: 'rival-outreach.example',
      reason: 'POLICY' as const,
      note: 'Direct competitor. Never contact anyone at this domain.',
      sourceLeadId: null,
      sourceCampaignId: null,
    },
  ]

  for (const { id, ...data } of rows) {
    await db.suppression.upsert({
      where: { workspaceId_scope_value: { workspaceId: WS, scope: data.scope, value: data.value } },
      create: { id, workspaceId: WS, ...data },
      update: { reason: data.reason, note: data.note },
    })
  }
}

// ── Deterministic ids for sequence structure ──────────────────────────────

const stepId = (seq: 'live' | 'draft', position: number) => `sd_step_${seq}_${position}`
const variantId = (seq: 'live' | 'draft', position: number, label: string) =>
  `sd_var_${seq}_${position}${label.toLowerCase()}`

interface VariantContent {
  label: string
  subject: string
  bodyHtml: string
  bodyText: string
  weight: number
}

async function upsertStep(
  seq: 'live' | 'draft',
  sequenceId: string,
  position: number,
  step: {
    type: 'EMAIL' | 'WAIT' | 'CONDITION'
    delayMinutes: number
    conditionKind?: 'HAS_REPLIED'
    conditionOutcome?: 'STOP'
  },
  variants: readonly VariantContent[],
) {
  const data = {
    workspaceId: WS,
    sequenceId,
    type: step.type,
    position,
    delayMinutes: step.delayMinutes,
    conditionKind: step.conditionKind ?? null,
    conditionOutcome: step.conditionOutcome ?? null,
    enabled: true,
  }

  await db.sequenceStep.upsert({
    where: { sequenceId_position: { sequenceId, position } },
    create: { id: stepId(seq, position), ...data },
    update: data,
  })

  for (const v of variants) {
    const vData = {
      workspaceId: WS,
      sequenceStepId: stepId(seq, position),
      label: v.label,
      subject: v.subject,
      bodyHtml: v.bodyHtml,
      bodyText: v.bodyText,
      weight: v.weight,
      enabled: true,
    }
    await db.sequenceStepVariant.upsert({
      where: { sequenceStepId_label: { sequenceStepId: stepId(seq, position), label: v.label } },
      create: { id: variantId(seq, position, v.label), ...vData },
      update: vData,
    })
  }
}

async function seedCampaigns() {
  const schedule = {
    timezone: TZ,
    sendWindowStartMinute: 480,
    sendWindowEndMinute: 1020,
    sendWindowDays: [1, 2, 3, 4, 5],
    stopOnReply: true,
    stopOnReplyAnyCampaign: false,
    trackOpens: true,
    trackClicks: true,
    skipIfInOtherCampaign: true,
    threadFollowUps: true,
  }

  /**
   * ── WHY THE CAMPAIGN WITH HISTORY IS `PAUSED`, NOT `ACTIVE` ─────────────
   *
   * §9.4 of the database doc calls for `ACTIVE`, and this deliberately differs.
   * The mailbox above is `DISCONNECTED`, so an `ACTIVE` campaign would advertise
   * a campaign that provably cannot send: the scheduler would pick it up, find
   * no eligible mailbox, and fail every enrollment. `PAUSED` with a
   * `statusMessage`-equivalent trail (`pausedAt` set, `launchedAt` retained) is
   * the state a real operator would be in — launched, then paused when the
   * mailbox dropped — and it keeps all the analytics history the doc wants while
   * the UI's "resume" affordance stays honestly blocked on connecting a mailbox.
   */
  const live = {
    workspaceId: WS,
    name: 'Q3 Outbound — Operations Leaders',
    status: 'PAUSED' as const,
    createdByUserId: USER,
    dailySendLimit: 40,
    startAt: at(-14, 8 * 60),
    launchedAt: at(-14, 8 * 60),
    pausedAt: at(-1, 6 * 60),
    ...schedule,
  }

  await db.campaign.upsert({
    where: { id: CAMPAIGN_LIVE },
    create: { id: CAMPAIGN_LIVE, ...live, createdAt: at(-15, 14 * 60) },
    update: { ...live, deletedAt: null },
  })

  // The DRAFT campaign the task asks for: never launched, so nothing is
  // materialised against it and its counters are legitimately zero.
  const draft = {
    workspaceId: WS,
    name: 'Autumn Renewals — Draft',
    status: 'DRAFT' as const,
    createdByUserId: USER,
    startAt: null,
    launchedAt: null,
    pausedAt: null,
    ...schedule,
  }

  await db.campaign.upsert({
    where: { id: CAMPAIGN_DRAFT },
    create: { id: CAMPAIGN_DRAFT, ...draft, createdAt: at(-2, 11 * 60) },
    update: { ...draft, deletedAt: null },
  })

  for (const [campaignId, sequenceId, seq, name] of [
    [CAMPAIGN_LIVE, SEQ_LIVE, 'live', 'Operations Leaders v2'],
    [CAMPAIGN_DRAFT, SEQ_DRAFT, 'draft', 'Renewal Outreach'],
  ] as const) {
    await db.sequence.upsert({
      where: { campaignId },
      create: { id: sequenceId, workspaceId: WS, campaignId, name, version: 1 },
      update: { name },
    })

    // Both mailbox joins point at the one seeded mailbox; rotation across
    // several mailboxes needs a second real OAuth grant to be honest.
    await db.campaignMailbox.upsert({
      where: { campaignId_emailAccountId: { campaignId, emailAccountId: MAILBOX } },
      create: {
        id: `sd_cm_${seq}`,
        workspaceId: WS,
        campaignId,
        emailAccountId: MAILBOX,
        weight: 1,
      },
      update: { weight: 1 },
    })
  }

  await db.campaignLeadListSource.upsert({
    where: { campaignId_leadListId: { campaignId: CAMPAIGN_LIVE, leadListId: 'sd_list_q3' } },
    create: {
      id: 'sd_cls_q3',
      workspaceId: WS,
      campaignId: CAMPAIGN_LIVE,
      leadListId: 'sd_list_q3',
    },
    update: {},
  })

  await db.campaignLeadListSource.upsert({
    where: {
      campaignId_leadListId: { campaignId: CAMPAIGN_DRAFT, leadListId: 'sd_list_conference' },
    },
    create: {
      id: 'sd_cls_conference',
      workspaceId: WS,
      campaignId: CAMPAIGN_DRAFT,
      leadListId: 'sd_list_conference',
    },
    update: {},
  })

  // ── Live sequence: EMAIL → WAIT(3d) → EMAIL → CONDITION. Exercises all
  //    three step types and gives the A/B UI two variants on step 1. ──
  await upsertStep('live', SEQ_LIVE, 1, { type: 'EMAIL', delayMinutes: 0 }, [
    LIVE_STEP1_A,
    LIVE_STEP1_B,
  ])
  await upsertStep('live', SEQ_LIVE, 2, { type: 'WAIT', delayMinutes: 4320 }, [])
  await upsertStep('live', SEQ_LIVE, 3, { type: 'EMAIL', delayMinutes: 0 }, [LIVE_STEP3_A])
  await upsertStep(
    'live',
    SEQ_LIVE,
    4,
    {
      type: 'CONDITION',
      delayMinutes: 2880,
      conditionKind: 'HAS_REPLIED',
      conditionOutcome: 'STOP',
    },
    [],
  )

  // ── Draft sequence: exactly email → wait → email, as specified. ──
  await upsertStep('draft', SEQ_DRAFT, 1, { type: 'EMAIL', delayMinutes: 0 }, [DRAFT_STEP1])
  await upsertStep('draft', SEQ_DRAFT, 2, { type: 'WAIT', delayMinutes: 5760 }, [])
  await upsertStep('draft', SEQ_DRAFT, 3, { type: 'EMAIL', delayMinutes: 0 }, [DRAFT_STEP3])

  // A/B experiment over step 1 of the live campaign. `minSamplePerArm` is the
  // real default: the seeded volume is far below it, so the UI must show raw
  // counts and say the result is not conclusive rather than declare a winner.
  const experiment = {
    workspaceId: WS,
    campaignId: CAMPAIGN_LIVE,
    sequenceStepId: stepId('live', 1),
    name: 'Step 1 subject line',
    primaryMetric: 'reply',
    minSamplePerArm: 100,
    startedAt: at(-14, 8 * 60),
    endedAt: null,
    winnerVariantLabel: null,
  }

  await db.experiment.upsert({
    where: { id: EXPERIMENT },
    create: { id: EXPERIMENT, ...experiment },
    update: experiment,
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// THE OUTREACH HISTORY
//
// One pass over ENROLLMENTS writes CampaignLead, ScheduledEmail, EmailThread,
// EmailMessage and EmailEvent together, and accumulates every counter as it
// goes. Deriving the caches from the same loop that writes the facts is what
// keeps them consistent: a ROLLUP_ANALYTICS run over this data should find
// nothing to change.
// ═══════════════════════════════════════════════════════════════════════════

/** RFC 5322 Message-ID, stored without angle brackets and lowercased — the
 *  normalisation `EmailMessage.rfcMessageId` documents. */
const rfcId = (parts: string) => `${parts}@acme.test`

interface Counters {
  sent: number
  opened: number
  clicked: number
  replied: number
  bounced: number
  unsubscribed: number
  uniqueOpened: number
  uniqueClicked: number
}

const zero = (): Counters => ({
  sent: 0,
  opened: 0,
  clicked: 0,
  replied: 0,
  bounced: 0,
  unsubscribed: 0,
  uniqueOpened: 0,
  uniqueClicked: 0,
})

type EventRow = Prisma.EmailEventCreateManyInput

async function seedOutreachHistory() {
  const events: EventRow[] = []
  const campaign = zero()
  const byStep = new Map<number, Counters>([
    [1, zero()],
    [3, zero()],
  ])
  const byVariant = new Map<string, Counters>([
    ['A', zero()],
    ['B', zero()],
  ])
  /** Keyed by the mailbox's LOCAL day, which is what MailboxDailyStat stores. */
  const daily = new Map<string, Counters>()

  const bump = (
    spec: EnrollmentSpec,
    position: 1 | 3,
    day: number,
    field: keyof Counters,
    n = 1,
  ) => {
    campaign[field] += n
    byStep.get(position)![field] += n
    // Step 3 has a single variant; attributing its events to the step-1 arm the
    // lead was assigned would corrupt the A/B readout.
    if (position === 1) byVariant.get(spec.variant)![field] += n
    const key = localDate(at(day, 9 * 60)).toISOString()
    if (!daily.has(key)) daily.set(key, zero())
    daily.get(key)![field] += n
  }

  for (const spec of ENROLLMENTS) {
    const l = lead(spec.leadKey)
    const company = COMPANIES[l.company]
    const clId = `sd_cl_${spec.leadKey}`
    const threadRowId = `sd_thr_${spec.leadKey}`
    const toEmail = leadEmail(l)

    const hasThread = spec.step1Day !== null
    const step1Sent = spec.step1Day !== null
    const step3 = spec.step3

    // ── Thread. One per enrollment that actually sent something. ──
    const step1MessageId = rfcId(`step1.${spec.leadKey}`)
    const step3MessageId = rfcId(`step3.${spec.leadKey}`)
    const inboundMessageId = `reply.${spec.leadKey}@${company.domain}`

    const lastMessageAt = (() => {
      const candidates: number[] = []
      if (spec.step1Day !== null) candidates.push(at(spec.step1Day, 9 * 60).getTime())
      if (step3.kind === 'sent') candidates.push(at(step3.day, 9 * 60).getTime())
      if (spec.inbound) candidates.push(at(spec.inbound.day, spec.inbound.minute).getTime())
      return new Date(Math.max(...candidates))
    })()

    const isHumanReply = spec.inbound?.classification === 'HUMAN_REPLY'

    // ── Enrollment. CampaignLead and EmailThread reference each other
    //    (`EmailThread.campaignLeadId` ↔ `CampaignLead.primaryThreadId`), so one of
    //    the two must be inserted before the other exists. The enrollment goes
    //    first with a null thread, then the thread, then the back-link below. A
    //    single insert carrying both directions violates whichever FK is checked
    //    first — P2003 on `EmailThread_campaignLeadId_fkey`.
    const sendDays = [
      ...(spec.step1Day !== null ? [spec.step1Day] : []),
      ...(step3.kind === 'sent' ? [step3.day] : []),
    ]
    const openDays = [...spec.opens, ...(step3.kind === 'sent' ? step3.opens : [])]

    const terminal = ['COMPLETED', 'STOPPED', 'REPLIED', 'BOUNCED', 'UNSUBSCRIBED', 'FAILED']
    const isTerminal = terminal.includes(spec.state)

    const currentPosition = step3.kind === 'sent' ? 4 : step1Sent ? 3 : 1

    const clData = {
      workspaceId: WS,
      campaignId: CAMPAIGN_LIVE,
      leadId: leadRowId(spec.leadKey),
      state: spec.state,
      currentStepId: isTerminal ? null : stepId('live', currentPosition),
      lastCompletedPosition: step3.kind === 'sent' ? 3 : step1Sent ? 1 : 0,
      nextStepAt:
        !isTerminal && spec.nextStepInDays !== undefined ? at(spec.nextStepInDays, 9 * 60) : null,
      assignedEmailAccountId: MAILBOX,
      // Set after the thread exists; see the note above.
      primaryThreadId: null,
      stopReason: spec.stopReason ?? null,
      stoppedAt: spec.stopReason
        ? spec.inbound
          ? at(spec.inbound.day, spec.inbound.minute + 4)
          : at(-1, 6 * 60)
        : null,
      enrolledAt: at(-14, 8 * 60),
      startedAt: spec.step1Day !== null ? at(spec.step1Day, 9 * 60) : null,
      completedAt:
        spec.state === 'COMPLETED' && step3.kind === 'sent' ? at(step3.day, 9 * 60) : null,
      sentCount: sendDays.length,
      openCount: openDays.length,
      clickCount: spec.clicks.length,
      replyCount: isHumanReply ? 1 : 0,
      lastSentAt: sendDays.length > 0 ? at(Math.max(...sendDays), 9 * 60) : null,
      lastRepliedAt:
        isHumanReply && spec.inbound ? at(spec.inbound.day, spec.inbound.minute) : null,
    }

    await db.campaignLead.upsert({
      where: { campaignId_leadId: { campaignId: CAMPAIGN_LIVE, leadId: leadRowId(spec.leadKey) } },
      create: { id: clId, ...clData },
      update: clData,
    })

    if (hasThread) {
      const threadData = {
        workspaceId: WS,
        emailAccountId: MAILBOX,
        // Provider ids exist for messages we genuinely sent through a provider.
        // This mailbox never connected, so there is no provider thread id to
        // record and inventing one would fake a Gmail sync that never happened.
        providerThreadId: null,
        rootMessageId: step1MessageId,
        subject: render(LIVE_STEP1_A.subject, l),
        normalizedSubject: render(LIVE_STEP1_A.subject, l).toLowerCase(),
        lastMessageAt,
        lastMessagePreview: spec.inbound
          ? spec.inbound.text.slice(0, 140)
          : render(LIVE_STEP1_A.bodyText, l).slice(0, 140),
        lastMessageDirection: spec.inbound ? ('INBOUND' as const) : ('OUTBOUND' as const),
        messageCount:
          (step1Sent ? 1 : 0) + (step3.kind === 'sent' ? 1 : 0) + (spec.inbound ? 1 : 0),
        participants: [MAILBOX_EMAIL, toEmail],
        // Unread only when a human actually wrote back and nobody has read it.
        isRead: !isHumanReply,
        isArchived: false,
        isStarred: isHumanReply,
        isSpam: false,
        leadId: leadRowId(spec.leadKey),
        campaignId: CAMPAIGN_LIVE,
        campaignLeadId: clId,
        hasHumanReply: isHumanReply,
        firstReplyAt:
          isHumanReply && spec.inbound ? at(spec.inbound.day, spec.inbound.minute) : null,
      }

      await db.emailThread.upsert({
        where: { id: threadRowId },
        create: { id: threadRowId, ...threadData },
        update: threadData,
      })
    }

    if (hasThread) {
      await db.campaignLead.update({
        where: { id: clId },
        data: { primaryThreadId: threadRowId },
      })
    }

    // ── Step 1: the send, its message, and its events. ──
    if (spec.step1Day !== null) {
      const sentAt = at(spec.step1Day, 9 * 60)
      const seId = `sd_se_${spec.leadKey}_1`
      const vId = variantId('live', 1, spec.variant)
      const content = spec.variant === 'A' ? LIVE_STEP1_A : LIVE_STEP1_B
      const bounced = spec.inbound?.classification === 'BOUNCE'

      const seData = {
        workspaceId: WS,
        kind: 'CAMPAIGN_STEP' as const,
        campaignId: CAMPAIGN_LIVE,
        campaignLeadId: clId,
        sequenceStepId: stepId('live', 1),
        variantId: vId,
        sequenceVersion: 1,
        leadId: leadRowId(spec.leadKey),
        emailAccountId: MAILBOX,
        toEmail,
        subject: render(content.subject, l),
        bodyHtml: render(content.bodyHtml, l),
        bodyText: render(content.bodyText, l),
        threadId: threadRowId,
        state: bounced ? ('BOUNCED' as const) : ('SENT' as const),
        scheduledAt: at(spec.step1Day, 8 * 60 + 40),
        claimedAt: sentAt,
        claimedBy: 'seed',
        sentAt,
        rfcMessageId: step1MessageId,
        providerMessageId: null,
        attemptCount: 1,
        dedupeKey: `campaign_step:${clId}:${stepId('live', 1)}:v1`,
      }

      await db.scheduledEmail.upsert({
        where: { id: seId },
        create: { id: seId, ...seData },
        update: seData,
      })

      const msgId = `sd_msg_${spec.leadKey}_1`
      const msgData = {
        workspaceId: WS,
        emailAccountId: MAILBOX,
        threadId: threadRowId,
        direction: 'OUTBOUND' as const,
        // Deterministic stand-in for a provider id. Required and unique per
        // mailbox; prefixed `seed:` so it is obviously not a Gmail id.
        providerMessageId: `seed:${spec.leadKey}:1`,
        rfcMessageId: step1MessageId,
        inReplyTo: null,
        references: [],
        fromEmail: MAILBOX_EMAIL,
        fromName: 'Alex Fenwick',
        toEmails: [toEmail],
        subject: render(content.subject, l),
        snippet: render(content.bodyText, l).slice(0, 140),
        bodyHtml: render(content.bodyHtml, l),
        bodyText: render(content.bodyText, l),
        classification: 'UNCLASSIFIED' as const,
        scheduledEmailId: seId,
        campaignLeadId: clId,
        sentAt,
        isRead: true,
      }

      await db.emailMessage.upsert({
        where: {
          emailAccountId_providerMessageId: {
            emailAccountId: MAILBOX,
            providerMessageId: msgData.providerMessageId,
          },
        },
        create: { id: msgId, ...msgData },
        update: msgData,
      })

      const dims = {
        workspaceId: WS,
        campaignId: CAMPAIGN_LIVE,
        campaignLeadId: clId,
        sequenceStepId: stepId('live', 1),
        variantId: vId,
        leadId: leadRowId(spec.leadKey),
        emailAccountId: MAILBOX,
        scheduledEmailId: seId,
        threadId: threadRowId,
      }

      events.push({
        ...dims,
        type: 'QUEUED',
        emailMessageId: null,
        occurredAt: at(spec.step1Day, 8 * 60 + 40),
        isFirstForSend: true,
        dedupeKey: `${EVENT_NS}:queued:${seId}`,
      })
      events.push({
        ...dims,
        type: 'SENT',
        emailMessageId: msgId,
        occurredAt: sentAt,
        isFirstForSend: true,
        dedupeKey: `${EVENT_NS}:sent:${seId}`,
      })
      bump(spec, 1, spec.step1Day, 'sent')

      spec.opens.forEach((day, i) => {
        events.push({
          ...dims,
          type: 'OPENED',
          emailMessageId: msgId,
          occurredAt: at(day, 10 * 60 + 30 + i * 17),
          // Open tracking is pixel-based and indicative only; a plausible
          // desktop UA keeps the analytics page honest about where it came from.
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
          isFirstForSend: i === 0,
          dedupeKey: `${EVENT_NS}:opened:${seId}:${i}`,
        })
        bump(spec, 1, day, 'opened')
        if (i === 0) bump(spec, 1, day, 'uniqueOpened')
      })

      spec.clicks.forEach((day, i) => {
        events.push({
          ...dims,
          type: 'CLICKED',
          emailMessageId: msgId,
          occurredAt: at(day, 11 * 60 + 12 + i * 23),
          metadata: { url: 'https://www.acme.test/case-studies/operations' },
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
          isFirstForSend: i === 0,
          dedupeKey: `${EVENT_NS}:clicked:${seId}:${i}`,
        })
        bump(spec, 1, day, 'clicked')
        if (i === 0) bump(spec, 1, day, 'uniqueClicked')
      })
    }

    // ── Step 3: sent, still scheduled, or cancelled. ──
    if (step3.kind === 'sent') {
      const sentAt = at(step3.day, 9 * 60)
      const seId = `sd_se_${spec.leadKey}_3`
      const vId = variantId('live', 3, 'A')

      const seData = {
        workspaceId: WS,
        kind: 'CAMPAIGN_STEP' as const,
        campaignId: CAMPAIGN_LIVE,
        campaignLeadId: clId,
        sequenceStepId: stepId('live', 3),
        variantId: vId,
        sequenceVersion: 1,
        leadId: leadRowId(spec.leadKey),
        emailAccountId: MAILBOX,
        toEmail,
        // Empty variant subject means "reply in thread", so the follow-up
        // carries the original subject with an Re: prefix.
        subject: `Re: ${render(LIVE_STEP1_A.subject, l)}`,
        bodyHtml: render(LIVE_STEP3_A.bodyHtml, l),
        bodyText: render(LIVE_STEP3_A.bodyText, l),
        threadId: threadRowId,
        inReplyToMessageId: `<${step1MessageId}>`,
        referencesHeader: `<${step1MessageId}>`,
        state: 'SENT' as const,
        scheduledAt: at(step3.day, 8 * 60 + 40),
        claimedAt: sentAt,
        claimedBy: 'seed',
        sentAt,
        rfcMessageId: step3MessageId,
        attemptCount: 1,
        dedupeKey: `campaign_step:${clId}:${stepId('live', 3)}:v1`,
      }

      await db.scheduledEmail.upsert({
        where: { id: seId },
        create: { id: seId, ...seData },
        update: seData,
      })

      const msgId = `sd_msg_${spec.leadKey}_3`
      const msgData = {
        workspaceId: WS,
        emailAccountId: MAILBOX,
        threadId: threadRowId,
        direction: 'OUTBOUND' as const,
        providerMessageId: `seed:${spec.leadKey}:3`,
        rfcMessageId: step3MessageId,
        inReplyTo: step1MessageId,
        references: [step1MessageId],
        fromEmail: MAILBOX_EMAIL,
        fromName: 'Alex Fenwick',
        toEmails: [toEmail],
        subject: seData.subject,
        snippet: render(LIVE_STEP3_A.bodyText, l).slice(0, 140),
        bodyHtml: render(LIVE_STEP3_A.bodyHtml, l),
        bodyText: render(LIVE_STEP3_A.bodyText, l),
        classification: 'UNCLASSIFIED' as const,
        scheduledEmailId: seId,
        campaignLeadId: clId,
        sentAt,
        isRead: true,
      }

      await db.emailMessage.upsert({
        where: {
          emailAccountId_providerMessageId: {
            emailAccountId: MAILBOX,
            providerMessageId: msgData.providerMessageId,
          },
        },
        create: { id: msgId, ...msgData },
        update: msgData,
      })

      const dims = {
        workspaceId: WS,
        campaignId: CAMPAIGN_LIVE,
        campaignLeadId: clId,
        sequenceStepId: stepId('live', 3),
        variantId: vId,
        leadId: leadRowId(spec.leadKey),
        emailAccountId: MAILBOX,
        scheduledEmailId: seId,
        threadId: threadRowId,
      }

      events.push({
        ...dims,
        type: 'QUEUED',
        occurredAt: at(step3.day, 8 * 60 + 40),
        isFirstForSend: true,
        dedupeKey: `${EVENT_NS}:queued:${seId}`,
      })
      events.push({
        ...dims,
        type: 'SENT',
        emailMessageId: msgId,
        occurredAt: sentAt,
        isFirstForSend: true,
        dedupeKey: `${EVENT_NS}:sent:${seId}`,
      })
      bump(spec, 3, step3.day, 'sent')

      step3.opens.forEach((day, i) => {
        events.push({
          ...dims,
          type: 'OPENED',
          emailMessageId: msgId,
          occurredAt: at(day, 14 * 60 + 8 + i * 19),
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15',
          isFirstForSend: i === 0,
          dedupeKey: `${EVENT_NS}:opened:${seId}:${i}`,
        })
        bump(spec, 3, day, 'opened')
        if (i === 0) bump(spec, 3, day, 'uniqueOpened')
      })
    }

    if (step3.kind === 'pending') {
      // A genuinely future SCHEDULED row. The campaign is PAUSED, so no worker
      // will claim it — which is exactly the state a paused campaign leaves
      // behind, and what the enrollment table needs to render.
      const seId = `sd_se_${spec.leadKey}_3`
      const seData = {
        workspaceId: WS,
        kind: 'CAMPAIGN_STEP' as const,
        campaignId: CAMPAIGN_LIVE,
        campaignLeadId: clId,
        sequenceStepId: stepId('live', 3),
        variantId: variantId('live', 3, 'A'),
        sequenceVersion: 1,
        leadId: leadRowId(spec.leadKey),
        emailAccountId: MAILBOX,
        toEmail,
        subject: `Re: ${render(LIVE_STEP1_A.subject, l)}`,
        bodyHtml: render(LIVE_STEP3_A.bodyHtml, l),
        bodyText: render(LIVE_STEP3_A.bodyText, l),
        threadId: threadRowId,
        inReplyToMessageId: `<${step1MessageId}>`,
        referencesHeader: `<${step1MessageId}>`,
        state: 'SCHEDULED' as const,
        scheduledAt: at(step3.day, 9 * 60),
        attemptCount: 0,
        dedupeKey: `campaign_step:${clId}:${stepId('live', 3)}:v1`,
      }

      await db.scheduledEmail.upsert({
        where: { id: seId },
        create: { id: seId, ...seData },
        update: seData,
      })
    }

    if (step3.kind === 'cancelled') {
      const seId = `sd_se_${spec.leadKey}_3`
      const cancelledAt = spec.inbound
        ? at(spec.inbound.day, spec.inbound.minute + 4)
        : at(-1, 6 * 60)

      const seData = {
        workspaceId: WS,
        kind: 'CAMPAIGN_STEP' as const,
        campaignId: CAMPAIGN_LIVE,
        campaignLeadId: clId,
        sequenceStepId: stepId('live', 3),
        variantId: variantId('live', 3, 'A'),
        sequenceVersion: 1,
        leadId: leadRowId(spec.leadKey),
        emailAccountId: MAILBOX,
        toEmail,
        subject: `Re: ${render(LIVE_STEP1_A.subject, l)}`,
        bodyHtml: render(LIVE_STEP3_A.bodyHtml, l),
        bodyText: render(LIVE_STEP3_A.bodyText, l),
        threadId: threadRowId,
        state: 'CANCELLED' as const,
        scheduledAt: at(spec.step1Day! + 3, 9 * 60),
        cancelledAt,
        cancelledReason: step3.reason,
        attemptCount: 0,
        dedupeKey: `campaign_step:${clId}:${stepId('live', 3)}:v1`,
      }

      await db.scheduledEmail.upsert({
        where: { id: seId },
        create: { id: seId, ...seData },
        update: seData,
      })
    }

    // ── Inbound. The reply, auto-reply, bounce, or unsubscribe request. ──
    if (spec.inbound) {
      const inb = spec.inbound
      const occurredAt = at(inb.day, inb.minute)
      const msgId = `sd_msg_${spec.leadKey}_in`
      const isBounce = inb.classification === 'BOUNCE'

      const msgData = {
        workspaceId: WS,
        emailAccountId: MAILBOX,
        threadId: threadRowId,
        direction: 'INBOUND' as const,
        providerMessageId: `seed:${spec.leadKey}:in`,
        rfcMessageId: inboundMessageId,
        inReplyTo: step1MessageId,
        references: [step1MessageId],
        // A DSN comes from the receiving mail system, not from the human — the
        // distinction bounce attribution depends on.
        fromEmail: isBounce ? `mailer-daemon@${company.domain}` : toEmail,
        fromName: isBounce ? 'Mail Delivery Subsystem' : `${l.first} ${l.last}`,
        toEmails: [MAILBOX_EMAIL],
        subject: inb.subject,
        snippet: inb.text.slice(0, 140),
        bodyText: inb.text,
        bodyHtml: `<p>${inb.text.replaceAll('\n\n', '</p><p>').replaceAll('\n', '<br />')}</p>`,
        // Headers we must not lose, per the schema comment. An OOO carries
        // Auto-Submitted; an unsubscribe request is a plain human mail.
        headers:
          inb.classification === 'OUT_OF_OFFICE'
            ? ({
                'Auto-Submitted': 'auto-replied',
                Precedence: 'bulk',
              } satisfies Prisma.InputJsonValue)
            : isBounce
              ? ({
                  'Auto-Submitted': 'auto-replied',
                  'Return-Path': '<>',
                } satisfies Prisma.InputJsonValue)
              : ({
                  'Authentication-Results': `mx.acme.test; spf=pass smtp.mailfrom=${company.domain}`,
                } satisfies Prisma.InputJsonValue),
        classification: inb.classification,
        // Header and pattern rules produced these labels, not a model call. The
        // AI attribution below is a separate, explicitly-flagged row.
        classifiedByAi: false,
        classifiedAt: occurredAt,
        bounceType: inb.bounce ? inb.bounce.type : ('NONE' as const),
        bounceCode: inb.bounce?.code ?? null,
        bouncedRecipient: inb.bounce ? toEmail : null,
        scheduledEmailId: `sd_se_${spec.leadKey}_1`,
        campaignLeadId: clId,
        sentAt: occurredAt,
        isRead: inb.classification !== 'HUMAN_REPLY',
      }

      await db.emailMessage.upsert({
        where: {
          emailAccountId_providerMessageId: {
            emailAccountId: MAILBOX,
            providerMessageId: msgData.providerMessageId,
          },
        },
        create: { id: msgId, ...msgData },
        update: msgData,
      })

      const dims = {
        workspaceId: WS,
        campaignId: CAMPAIGN_LIVE,
        campaignLeadId: clId,
        sequenceStepId: stepId('live', 1),
        variantId: variantId('live', 1, spec.variant),
        leadId: leadRowId(spec.leadKey),
        emailAccountId: MAILBOX,
        scheduledEmailId: `sd_se_${spec.leadKey}_1`,
        threadId: threadRowId,
        emailMessageId: msgId,
      }

      // An OUT_OF_OFFICE produces NO event. It is not a reply, it did not stop
      // the sequence, and counting it would inflate the reply rate — the exact
      // dishonesty the classification step exists to prevent.
      if (inb.classification === 'HUMAN_REPLY') {
        events.push({
          ...dims,
          type: 'REPLIED',
          occurredAt,
          isFirstForSend: true,
          dedupeKey: `${EVENT_NS}:replied:${msgId}`,
        })
        bump(spec, 1, inb.day, 'replied')
      } else if (isBounce) {
        events.push({
          ...dims,
          type: 'BOUNCED',
          occurredAt,
          metadata: {
            code: inb.bounce?.code ?? null,
            type: inb.bounce?.type ?? null,
            dsn: '550 5.1.1 User unknown',
          },
          isFirstForSend: true,
          dedupeKey: `${EVENT_NS}:bounced:${msgId}`,
        })
        bump(spec, 1, inb.day, 'bounced')
      } else if (inb.classification === 'UNSUBSCRIBE_REQUEST') {
        events.push({
          ...dims,
          type: 'UNSUBSCRIBED',
          occurredAt,
          isFirstForSend: true,
          dedupeKey: `${EVENT_NS}:unsub:${msgId}`,
        })
        bump(spec, 1, inb.day, 'unsubscribed')
      }
    }
  }

  // ── Events. Insert-only: the append-only trigger forbids anything else, so
  //    idempotency rests entirely on the unique dedupeKey. The second run
  //    inserts zero rows. ──
  const inserted = await db.emailEvent.createMany({ data: events, skipDuplicates: true })

  // ── Counter caches, written from the same tallies that produced the events. ──
  await db.campaign.update({
    where: { id: CAMPAIGN_LIVE },
    data: {
      leadCount: ENROLLMENTS.length,
      sentCount: campaign.sent,
      // Gmail does not report delivery, so this stays 0 rather than being
      // inferred from sends. Reporting a metric we cannot observe is a lie.
      deliveredCount: 0,
      openedCount: campaign.opened,
      clickedCount: campaign.clicked,
      repliedCount: campaign.replied,
      bouncedCount: campaign.bounced,
      unsubscribedCount: campaign.unsubscribed,
      uniqueOpenedCount: campaign.uniqueOpened,
      uniqueClickedCount: campaign.uniqueClicked,
      statsUpdatedAt: at(0, 6 * 60),
    },
  })

  await db.campaign.update({
    where: { id: CAMPAIGN_DRAFT },
    data: { leadCount: 0, statsUpdatedAt: null },
  })

  for (const [position, c] of byStep) {
    await db.sequenceStep.update({
      where: { id: stepId('live', position) },
      data: {
        sentCount: c.sent,
        openedCount: c.opened,
        clickedCount: c.clicked,
        repliedCount: c.replied,
        bouncedCount: c.bounced,
      },
    })
  }

  for (const [label, c] of byVariant) {
    await db.sequenceStepVariant.update({
      where: { id: variantId('live', 1, label) },
      data: {
        sentCount: c.sent,
        openedCount: c.opened,
        clickedCount: c.clicked,
        repliedCount: c.replied,
        bouncedCount: c.bounced,
      },
    })
  }

  const step3 = byStep.get(3)!
  await db.sequenceStepVariant.update({
    where: { id: variantId('live', 3, 'A') },
    data: {
      sentCount: step3.sent,
      openedCount: step3.opened,
      clickedCount: step3.clicked,
      repliedCount: step3.replied,
      bouncedCount: step3.bounced,
    },
  })

  // Experiment arms are caches recomputed by ROLLUP_ANALYTICS, never the truth.
  // `pValue` stays null: both arms are far below minSamplePerArm, and a p-value
  // on eight sends would be a number that means nothing.
  for (const label of ['A', 'B'] as const) {
    const c = byVariant.get(label)!
    const armData = {
      workspaceId: WS,
      experimentId: EXPERIMENT,
      variantId: variantId('live', 1, label),
      sentCount: c.sent,
      openedCount: c.opened,
      clickedCount: c.clicked,
      repliedCount: c.replied,
      bouncedCount: c.bounced,
      uniqueOpenedCount: c.uniqueOpened,
      uniqueClickedCount: c.uniqueClicked,
      pValue: null,
      computedAt: at(0, 6 * 60),
    }
    await db.experimentArm.upsert({
      where: {
        experimentId_variantId: {
          experimentId: EXPERIMENT,
          variantId: variantId('live', 1, label),
        },
      },
      create: { id: `sd_arm_${label.toLowerCase()}`, ...armData },
      update: armData,
    })
  }

  // ── Mailbox rollups. 14 local days, so the deliverability chart has a real
  //    series with quiet days in it rather than one spike. ──
  const mailboxTotals = zero()
  for (let d = -13; d <= 0; d += 1) {
    const key = localDate(at(d, 9 * 60)).toISOString()
    const c = daily.get(key) ?? zero()
    mailboxTotals.sent += c.sent
    mailboxTotals.bounced += c.bounced
    mailboxTotals.replied += c.replied
    mailboxTotals.clicked += c.clicked
    mailboxTotals.opened += c.opened

    const statData = {
      workspaceId: WS,
      emailAccountId: MAILBOX,
      sentCount: c.sent,
      warmupCount: 0,
      failedCount: 0,
      bouncedCount: c.bounced,
      repliedCount: c.replied,
      openedCount: c.opened,
      clickedCount: c.clicked,
    }

    await db.mailboxDailyStat.upsert({
      where: {
        emailAccountId_localDate: {
          emailAccountId: MAILBOX,
          localDate: new Date(key),
        },
      },
      create: { id: `sd_mds_${d + 13}`, localDate: new Date(key), ...statData },
      update: statData,
    })
  }

  await db.emailAccount.update({
    where: { id: MAILBOX },
    data: {
      sentCount: mailboxTotals.sent,
      bouncedCount: mailboxTotals.bounced,
      repliedCount: mailboxTotals.replied,
      complainedCount: 0,
      lastSentAt: at(-5, 9 * 60),
      // Health is dinged by the bounce and by being disconnected — a mailbox
      // that cannot send is not in perfect health, and showing 100 would be
      // reassuring nonsense.
      healthScore: 68,
    },
  })

  return { eventsInserted: inserted.count, eventsDeclared: events.length }
}

// ═══════════════════════════════════════════════════════════════════════════
// CRM — opportunities, tasks, notes
// ═══════════════════════════════════════════════════════════════════════════

async function seedCrm() {
  const opportunities = [
    {
      id: 'sd_opp_northwind',
      leadKey: 'priya',
      name: 'Northwind Robotics — Operations rollout',
      stage: 'MEETING_BOOKED' as const,
      value: new Prisma.Decimal('48000.00'),
      probability: 45,
      expectedCloseAt: at(45, 12 * 60),
      position: 0,
    },
    {
      id: 'sd_opp_lumen',
      leadKey: 'amara',
      name: 'Lumen Health — Reporting pilot',
      stage: 'QUALIFYING' as const,
      value: new Prisma.Decimal('19500.00'),
      probability: 20,
      expectedCloseAt: at(70, 12 * 60),
      position: 0,
    },
  ]

  for (const o of opportunities) {
    const data = {
      workspaceId: WS,
      name: o.name,
      stage: o.stage,
      value: o.value,
      currency: 'EUR',
      probability: o.probability,
      expectedCloseAt: o.expectedCloseAt,
      ownerUserId: USER,
      leadId: leadRowId(o.leadKey),
      campaignId: CAMPAIGN_LIVE,
      campaignLeadId: `sd_cl_${o.leadKey}`,
      threadId: `sd_thr_${o.leadKey}`,
      position: o.position,
    }
    await db.opportunity.upsert({
      where: { id: o.id },
      create: { id: o.id, ...data },
      update: data,
    })
  }

  const tasks = [
    {
      id: 'sd_task_priya',
      title: 'Send Thursday calendar options to Priya Raman',
      description: 'She asked for Thursday afternoon. Offer 14:00 and 16:00 CET.',
      status: 'IN_PROGRESS' as const,
      priority: 'HIGH' as const,
      // Overdue on purpose, so the "overdue" state is visible on a fresh clone.
      dueAt: at(-2, 16 * 60),
      leadKey: 'priya',
      opportunityId: 'sd_opp_northwind',
    },
    {
      id: 'sd_task_amara',
      title: 'Introduce Amara Nwosu to procurement',
      description: 'She offered a procurement contact. Get the name and loop them in.',
      status: 'OPEN' as const,
      priority: 'NORMAL' as const,
      dueAt: at(2, 10 * 60),
      leadKey: 'amara',
      opportunityId: 'sd_opp_lumen',
    },
    {
      id: 'sd_task_elena',
      title: 'Set a January reminder for Elena Vasquez',
      description: 'Asked to be re-contacted in January rather than this quarter.',
      status: 'OPEN' as const,
      priority: 'LOW' as const,
      dueAt: at(9, 9 * 60),
      leadKey: 'elena',
      opportunityId: null,
    },
  ]

  for (const t of tasks) {
    const data = {
      workspaceId: WS,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      dueAt: t.dueAt,
      assigneeUserId: USER,
      createdByUserId: USER,
      leadId: leadRowId(t.leadKey),
      threadId: `sd_thr_${t.leadKey}`,
      opportunityId: t.opportunityId,
    }
    await db.task.upsert({ where: { id: t.id }, create: { id: t.id, ...data }, update: data })
  }

  const notes = [
    {
      id: 'sd_note_priya',
      leadKey: 'priya',
      opportunityId: 'sd_opp_northwind',
      body:
        'Priya owns the tooling budget outright — no procurement gate below €50k. ' +
        'Her constraint is the reporting cycle, not headcount. Lead with the fortnight-to-afternoon story.',
    },
    {
      id: 'sd_note_amara',
      leadKey: 'amara',
      opportunityId: 'sd_opp_lumen',
      body:
        'Healthcare, so expect a data-processing review before any pilot. ' +
        'Ask for the DPA template on the first call rather than discovering it at signature.',
    },
  ]

  for (const n of notes) {
    const data = {
      workspaceId: WS,
      body: n.body,
      authorUserId: USER,
      leadId: leadRowId(n.leadKey),
      threadId: `sd_thr_${n.leadKey}`,
      opportunityId: n.opportunityId,
    }
    await db.note.upsert({ where: { id: n.id }, create: { id: n.id, ...data }, update: data })
  }
}

async function seedAiAnalysis() {
  // One classification, stored with model, prompt version and confidence, and
  // attributed as AI-generated. `acceptedByHuman` is false: nobody has reviewed
  // it, and pre-accepting our own seed data would misrepresent the review state.
  const analyses = [
    {
      leadKey: 'priya',
      classification: 'HUMAN_REPLY' as const,
      sentiment: 'POSITIVE' as const,
      confidence: '0.940',
      summary:
        'Positive reply requesting a Thursday afternoon meeting. Buying intent, not a brush-off.',
      output: {
        classification: 'HUMAN_REPLY',
        sentiment: 'POSITIVE',
        intent: 'MEETING_REQUEST',
        rationale: 'Explicit availability proposed and an internal review already scheduled.',
      } satisfies Prisma.InputJsonValue,
    },
    {
      leadKey: 'elena',
      classification: 'HUMAN_REPLY' as const,
      sentiment: 'NEUTRAL' as const,
      confidence: '0.810',
      summary:
        'Human reply deferring to January. Not a rejection; worth a reminder, not a follow-up now.',
      output: {
        classification: 'HUMAN_REPLY',
        sentiment: 'NEUTRAL',
        intent: 'DEFER',
        rationale: 'Declines the current quarter while explicitly asking to stay on the list.',
      } satisfies Prisma.InputJsonValue,
    },
  ]

  for (const a of analyses) {
    const msgId = `sd_msg_${a.leadKey}_in`
    const data = {
      workspaceId: WS,
      targetType: 'EMAIL_MESSAGE' as const,
      targetId: msgId,
      kind: 'REPLY_CLASSIFICATION' as const,
      emailMessageId: msgId,
      threadId: `sd_thr_${a.leadKey}`,
      leadId: leadRowId(a.leadKey),
      campaignId: CAMPAIGN_LIVE,
      campaignLeadId: `sd_cl_${a.leadKey}`,
      model: process.env.AI_MODEL ?? 'claude-sonnet-5',
      promptVersion: 'reply-classify.v1',
      output: a.output,
      classification: a.classification,
      sentiment: a.sentiment,
      confidence: new Prisma.Decimal(a.confidence),
      summary: a.summary,
      inputTokens: 512,
      outputTokens: 96,
      latencyMs: 1240,
      acceptedByHuman: false,
    }

    await db.aIAnalysis.upsert({
      where: {
        targetType_targetId_kind_promptVersion: {
          targetType: 'EMAIL_MESSAGE',
          targetId: msgId,
          kind: 'REPLY_CLASSIFICATION',
          promptVersion: 'reply-classify.v1',
        },
      },
      create: { id: `sd_ai_${a.leadKey}`, ...data },
      update: data,
    })
  }
}

/**
 * The human-facing timeline. Derived and presentational, so it is rebuilt from
 * scratch each run — it has no dependents and no append-only trigger, unlike
 * EmailEvent, which it must not be confused with.
 */
async function seedActivity() {
  await db.activity.deleteMany({ where: { workspaceId: WS } })

  const rows: Prisma.ActivityCreateManyInput[] = []

  for (const spec of ENROLLMENTS) {
    const l = lead(spec.leadKey)
    const base = {
      workspaceId: WS,
      leadId: leadRowId(spec.leadKey),
      campaignLeadId: `sd_cl_${spec.leadKey}`,
    }

    rows.push({
      ...base,
      type: 'ENROLLED',
      summary: `${l.first} ${l.last} enrolled in Q3 Outbound — Operations Leaders`,
      actorUserId: USER,
      occurredAt: at(-14, 8 * 60),
    })

    if (spec.step1Day !== null) {
      rows.push({
        ...base,
        type: 'EMAIL_SENT',
        summary: `Step 1 sent to ${leadEmail(l)}`,
        occurredAt: at(spec.step1Day, 9 * 60),
      })
    }

    if (spec.step3.kind === 'sent') {
      rows.push({
        ...base,
        type: 'EMAIL_SENT',
        summary: `Step 3 follow-up sent to ${leadEmail(l)}`,
        occurredAt: at(spec.step3.day, 9 * 60),
      })
    }

    const first = spec.opens[0]
    if (first !== undefined) {
      rows.push({
        ...base,
        type: 'EMAIL_OPENED',
        summary: 'Opened step 1 (open tracking is indicative — many clients block the pixel)',
        occurredAt: at(first, 10 * 60 + 30),
      })
    }

    const firstClick = spec.clicks[0]
    if (firstClick !== undefined) {
      rows.push({
        ...base,
        type: 'EMAIL_CLICKED',
        summary: 'Clicked the operations case study link',
        occurredAt: at(firstClick, 11 * 60 + 12),
      })
    }

    if (spec.inbound) {
      const inb = spec.inbound
      if (inb.classification === 'HUMAN_REPLY') {
        rows.push({
          ...base,
          type: 'EMAIL_REPLIED',
          summary: `${l.first} replied — sequence stopped`,
          occurredAt: at(inb.day, inb.minute),
        })
        rows.push({
          ...base,
          type: 'AI_CLASSIFIED',
          summary: 'AI classified the reply as a human reply (AI-generated, unreviewed)',
          occurredAt: at(inb.day, inb.minute + 2),
        })
      } else if (inb.classification === 'BOUNCE') {
        rows.push({
          ...base,
          type: 'EMAIL_BOUNCED',
          summary: 'Hard bounce 5.1.1 — address suppressed',
          occurredAt: at(inb.day, inb.minute),
        })
      } else if (inb.classification === 'UNSUBSCRIBE_REQUEST') {
        rows.push({
          ...base,
          type: 'UNSUBSCRIBED',
          summary: 'Asked to be removed — suppressed and sequence stopped',
          occurredAt: at(inb.day, inb.minute),
        })
      }
    }

    if (spec.stopReason) {
      rows.push({
        ...base,
        type: 'SEQUENCE_STOPPED',
        summary: `Sequence stopped: ${spec.stopReason.toLowerCase().replaceAll('_', ' ')}`,
        occurredAt: spec.inbound ? at(spec.inbound.day, spec.inbound.minute + 4) : at(-1, 6 * 60),
      })
    }
  }

  rows.push(
    {
      workspaceId: WS,
      type: 'OPPORTUNITY_CREATED',
      summary: 'Opportunity created: Northwind Robotics — Operations rollout',
      actorUserId: USER,
      leadId: leadRowId('priya'),
      opportunityId: 'sd_opp_northwind',
      occurredAt: at(-9, 12 * 60),
    },
    {
      workspaceId: WS,
      type: 'OPPORTUNITY_STAGE_CHANGED',
      summary: 'Northwind Robotics moved from Qualifying to Meeting booked',
      actorUserId: USER,
      leadId: leadRowId('priya'),
      opportunityId: 'sd_opp_northwind',
      occurredAt: at(-7, 15 * 60),
    },
    {
      workspaceId: WS,
      type: 'OPPORTUNITY_CREATED',
      summary: 'Opportunity created: Lumen Health — Reporting pilot',
      actorUserId: USER,
      leadId: leadRowId('amara'),
      opportunityId: 'sd_opp_lumen',
      occurredAt: at(-7, 10 * 60),
    },
    {
      workspaceId: WS,
      type: 'NOTE_ADDED',
      summary: 'Note added on Priya Raman',
      actorUserId: USER,
      leadId: leadRowId('priya'),
      opportunityId: 'sd_opp_northwind',
      occurredAt: at(-9, 13 * 60),
    },
    {
      workspaceId: WS,
      type: 'TASK_CREATED',
      summary: 'Task created: Send Thursday calendar options to Priya Raman',
      actorUserId: USER,
      leadId: leadRowId('priya'),
      opportunityId: 'sd_opp_northwind',
      occurredAt: at(-9, 13 * 60 + 5),
    },
  )

  await db.activity.createMany({ data: rows })
  return rows.length
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTRYPOINT
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const startedAt = Date.now()

  await seedIdentity()
  await seedMailbox()
  await seedTaxonomy()
  await seedLeads()
  await seedSuppressions()
  await seedCampaigns()
  const { eventsInserted, eventsDeclared } = await seedOutreachHistory()
  await seedCrm()
  await seedAiAnalysis()
  const activityCount = await seedActivity()

  const [leads, threads, messages, scheduled, totalEvents] = await Promise.all([
    db.lead.count({ where: { workspaceId: WS } }),
    db.emailThread.count({ where: { workspaceId: WS } }),
    db.emailMessage.count({ where: { workspaceId: WS } }),
    db.scheduledEmail.count({ where: { workspaceId: WS } }),
    db.emailEvent.count({ where: { workspaceId: WS } }),
  ])

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)

  console.log(`
Seed complete in ${seconds}s.

  Workspace          Acme Outreach (acme) — ${TZ}
  Leads              ${leads}   (includes 1 deliberate near-duplicate: priya.raman / p.raman @ northwind.example)
  Lead lists         ${LISTS.length}     Tags ${TAGS.length}     Custom fields ${CUSTOM_FIELDS.length}
  Campaigns          2     (Q3 Outbound = PAUSED with history, Autumn Renewals = DRAFT)
  Enrollments        ${ENROLLMENTS.length}
  Threads            ${threads}     Messages ${messages}     Scheduled emails ${scheduled}
  EmailEvents        ${totalEvents}    (${eventsInserted} inserted this run of ${eventsDeclared} declared)
  Activity           ${activityCount}

  Log in at /login
    email     ${DEMO_EMAIL}
    password  ${DEMO_PASSWORD}

  Honest states, not decoration:
    - Mailbox ${MAILBOX_EMAIL} is DISCONNECTED. No OAuth token exists, so it cannot
      send. Connect it from Mailboxes to make sending real.
    - Q3 Outbound is PAUSED, not ACTIVE: an ACTIVE campaign with a disconnected
      mailbox would fail every enrollment the moment the scheduler ran.
    - deliveredCount is 0 everywhere. Gmail does not report delivery, so there is
      no honest number to seed.
    - The A/B experiment is far below minSamplePerArm and its pValue is null. The
      UI must show raw counts and say the result is not conclusive.
`)
}

try {
  await main()
} catch (error) {
  console.error('\nSeed failed.')
  console.error(error)
  await db.$disconnect()
  process.exit(1)
} finally {
  await db.$disconnect()
}
