import { env } from './env'

/**
 * Structured logging. One JSON object per line so production logs are greppable
 * and machine-parseable.
 *
 * Two hard rules, enforced by review and by the redaction below:
 *   1. Never log a secret — tokens, passwords, encryption keys.
 *   2. Never log a full email body. Subjects and ids are fine; content is not.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Correlation context threaded through a request or job. */
export type LogContext = {
  requestId?: string
  jobId?: string
  workspaceId?: string
  userId?: string
  [key: string]: unknown
}

const REDACT_KEYS = new Set([
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'refresh_token',
  'access_token',
  'authorization',
  'cookie',
  'secret',
  'clientSecret',
  'apiKey',
  'encryptionKey',
  'body',
  'html',
  'textBody',
  'htmlBody',
])

function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value == null) return value

  if (typeof value === 'object') {
    // A cyclic payload must not crash the caller: logging is never allowed to take
    // a request down, and JSON.stringify throws on a cycle. Depth-limiting alone
    // does not help, since the value returned at the limit is still the cycle.
    if (seen.has(value)) return '[circular]'
    if (depth > 4) return '[truncated]'
    seen.add(value)

    if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1, seen))

    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k) ? '[redacted]' : redact(v, depth + 1, seen)
    }
    return out
  }

  return value
}

function emit(level: Level, event: string, context: LogContext = {}) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[env.LOG_LEVEL]) return

  const line = {
    level,
    event,
    // Timestamp comes from the log call, not the caller, so ordering is reliable.
    at: new Date().toISOString(),
    ...(redact(context) as LogContext),
  }

  const serialised = JSON.stringify(line)
  if (level === 'error' || level === 'warn') console.error(serialised)
  else console.warn(serialised)
}

export const logger = {
  debug: (event: string, ctx?: LogContext) => emit('debug', event, ctx),
  info: (event: string, ctx?: LogContext) => emit('info', event, ctx),
  warn: (event: string, ctx?: LogContext) => emit('warn', event, ctx),

  /** Errors take the throwable separately so the stack is captured, not stringified away. */
  error: (event: string, error?: unknown, ctx?: LogContext) =>
    emit('error', event, {
      ...ctx,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error != null
            ? String(error)
            : undefined,
    }),

  /** A child logger that carries correlation fields into every subsequent call. */
  child(base: LogContext) {
    return {
      debug: (e: string, c?: LogContext) => emit('debug', e, { ...base, ...c }),
      info: (e: string, c?: LogContext) => emit('info', e, { ...base, ...c }),
      warn: (e: string, c?: LogContext) => emit('warn', e, { ...base, ...c }),
      error: (e: string, err?: unknown, c?: LogContext) => logger.error(e, err, { ...base, ...c }),
    }
  },
}
