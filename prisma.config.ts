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
  },
})
