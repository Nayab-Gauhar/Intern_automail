import { describe, expect, test } from 'bun:test'

/**
 * Env validation tests.
 *
 * src/lib/env.ts parses at module load and throws on a bad configuration, which is
 * the behaviour worth pinning: a missing secret must be a startup failure with a
 * readable list of problems, not a 3am runtime surprise. Because it parses once at
 * import, each case re-imports the module with a fresh registry rather than
 * mutating an already-parsed value.
 */

const VALID = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db?schema=public',
  APP_URL: 'http://localhost:3000',
  AUTH_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  WORKER_AUTH_TOKEN: 'w'.repeat(16),
} as const

/** Load env.ts against an exact process.env, isolated from this process's own. */
async function loadWith(overrides: Record<string, string | undefined>) {
  const saved = { ...process.env }
  for (const k of Object.keys(process.env)) {
    // Strip anything the schema reads so a value from the developer's real .env
    // cannot make a "missing variable" test pass.
    if (
      /^(NODE_ENV|DATABASE_URL|DIRECT_DATABASE_URL|TEST_DATABASE_URL|APP_URL|AUTH_SECRET|ENCRYPTION_KEY|ENCRYPTION_KEY_PREVIOUS|GOOGLE_|GMAIL_|MICROSOFT_|ANTHROPIC_|AI_MODEL|WORKER_|LOG_LEVEL|EMAIL_PROVIDER_MODE)/.test(
        k,
      )
    ) {
      delete (process.env as Record<string, string | undefined>)[k]
    }
  }
  Object.assign(process.env, overrides)

  try {
    // A cache-busting query keeps each case independent of module caching.
    return await import(`../../src/lib/env?case=${Math.floor(performance.now() * 1000)}`)
  } finally {
    for (const k of Object.keys(process.env))
      delete (process.env as Record<string, string | undefined>)[k]
    Object.assign(process.env, saved)
  }
}

describe('a valid configuration', () => {
  test('parses and exposes typed values', async () => {
    const { env } = await loadWith({ ...VALID })
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL)
    expect(env.NODE_ENV).toBe('test')
  })

  test('applies documented defaults for omitted optionals', async () => {
    const { env } = await loadWith({ ...VALID })
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.AI_MODEL).toBe('claude-sonnet-5')
    // Coerced from string to number, so arithmetic on it is safe.
    expect(env.WORKER_CONCURRENCY).toBe(4)
    // Defaults to live: a test run must opt IN to the fake provider explicitly.
    expect(env.EMAIL_PROVIDER_MODE).toBe('live')
  })
})

describe('missing required variables fail fast', () => {
  test.each([
    ['DATABASE_URL'],
    ['APP_URL'],
    ['AUTH_SECRET'],
    ['ENCRYPTION_KEY'],
    ['WORKER_AUTH_TOKEN'],
  ])('throws when %s is absent', async (key) => {
    const cfg: Record<string, string | undefined> = { ...VALID }
    delete cfg[key]
    await expect(loadWith(cfg)).rejects.toThrow(/Invalid environment configuration/)
  })

  test('reports every problem at once, not one per restart', async () => {
    const cfg: Record<string, string | undefined> = { ...VALID }
    delete cfg.DATABASE_URL
    delete cfg.AUTH_SECRET

    // Fixing env one error per restart is miserable, so the message must name both.
    await expect(loadWith(cfg)).rejects.toThrow(
      /DATABASE_URL[\s\S]*AUTH_SECRET|AUTH_SECRET[\s\S]*DATABASE_URL/,
    )
  })
})

describe('ENCRYPTION_KEY must be exactly 32 bytes', () => {
  test.each([
    ['too short (16 bytes)', Buffer.alloc(16, 1).toString('base64')],
    ['too long (64 bytes)', Buffer.alloc(64, 1).toString('base64')],
    ['not base64', 'this-is-not-valid-base64-!!!'],
    ['empty', ''],
  ])('rejects a key that is %s', async (_label, key) => {
    // A short key silently weakens AES-256-GCM, so this is a hard failure rather
    // than a warning.
    await expect(loadWith({ ...VALID, ENCRYPTION_KEY: key })).rejects.toThrow(
      /Invalid environment configuration/,
    )
  })

  test('accepts exactly 32 bytes', async () => {
    const { env } = await loadWith({
      ...VALID,
      ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    })
    expect(Buffer.from(env.ENCRYPTION_KEY, 'base64')).toHaveLength(32)
  })
})

describe('AUTH_SECRET length floor', () => {
  test('rejects a secret shorter than 32 characters', async () => {
    await expect(loadWith({ ...VALID, AUTH_SECRET: 'short' })).rejects.toThrow(
      /Invalid environment configuration/,
    )
  })
})

describe('APP_URL must be an http(s) URL', () => {
  // Bare z.url() is lenient about protocol: it accepts javascript:, mailto:, ftp:
  // and a scheme-less host:port. APP_URL builds redirect and callback URLs, so the
  // schema pins the protocol.
  test.each([
    ['not-a-url'],
    ['localhost:3000'],
    ['/relative/path'],
    ['javascript:alert(1)'],
    ['mailto:someone@example.com'],
    ['ftp://files.example.com'],
    ['http://'],
    [''],
  ])('rejects %s', async (value) => {
    await expect(loadWith({ ...VALID, APP_URL: value })).rejects.toThrow(
      /Invalid environment configuration/,
    )
  })

  test.each([['http://localhost:3000'], ['https://app.example.com']])(
    'accepts %s',
    async (value) => {
      const { env } = await loadWith({ ...VALID, APP_URL: value })
      expect(env.APP_URL).toBe(value)
    },
  )
})

describe('optional integrations degrade rather than crash', () => {
  test('Gmail absent means isGoogleConfigured is false, not a boot failure', async () => {
    const mod = await loadWith({ ...VALID })
    // The app must be developable before OAuth credentials exist; the UI reads
    // this flag to render an honest "not configured" state.
    expect(mod.isGoogleConfigured).toBe(false)
  })

  test('a partially configured Gmail is treated as not configured', async () => {
    // Half-configured OAuth would fail at the redirect with a confusing provider
    // error, so all three parts are required together.
    const mod = await loadWith({ ...VALID, GOOGLE_CLIENT_ID: 'id-only' })
    expect(mod.isGoogleConfigured).toBe(false)
  })

  test('fully configured Gmail flips the flag', async () => {
    const mod = await loadWith({
      ...VALID,
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/oauth/google/callback',
    })
    expect(mod.isGoogleConfigured).toBe(true)
  })

  test('AI key absent means isAiConfigured is false', async () => {
    const mod = await loadWith({ ...VALID })
    expect(mod.isAiConfigured).toBe(false)
  })

  test('AI key present flips the flag', async () => {
    const mod = await loadWith({ ...VALID, ANTHROPIC_API_KEY: 'sk-test-not-a-real-key' })
    expect(mod.isAiConfigured).toBe(true)
  })
})

describe('enums reject unknown values', () => {
  test('LOG_LEVEL', async () => {
    await expect(loadWith({ ...VALID, LOG_LEVEL: 'verbose' })).rejects.toThrow(
      /Invalid environment configuration/,
    )
  })

  test('EMAIL_PROVIDER_MODE', async () => {
    // A typo here would silently send real email in a test run.
    await expect(loadWith({ ...VALID, EMAIL_PROVIDER_MODE: 'mock' })).rejects.toThrow(
      /Invalid environment configuration/,
    )
  })
})
