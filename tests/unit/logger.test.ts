import { describe, expect, test, beforeAll, afterEach } from 'bun:test'

/**
 * Logger tests.
 *
 * The redaction rules are a security control, not formatting: the brief forbids
 * logging secrets or full email bodies. A logger that quietly serialises a refresh
 * token puts it in every log sink, so these assert the guarantee rather than the
 * shape of the output.
 */

let logger: typeof import('../../src/lib/logger').logger
const captured: string[] = []

beforeAll(async () => {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = 'test'
  process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5433/db?schema=public'
  process.env.APP_URL = 'http://localhost:3000'
  process.env.AUTH_SECRET = 'a'.repeat(32)
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64')
  process.env.WORKER_AUTH_TOKEN = 'w'.repeat(16)
  process.env.LOG_LEVEL = 'debug'
  ;({ logger } = await import('../../src/lib/logger'))
})

/** The logger writes through console; capture both sinks it uses. */
function capture(fn: () => void): string[] {
  captured.length = 0
  const warn = console.warn
  const error = console.error
  console.warn = (m: unknown) => captured.push(String(m))
  console.error = (m: unknown) => captured.push(String(m))
  try {
    fn()
  } finally {
    console.warn = warn
    console.error = error
  }
  return [...captured]
}

afterEach(() => {
  captured.length = 0
})

describe('output shape', () => {
  test('emits one parseable JSON object per call', () => {
    const [line] = capture(() => logger.info('test.event', { workspaceId: 'ws_1' }))
    const parsed = JSON.parse(line!) as Record<string, unknown>
    expect(parsed.level).toBe('info')
    expect(parsed.event).toBe('test.event')
    expect(parsed.workspaceId).toBe('ws_1')
    expect(typeof parsed.at).toBe('string')
  })

  test('the timestamp is ISO-8601 UTC', () => {
    const [line] = capture(() => logger.info('t'))
    const at = (JSON.parse(line!) as { at: string }).at
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })
})

describe('redaction — the security guarantee', () => {
  test.each([
    ['password'],
    ['token'],
    ['accessToken'],
    ['refreshToken'],
    ['refresh_token'],
    ['access_token'],
    ['authorization'],
    ['cookie'],
    ['secret'],
    ['clientSecret'],
    ['apiKey'],
    ['encryptionKey'],
  ])('redacts %s', (key) => {
    const secret = 'SUPER-SECRET-VALUE-9f3a'
    const [line] = capture(() => logger.info('auth.attempt', { [key]: secret }))
    expect(line).not.toContain(secret)
    expect(line).toContain('[redacted]')
  })

  test.each([['body'], ['html'], ['textBody'], ['htmlBody']])(
    'redacts %s so email content never reaches a log sink',
    (key) => {
      const content = 'Hi Dana, following up on our conversation about Q3 pricing.'
      const [line] = capture(() => logger.info('email.sent', { [key]: content }))
      expect(line).not.toContain('Q3 pricing')
      expect(line).toContain('[redacted]')
    },
  )

  test('redacts a secret nested inside an object', () => {
    const [line] = capture(() =>
      logger.info('mailbox.sync', {
        mailbox: { email: 'a@b.test', refreshToken: 'NESTED-SECRET' },
      }),
    )
    expect(line).not.toContain('NESTED-SECRET')
    // Non-sensitive siblings must survive, or the log becomes useless.
    expect(line).toContain('a@b.test')
  })

  test('redacts a secret inside an array of objects', () => {
    const [line] = capture(() => logger.info('batch', { items: [{ token: 'ARRAY-SECRET' }] }))
    expect(line).not.toContain('ARRAY-SECRET')
  })

  test('keeps identifiers, which are what make a log useful', () => {
    const [line] = capture(() =>
      logger.info('job.leased', {
        jobId: 'job_1',
        workspaceId: 'ws_1',
        userId: 'usr_1',
        attempt: 2,
      }),
    )
    expect(line).toContain('job_1')
    expect(line).toContain('ws_1')
    expect(line).toContain('usr_1')
  })

  test('survives a self-referencing object without throwing', () => {
    // Depth-limited traversal: a cyclic payload must not crash the caller, since
    // logging is not supposed to be able to take a request down.
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    expect(() => capture(() => logger.info('cyclic', cyclic))).not.toThrow()
  })
})

describe('level filtering', () => {
  // These derive their expectation from the level env.ts actually parsed, rather
  // than asserting a fixed count. env.ts is a cached singleton parsed at first
  // import, so a test that pins a specific LOG_LEVEL passes or fails depending on
  // which test file imported it first — and an order-dependent test will lie
  // later. The contract worth pinning is monotonicity, not a particular level.
  const ORDER = { debug: 10, info: 20, warn: 30, error: 40 } as const

  test('emits a level at or above the configured threshold, and drops the rest', async () => {
    const { env } = await import('../../src/lib/env')
    const threshold = ORDER[env.LOG_LEVEL]

    for (const level of ['debug', 'info', 'warn'] as const) {
      const lines = capture(() => logger[level](`probe.${level}`))
      const expected = ORDER[level] >= threshold ? 1 : 0
      expect(lines).toHaveLength(expected)
    }
  })

  test('error is never suppressed at any configured level', () => {
    // error sits at the top of the ladder, so no valid LOG_LEVEL can filter it —
    // losing an error line is how an incident becomes invisible.
    const lines = capture(() => logger.error('probe.error', new Error('x')))
    expect(lines).toHaveLength(1)
  })
})

describe('error logging', () => {
  test('captures name, message and stack rather than stringifying the error away', () => {
    const [line] = capture(() => logger.error('job.failed', new Error('boom'), { jobId: 'j1' }))
    const parsed = JSON.parse(line!) as { error: { name: string; message: string; stack?: string } }
    expect(parsed.error.name).toBe('Error')
    expect(parsed.error.message).toBe('boom')
    expect(typeof parsed.error.stack).toBe('string')
  })

  test('handles a non-Error throwable', () => {
    const [line] = capture(() => logger.error('odd.failure', 'a bare string'))
    expect(line).toContain('a bare string')
  })

  test('handles no error argument at all', () => {
    expect(() => capture(() => logger.error('no.error.attached'))).not.toThrow()
  })
})

describe('child loggers', () => {
  test('carry base context into every call', () => {
    const child = logger.child({ jobId: 'job_42', workspaceId: 'ws_9' })
    const [line] = capture(() => child.info('job.started'))
    expect(line).toContain('job_42')
    expect(line).toContain('ws_9')
  })

  test('still redact secrets passed at the call site', () => {
    const child = logger.child({ workspaceId: 'ws_9' })
    const [line] = capture(() => child.info('oauth.refresh', { refreshToken: 'CHILD-SECRET' }))
    expect(line).not.toContain('CHILD-SECRET')
  })

  test('merge call-site context over base context', () => {
    const child = logger.child({ attempt: 1 })
    const [line] = capture(() => child.info('retry', { attempt: 2 }))
    expect(JSON.parse(line!).attempt).toBe(2)
  })
})
