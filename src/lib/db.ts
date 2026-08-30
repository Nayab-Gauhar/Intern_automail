import 'server-only'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { env } from './env'

/**
 * The Prisma client singleton.
 *
 * Prisma 7 takes a driver adapter rather than reading a URL from schema.prisma,
 * so the connection is constructed here. Pool sizing differs by process: the web
 * app serves many short requests, while the worker runs a small number of
 * long-lived concurrent jobs.
 *
 * Only modules/<domain>/repo.ts may import this — enforced by eslint.config.mjs.
 */

const isWorker = process.env.INSTANT_MAIL_PROCESS === 'worker'

function createClient() {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    // Keep a little headroom over the worker's concurrency so a job never
    // waits on the pool while holding a lease.
    max: isWorker ? env.WORKER_CONCURRENCY + 2 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })

  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

// Next.js dev HMR re-evaluates modules on every edit; without caching on the
// global we would leak a connection pool per reload until Postgres refuses.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const db = globalForPrisma.prisma ?? createClient()

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = db
