import { beforeAll, describe, expect, test } from 'bun:test'
import type { Role } from '@prisma/client'

/**
 * The capability matrix, pinned.
 *
 * These tests assert the matrix AS IMPLEMENTED in src/server/authz.ts, which is
 * the authority. Where `07-auth-and-security.md` §9.4 and the code disagree on
 * `campaigns.launch`, DECISIONS.md D1 settles it: the lead OVERRULED the doc and
 * MEMBER may launch. A test that asserted the doc's ADMIN-only row would fail
 * against correct code, so the doc's §9.4 launch row is deliberately not asserted.
 *
 * `authz.ts` reaches `@/lib/logger`, which reaches `@/lib/env`, which validates at
 * module load — so env is populated before the dynamic import.
 */

type AuthzModule = typeof import('@/server/authz')
type Capability = AuthzModule['MATRIX'] extends Readonly<Record<infer C, unknown>> ? C : never

let authz: AuthzModule
/** A minimal Ctx for a role. Only `role` and the two log fields are read. */
let ctxFor: (role: Role) => Parameters<AuthzModule['can']>[0]

beforeAll(async () => {
  // NODE_ENV is typed readonly, so assign through the record index.
  ;(process.env as Record<string, string | undefined>).NODE_ENV = 'test'
  process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5433/db?schema=public'
  process.env.APP_URL = 'http://localhost:3000'
  process.env.AUTH_SECRET = 'x'.repeat(32)
  process.env.WORKER_AUTH_TOKEN = 'y'.repeat(16)

  // ── A note on why these two lines look over-specified.
  //
  // `lib/env.ts` parses `process.env` ONCE at first import and caches it, so
  // whichever unit-test file imports it first fixes the configuration for the whole
  // run and every later file's own assignments are silently ignored. That makes any
  // env value a shared resource across the suite, not a per-file fixture.
  //
  // Two consequences, both found by running the suite rather than by reading it:
  //   · LOG_LEVEL is deliberately NOT set here. Pinning it to 'error' suppressed the
  //     `info` lines tests/unit/logger.test.ts captures, failing 24 of its tests
  //     whenever this file happened to load first. The deny warnings this suite
  //     provokes on purpose are muted per-assertion by `quietly()` instead.
  //   · ENCRYPTION_KEY / ENCRYPTION_KEY_PREVIOUS match the constants
  //     tests/unit/crypto.test.ts asserts against. Omitting the PREVIOUS key left it
  //     undefined for that file's rotation test, which then threw on a missing
  //     key version.
  //
  // Flagged for the lead: the durable fix is one shared env preamble for tests/unit,
  // not N files each hoping to lose the import race. See the returned notes.
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64')
  process.env.ENCRYPTION_KEY_PREVIOUS = Buffer.alloc(32, 2).toString('base64')

  authz = await import('@/server/authz')
  ctxFor = (role) => ({
    userId: 'user_test',
    workspaceId: 'ws_test',
    role,
    sessionId: 'sess_test',
    timezone: 'UTC',
  })
})

/**
 * Runs `fn` with the logger's sinks muted.
 *
 * `requireCan` and `assertRoleChangeAllowed` log every denial at `warn`, which is
 * correct behaviour and exactly what these tests provoke on purpose. Muting the two
 * console methods for the duration of one call keeps the suite's output readable
 * without changing the logger's configuration for anyone else.
 */
function quietly<T>(fn: () => T): T {
  const { warn, error } = console
  console.warn = () => {}
  console.error = () => {}
  try {
    return fn()
  } finally {
    console.warn = warn
    console.error = error
  }
}

/** `can()` for a bare role, which is what every assertion below is really asking. */
function roleCan(role: Role, cap: Capability): boolean {
  return authz.can(ctxFor(role), cap)
}

