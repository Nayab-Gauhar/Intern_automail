-- Add the RateLimit table (docs/architecture/07-auth-and-security.md §14).
--
-- NOTE FOR FUTURE MIGRATIONS: `prisma migrate diff` proposed dropping
-- EmailMessage_references_gin, EmailThread_participants_gin, and
-- WarmupPoolMember_emailAccount_unique as part of this change. Those DROPs were
-- removed by hand and must never be committed.
--
-- Prisma computes a diff from schema.prisma alone. Our GIN and partial indexes
-- cannot be expressed in Prisma schema language, so Prisma cannot see them and
-- treats them as foreign objects to be removed. Every future `migrate diff` will
-- propose the same deletions. Always read generated SQL before committing it, and
-- strip any DROP touching an object listed in the init migration's hand-written
-- block. See docs/architecture/INTEGRATION-NOTES.md.

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "RateLimit_expiresAt_idx" ON "RateLimit"("expiresAt");
