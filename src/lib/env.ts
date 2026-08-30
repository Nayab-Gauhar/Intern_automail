import 'server-only'
import { z } from 'zod'

/**
 * Environment validation. Parsed once at module load so a missing or malformed
 * secret is a startup failure rather than a 3am runtime surprise.
 *
 * server-only: importing this from a client component is a build error, which is
 * the point — none of these values may reach the browser.
 */

/** A 32-byte key, base64-encoded. Anything shorter weakens AES-256-GCM. */
const base64Key32 = z
  .string()
  .min(1, 'required')
  .refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === 32
    } catch {
      return false
    }
  }, 'must be exactly 32 bytes, base64-encoded (openssl rand -base64 32)')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1),
  /** Non-pooled connection for Migrate; falls back to DATABASE_URL locally. */
  DIRECT_DATABASE_URL: z.string().optional(),
  TEST_DATABASE_URL: z.string().optional(),

  /**
   * Restricted to http/https. Bare `z.url()` is lenient about protocol and
   * accepts `javascript:alert(1)`, `mailto:`, `ftp://`, and `localhost:3000`
   * without a scheme — verified. APP_URL is used to build redirect and callback
   * URLs, so an unexpected scheme here is a real hazard rather than a typo.
   */
  APP_URL: z.url({ protocol: /^https?$/ }),

  AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ENCRYPTION_KEY: base64Key32,
  /** Decrypt-only key retained across a rotation. */
  ENCRYPTION_KEY_PREVIOUS: z.union([base64Key32, z.literal('')]).optional(),

  // Gmail is optional so the app boots and is developable before OAuth
  // credentials exist. Mailbox connection checks these at the point of use and
  // surfaces an honest "not configured" state rather than crashing.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.union([z.url({ protocol: /^https?$/ }), z.literal('')]).optional(),
  GMAIL_PUBSUB_VERIFICATION_TOKEN: z.string().optional(),
  GMAIL_PUBSUB_TOPIC: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-5'),

  WORKER_AUTH_TOKEN: z.string().min(16),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(64).default(4),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** 'fake' selects the in-process email provider used by tests. */
  EMAIL_PROVIDER_MODE: z.enum(['live', 'fake']).default('live'),
})

function load() {
  const parsed = schema.safeParse(process.env)

  if (!parsed.success) {
    // Report every problem at once; fixing env one error per restart is misery.
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(
      `Invalid environment configuration:\n${lines.join('\n')}\n\n` +
        'Copy .env.example to .env and fill the required values.',
    )
  }

  return parsed.data
}

export const env = load()

/** True when Gmail OAuth is fully configured; gates the connect flow in the UI. */
export const isGoogleConfigured =
  Boolean(env.GOOGLE_CLIENT_ID) &&
  Boolean(env.GOOGLE_CLIENT_SECRET) &&
  Boolean(env.GOOGLE_REDIRECT_URI)

/** True when an AI key is present; AI features degrade honestly without it. */
export const isAiConfigured = Boolean(env.ANTHROPIC_API_KEY)
