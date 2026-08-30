import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

/**
 * Prisma 7 moved connection URLs out of `schema.prisma`: the `datasource` block
 * no longer accepts `url` or `directUrl`. Migration and introspection commands
 * read the URL from here, while `PrismaClient` gets a driver adapter at runtime
 * (see src/lib/db.ts).
 *
 * DIRECT_DATABASE_URL is preferred for Migrate because migrations must not run
 * through a transaction-mode pooler; it falls back to DATABASE_URL locally,
 * where the two are the same.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'bun run prisma/seed.ts',
  },
  datasource: {
    url: process.env.DIRECT_DATABASE_URL || env('DATABASE_URL'),
    /**
     * A throwaway database Prisma replays migrations into, so it can compute a
     * diff and detect drift without touching the dev database. Prisma resets it
     * on every use, so it must never point at anything real.
     *
     * Spread conditionally: tsconfig sets exactOptionalPropertyTypes, so passing
     * an explicit `undefined` to an optional property is a type error. Omitting
     * the key is what "not configured" must look like.
     */
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
      : {}),
  },
})
