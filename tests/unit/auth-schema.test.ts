import { describe, expect, test } from 'bun:test'
import {
  changePasswordSchema,
  emailSchema,
  idSchema,
  loginSchema,
  passwordSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from '@/modules/auth/schema'
import { inviteMemberSchema, switchWorkspaceSchema } from '@/modules/workspace/schema'

/**
 * The zod schemas at the auth boundary.
 *
 * These are pure — no env, no database, no `server-only` — so they import
 * statically. What they pin: email normalisation (because a lookup that misses on
 * case is a login failure), the password policy boundaries, and `.strict()`
 * rejecting a smuggled `workspaceId`, which is brief §4 rule 2 as a mechanism
 * rather than a convention.
 */

/** A password that clears the policy and shares nothing with the test emails. */
const GOOD_PASSWORD = 'thunder-marble-92-quilt'

describe('emailSchema', () => {
  test('lowercases and trims, so User.email is written canonically', () => {
    // Without this, "Foo@Bar.com" and "foo@bar.com" become two rows on a globally
    // unique column, and one of them can never log in.
    expect(emailSchema.parse('  Foo@Bar.COM  ')).toBe('foo@bar.com')
  })

  test('normalises BEFORE validating the format', () => {
    // Ordering matters and is easy to get backwards: `z.email().trim()` validates
    // the RAW string and rejects a padded address outright (verified). The trim has
    // to come first and pipe into the format check.
    expect(emailSchema.safeParse(' user@example.com ').success).toBe(true)
    expect(emailSchema.parse('\tUSER@Example.Com\n')).toBe('user@example.com')
  })

  test('rejects malformed addresses', () => {
    for (const bad of ['', 'no-at-sign', 'user@', '@example.com', 'a b@example.com', 'user@x']) {
      expect(emailSchema.safeParse(bad).success, bad).toBe(false)
    }
  })

  test('rejects an address past the RFC 5321 length ceiling', () => {
    // An unbounded field is handed to argon2's context check and to a database index.
    const long = `${'a'.repeat(250)}@example.com`
    expect(emailSchema.safeParse(long).success).toBe(false)
  })
})

describe('passwordSchema — entropy, not composition', () => {
  test('accepts 12 characters and rejects 11', () => {
    // Length is the single highest-signal predictor of entropy we can cheaply check.
    expect(passwordSchema.safeParse('a'.repeat(12)).success).toBe(true)
    expect(passwordSchema.safeParse('a'.repeat(11)).success).toBe(false)
  })

  test('accepts 200 characters and rejects 201', () => {
    // The ceiling is checked before hashing so argon2 never sees a 10 MB string.
    // argon2's cost is length-independent, but the allocation is not.
    expect(passwordSchema.safeParse('a'.repeat(200)).success).toBe(true)
    expect(passwordSchema.safeParse('a'.repeat(201)).success).toBe(false)
  })

  test('rejects whitespace-only input that would otherwise pass the length check', () => {
    expect(passwordSchema.safeParse(' '.repeat(20)).success).toBe(false)
  })

  test('imposes no composition rules', () => {
    // No uppercase/digit/symbol requirement. Composition rules push users to
    // `Password1!`, which is twelve characters of nothing, and NIST SP 800-63B has
    // recommended against them for years.
    expect(passwordSchema.safeParse('correcthorsebatterystaple').success).toBe(true)
    expect(passwordSchema.safeParse('all lower case words here').success).toBe(true)
  })
})

describe('registerSchema', () => {
  test('accepts a well-formed registration and normalises the email', () => {
    const parsed = registerSchema.parse({
      email: '  Ada@Example.COM ',
      password: GOOD_PASSWORD,
      name: '  Ada Lovelace  ',
    })
    expect(parsed.email).toBe('ada@example.com')
    expect(parsed.name).toBe('Ada Lovelace')
  })

  test('rejects a password containing the email local part', () => {
    // Context-specific guesses are the first thing an attacker tries.
    const result = registerSchema.safeParse({
      email: 'salamander@example.com',
      password: 'my-salamander-pw-01',
      name: 'Ada',
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('email address')
  })

  test('the local-part check is case-insensitive', () => {
    expect(
      registerSchema.safeParse({
        email: 'salamander@example.com',
        password: 'MY-SALAMANDER-PW-01',
        name: 'Ada',
      }).success,
    ).toBe(false)
  })

  test('ignores a local part under three characters', () => {
    // "al@x.com" would otherwise reject every password containing "al", which is
    // noise rather than signal.
    expect(
      registerSchema.safeParse({
        email: 'al@example.com',
        password: 'always-alter-alpine-42',
        name: 'Al',
      }).success,
    ).toBe(true)
  })

  test('rejects a password containing the product name', () => {
    expect(
      registerSchema.safeParse({
        email: 'ada@example.com',
        password: 'instantmail-rocks-1',
        name: 'Ada',
      }).success,
    ).toBe(false)
  })

  test('rejects an empty or whitespace-only name', () => {
    for (const name of ['', '   ']) {
      expect(
        registerSchema.safeParse({ email: 'ada@example.com', password: GOOD_PASSWORD, name })
          .success,
        JSON.stringify(name),
      ).toBe(false)
    }
  })
})

describe('loginSchema', () => {
  test('does not apply the password policy to a login attempt', () => {
    // A login must not reveal that the stored password is at least twelve
    // characters, and a user whose password predates a policy change must still be
    // able to sign in. Only the bounds that protect us are applied.
    expect(loginSchema.safeParse({ email: 'ada@example.com', password: 'short' }).success).toBe(
      true,
    )
  })

  test('still rejects an empty password and one past the hashing ceiling', () => {
    expect(loginSchema.safeParse({ email: 'ada@example.com', password: '' }).success).toBe(false)
    expect(
      loginSchema.safeParse({ email: 'ada@example.com', password: 'a'.repeat(201) }).success,
    ).toBe(false)
  })

  test('normalises the email so the lookup cannot miss on case', () => {
    expect(loginSchema.parse({ email: ' ADA@Example.com ', password: 'pw' }).email).toBe(
      'ada@example.com',
    )
  })
})

describe('.strict() — a smuggled workspaceId is a validation failure', () => {
  /**
   * Brief §4 rule 2 as a MECHANISM. `z.object()` strips unknown keys by default,
   * which would make the smuggling attempt invisible; `z.strictObject` makes it a
   * loud rejection that shows up in the logs.
   */
  const payloads = [
    [
      'registerSchema',
      registerSchema,
      { email: 'ada@example.com', password: GOOD_PASSWORD, name: 'Ada' },
    ],
    ['loginSchema', loginSchema, { email: 'ada@example.com', password: 'pw' }],
    [
      'changePasswordSchema',
      changePasswordSchema,
      { currentPassword: 'old-pw', newPassword: GOOD_PASSWORD },
    ],
    ['updateProfileSchema', updateProfileSchema, { name: 'Ada' }],
    ['inviteMemberSchema', inviteMemberSchema, { email: 'ada@example.com', role: 'MEMBER' }],
  ] as const

  for (const [name, schema, valid] of payloads) {
    test(`${name} accepts the clean payload but rejects an injected workspaceId`, () => {
      expect(schema.safeParse(valid).success, `${name} should accept its own valid payload`).toBe(
        true,
      )

      const result = schema.safeParse({ ...valid, workspaceId: 'ws_attacker_controlled' })
      expect(result.success, `${name} accepted a smuggled workspaceId`).toBe(false)
      expect(JSON.stringify(result.error?.issues)).toContain('workspaceId')
    })

    test(`${name} reports the rejection as unrecognized_keys, not a field error`, () => {
      const result = schema.safeParse({ ...valid, workspaceId: 'ws_x' })
      expect(result.error?.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true)
    })

    test(`${name} rejects any unknown key, not just workspaceId`, () => {
      // The control is "unknown keys are rejected", not a blocklist of one name —
      // otherwise `workspace_id` or `wsId` would sail through a future handler.
      expect(schema.safeParse({ ...valid, role_override: 'OWNER' }).success).toBe(false)
    })
  }
})

describe('workspace schemas', () => {
  test('inviteMemberSchema cannot express an OWNER invite', () => {
    // The schema type excludes OWNER, so an ADMIN self-escalating by inviting a
    // puppet account as OWNER is unrepresentable rather than merely checked.
    expect(inviteMemberSchema.safeParse({ email: 'a@example.com', role: 'OWNER' }).success).toBe(
      false,
    )
    for (const role of ['ADMIN', 'MEMBER']) {
      expect(inviteMemberSchema.safeParse({ email: 'a@example.com', role }).success, role).toBe(
        true,
      )
    }
  })

  test('the switcher names a workspace by slug, so no schema declares a workspaceId field', () => {
    expect(switchWorkspaceSchema.safeParse({ slug: 'acme-inc' }).success).toBe(true)
    expect(
      switchWorkspaceSchema.safeParse({ workspaceId: 'clzq1a2b3c4d5e6f7g8h9i0j' }).success,
    ).toBe(false)
  })

  test('the slug is lowercased and rejects anything outside the URL-safe charset', () => {
    expect(switchWorkspaceSchema.parse({ slug: ' ACME-Inc ' }).slug).toBe('acme-inc')
    for (const bad of ['../etc/passwd', 'acme inc', 'acme_inc', 'acme/inc', '']) {
      expect(switchWorkspaceSchema.safeParse({ slug: bad }).success, bad).toBe(false)
    }
  })
})

describe('idSchema — cuids, never uuids (DECISIONS D5)', () => {
  test('accepts a cuid', () => {
    // `z.string().uuid()` rejects every id this schema mints, which would make
    // every affected route reject every valid id.
    expect(idSchema.safeParse('clzq1a2b3c4d5e6f7g8h9i0j').success).toBe(true)
  })

  test('rejects a uuid and other non-cuid shapes', () => {
    for (const bad of ['', 'not-an-id', '123', 'ADA', '../../etc/passwd']) {
      expect(idSchema.safeParse(bad).success, bad).toBe(false)
    }
  })
})

describe('resetPasswordSchema', () => {
  test('accepts a base64url token of the shape mintToken() produces', () => {
    expect(
      resetPasswordSchema.safeParse({
        token: 'a'.repeat(43),
        email: 'ada@example.com',
        password: GOOD_PASSWORD,
      }).success,
    ).toBe(true)
  })

  test('rejects a token carrying characters outside base64url', () => {
    // A token is compared as a hash, so a malformed one is only ever a lookup miss
    // — but rejecting the shape early keeps path and header tricks out of the query.
    for (const token of [
      'short',
      `${'a'.repeat(43)}/../x`,
      `${'a'.repeat(43)}%00`,
      'a'.repeat(43) + ' ',
    ]) {
      expect(
        resetPasswordSchema.safeParse({
          token,
          email: 'ada@example.com',
          password: GOOD_PASSWORD,
        }).success,
        token,
      ).toBe(false)
    }
  })

  test('applies the full password policy, unlike login', () => {
    expect(
      resetPasswordSchema.safeParse({
        token: 'a'.repeat(43),
        email: 'ada@example.com',
        password: 'short',
      }).success,
    ).toBe(false)
  })
})

describe('changePasswordSchema', () => {
  test('rejects a new password identical to the current one', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: GOOD_PASSWORD,
      newPassword: GOOD_PASSWORD,
    })
    expect(result.success).toBe(false)
  })

  test('accepts a genuinely different new password', () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'the-old-one-77',
        newPassword: GOOD_PASSWORD,
      }).success,
    ).toBe(true)
  })
})