describe('MEMBER — the operational role', () => {
  test('may launch and pause a campaign (DECISIONS D1, overruling 07 §9.4)', () => {
    // The controls that actually bound outbound volume and domain reputation are
    // separate ADMIN+ capabilities, so a MEMBER can only start sending within
    // limits they cannot change. Withholding launch produces shared ADMIN
    // credentials, which is strictly worse than the capability withheld.
    expect(roleCan('MEMBER', 'campaigns.launch')).toBe(true)
    // Pausing is a safety action and must never require permission.
    expect(roleCan('MEMBER', 'campaigns.pause')).toBe(true)
  })

  test('may not connect a mailbox', () => {
    // Connecting grants us an OAuth scope over a person's real mailbox, and the
    // grant lives until revoked. No other capability bounds that blast radius.
    expect(roleCan('MEMBER', 'mailboxes.connect')).toBe(false)
  })

  test('may not export or bulk-delete leads', () => {
    // The lead list is the customer's commercial asset and "departing employee
    // exports the list" is a real incident class. Unlike launching, nothing else
    // bounds the damage: one export is total.
    expect(roleCan('MEMBER', 'leads.export')).toBe(false)
    expect(roleCan('MEMBER', 'leads.bulk_delete')).toBe(false)
  })

  test('may do the day-to-day work the product exists for', () => {
    for (const cap of [
      'leads.view',
      'leads.create',
      'leads.edit',
      'leads.delete',
      'leads.import',
      'campaigns.view',
      'campaigns.create',
      'campaigns.edit',
      'sequences.edit',
      'inbox.view',
      'inbox.reply',
      'inbox.archive',
      'suppressions.manage',
      'crm.view',
      'crm.edit',
      'analytics.view',
      'ai.use',
      'members.view',
      'mailboxes.view',
    ] as const) {
      expect(roleCan('MEMBER', cap)).toBe(true)
    }
  })

  test('holds no administrative capability', () => {
    for (const cap of [
      'members.invite',
      'members.remove',
      'members.change_role',
      'workspace.edit',
      'workspace.delete',
      'workspace.transfer_ownership',
      'billing.view',
      'billing.manage',
      'audit.view',
      'apikeys.manage',
      'jobs.view',
      'jobs.replay',
    ] as const) {
      expect(roleCan('MEMBER', cap)).toBe(false)
    }
  })
})

describe('ADMIN — everything operational, and the four things it must not touch', () => {
  test('cannot delete the workspace', () => {
    // Violated, there is no self-service recovery for the owner.
    expect(roleCan('ADMIN', 'workspace.delete')).toBe(false)
  })

  test('cannot transfer ownership', () => {
    expect(roleCan('ADMIN', 'workspace.transfer_ownership')).toBe(false)
  })

  test('cannot manage billing, though it may view it', () => {
    expect(roleCan('ADMIN', 'billing.manage')).toBe(false)
    expect(roleCan('ADMIN', 'billing.view')).toBe(true)
  })

  test('cannot manage API keys', () => {
    expect(roleCan('ADMIN', 'apikeys.manage')).toBe(false)
  })

  test('holds the staff capabilities MEMBER does not', () => {
    for (const cap of [
      'leads.export',
      'leads.bulk_delete',
      'campaigns.delete',
      'mailboxes.connect',
      'mailboxes.limits_edit',
      'domains.manage',
      'warmup.manage',
      'members.invite',
      'members.remove',
      'workspace.edit',
      'audit.view',
      'jobs.view',
      'jobs.replay',
    ] as const) {
      expect(roleCan('ADMIN', cap)).toBe(true)
    }
  })
})

describe('OWNER', () => {
  test('holds every capability in the matrix', () => {
    // Deny-by-default is a type guarantee (MATRIX is Record<Capability, ...>), so
    // this iterates the real key set rather than a hand-maintained list.
    for (const cap of Object.keys(authz.MATRIX) as Capability[]) {
      expect(roleCan('OWNER', cap)).toBe(true)
    }
  })
})

describe('requireCan', () => {
  test('is silent when allowed', () => {
    expect(() => authz.requireCan(ctxFor('MEMBER'), 'leads.view')).not.toThrow()
  })

  test('throws ForbiddenError naming the capability when denied', () => {
    // 403 rather than 404 is correct here: the caller already knows the resource
    // exists in their own workspace, so telling them why they cannot act is useful
    // rather than a leak. Cross-TENANT access is the case that must be a 404.
    expect(() => quietly(() => authz.requireCan(ctxFor('MEMBER'), 'workspace.delete'))).toThrow(
      /workspace\.delete/,
    )
  })

  test('the thrown error carries a 403 and the FORBIDDEN code', () => {
    try {
      quietly(() => authz.requireCan(ctxFor('ADMIN'), 'apikeys.manage'))
      throw new Error('requireCan should have thrown')
    } catch (error) {
      const e = error as { status?: number; code?: string; name?: string }
      expect(e.name).toBe('ForbiddenError')
      expect(e.status).toBe(403)
      expect(e.code).toBe('FORBIDDEN')
    }
  })
})