describe('updateProfileSchema', () => {
  test('accepts a real IANA zone name and rejects nonsense', () => {
    expect(updateProfileSchema.safeParse({ timezone: 'Europe/Berlin' }).success).toBe(true)
    expect(updateProfileSchema.safeParse({ timezone: 'UTC' }).success).toBe(true)
    expect(updateProfileSchema.safeParse({ timezone: 'Asia/Kolkata' }).success).toBe(true)
    expect(updateProfileSchema.safeParse({ timezone: 'Mars/Olympus' }).success).toBe(false)
  })

  test('rejects a fixed UTC offset, which Intl alone would accept', () => {
    // This is the whole reason the check is two steps. `Intl.DateTimeFormat` accepts
    // '+02:00', '-0500', '+02', 'GMT' and 'EST5EDT' without throwing, so a refine
    // that only caught its throw would let a fixed offset into User.timezone. An
    // offset is wrong twice a year; daily caps and sending windows are derived from
    // a zone NAME precisely so they survive a DST transition.
    for (const bad of ['+02:00', '-0500', '+02', 'GMT', 'EST5EDT']) {
      expect(updateProfileSchema.safeParse({ timezone: bad }).success, bad).toBe(false)
    }
  })

  test('canonicalises a zone name, so one zone has one spelling in the database', () => {
    expect(updateProfileSchema.parse({ timezone: 'europe/berlin' }).timezone).toBe('Europe/Berlin')
    expect(updateProfileSchema.parse({ timezone: '  utc  ' }).timezone).toBe('UTC')
  })

  test('accepts a partial update', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(true)
    expect(updateProfileSchema.safeParse({ name: 'Ada' }).success).toBe(true)
  })
})