describe('assertRoleChangeAllowed — the guards the matrix cannot express', () => {
  test('an ADMIN cannot promote anyone to OWNER', () => {
    // Otherwise an ADMIN self-escalates by promoting a puppet account.
    expect(() =>
      quietly(() => authz.assertRoleChangeAllowed(ctxFor('ADMIN'), { role: 'MEMBER' }, 'OWNER')),
    ).toThrow(/members\.change_role/)
  })

  test('an ADMIN cannot demote an OWNER', () => {
    expect(() =>
      quietly(() => authz.assertRoleChangeAllowed(ctxFor('ADMIN'), { role: 'OWNER' }, 'MEMBER')),
    ).toThrow(/members\.change_role/)
  })

  test('an OWNER may promote to OWNER and may change another OWNER', () => {
    // The last-OWNER invariant is enforced separately, inside the mutating
    // transaction with FOR UPDATE — it is not this function's job.
    expect(() =>
      authz.assertRoleChangeAllowed(ctxFor('OWNER'), { role: 'MEMBER' }, 'OWNER'),
    ).not.toThrow()
    expect(() =>
      authz.assertRoleChangeAllowed(ctxFor('OWNER'), { role: 'OWNER' }, 'ADMIN'),
    ).not.toThrow()
  })

  test('an ADMIN may still move a member between the roles below its own', () => {
    expect(() =>
      authz.assertRoleChangeAllowed(ctxFor('ADMIN'), { role: 'MEMBER' }, 'ADMIN'),
    ).not.toThrow()
    expect(() =>
      authz.assertRoleChangeAllowed(ctxFor('ADMIN'), { role: 'ADMIN' }, 'MEMBER'),
    ).not.toThrow()
  })
})

describe('capabilitiesFor', () => {
  test('MEMBER is a strict subset of ADMIN, which is a strict subset of OWNER', () => {
    const member = new Set(authz.capabilitiesFor('MEMBER'))
    const admin = new Set(authz.capabilitiesFor('ADMIN'))
    const owner = new Set(authz.capabilitiesFor('OWNER'))

    for (const cap of member) expect(admin.has(cap)).toBe(true)
    for (const cap of admin) expect(owner.has(cap)).toBe(true)

    // Strict, not merely equal: each tier must actually grant something more.
    expect(admin.size).toBeGreaterThan(member.size)
    expect(owner.size).toBeGreaterThan(admin.size)
  })

  test('OWNER holds every key in MATRIX and no role holds a capability outside it', () => {
    const all = Object.keys(authz.MATRIX)
    expect(authz.capabilitiesFor('OWNER')).toHaveLength(all.length)

    for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const) {
      for (const cap of authz.capabilitiesFor(role)) expect(all).toContain(cap)
    }
  })

  test('agrees with can() for every role and capability', () => {
    // capabilitiesFor drives the UI and can() drives enforcement. If they ever
    // disagree, a button renders for an action the server refuses.
    for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const) {
      const held = new Set(authz.capabilitiesFor(role))
      for (const cap of Object.keys(authz.MATRIX) as Capability[]) {
        expect(held.has(cap)).toBe(roleCan(role, cap))
      }
    }
  })
})

describe('the matrix itself', () => {
  test('every capability names at least one role', () => {
    // A capability with an empty role list is unreachable by anyone, which is
    // almost certainly a mistake rather than a deliberate lockout.
    for (const [cap, roles] of Object.entries(authz.MATRIX)) {
      expect(roles.length, `${cap} grants no role`).toBeGreaterThan(0)
    }
  })

  test('every capability names OWNER', () => {
    // OWNER is a superset of ADMIN, which is a superset of MEMBER, with no
    // exceptions in either direction. This is what makes the subset test above a
    // property of the design rather than a coincidence of the current table.
    for (const [cap, roles] of Object.entries(authz.MATRIX)) {
      expect(roles, `${cap} excludes OWNER`).toContain('OWNER')
    }
  })

  test('any capability granted to MEMBER is also granted to ADMIN', () => {
    for (const [cap, roles] of Object.entries(authz.MATRIX)) {
      if (roles.includes('MEMBER')) {
        expect(roles, `${cap} grants MEMBER but not ADMIN`).toContain('ADMIN')
      }
    }
  })
})
