-- Phase 6 prerequisites: objects the sending engine's correctness depends on,
-- plus the tracking-default change from DECISIONS.md D2.
--
-- ⚠️  THREE `DROP INDEX` STATEMENTS WERE REMOVED FROM THE GENERATED OUTPUT:
--       DROP INDEX "EmailMessage_references_gin";
--       DROP INDEX "EmailThread_participants_gin";
--       DROP INDEX "WarmupPoolMember_emailAccount_unique";
--     Prisma diffs against schema.prisma alone and cannot see GIN or partial
--     indexes, so it proposes dropping them EVERY time. Never commit those.
--     `bun run db:verify` asserts they survived. See INTEGRATION-NOTES.md §11.

-- CreateEnum
CREATE TYPE "SendAttemptState" AS ENUM ('STARTED', 'ACCEPTED', 'FAILED', 'RECONCILED_SENT', 'RECONCILED_NOT_SENT');

-- AlterTable
ALTER TABLE "Campaign" ALTER COLUMN "trackOpens" SET DEFAULT false,
ALTER COLUMN "trackClicks" SET DEFAULT false;

-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN     "nextSendAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "enqueuedByRequestId" TEXT;

-- AlterTable
ALTER TABLE "MailboxDailyStat" ADD COLUMN     "reservedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Workspace" ALTER COLUMN "trackOpensDefault" SET DEFAULT false,
ALTER COLUMN "trackClicksDefault" SET DEFAULT false;

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "version" TEXT,
    "leasedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "stoppedAt" TIMESTAMPTZ(6),

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SendAttempt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scheduledEmailId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "workerId" TEXT,
    "sendToken" TEXT NOT NULL,
    "state" "SendAttemptState" NOT NULL DEFAULT 'STARTED',
    "providerMessageId" TEXT,
    "providerThreadId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryable" BOOLEAN,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),
    "durationMs" INTEGER,

    CONSTRAINT "SendAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkerHeartbeat_lastSeenAt_idx" ON "WorkerHeartbeat"("lastSeenAt");

-- CreateIndex
CREATE INDEX "SendAttempt_state_startedAt_idx" ON "SendAttempt"("state", "startedAt");

-- CreateIndex
CREATE INDEX "SendAttempt_workspaceId_startedAt_idx" ON "SendAttempt"("workspaceId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "SendAttempt_emailAccountId_startedAt_idx" ON "SendAttempt"("emailAccountId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "SendAttempt_sendToken_idx" ON "SendAttempt"("sendToken");

-- CreateIndex
CREATE UNIQUE INDEX "SendAttempt_scheduledEmailId_attempt_key" ON "SendAttempt"("scheduledEmailId", "attempt");

-- CreateIndex
CREATE INDEX "EmailAccount_status_nextSendAt_idx" ON "EmailAccount"("status", "nextSendAt");

-- AddForeignKey
ALTER TABLE "SendAttempt" ADD CONSTRAINT "SendAttempt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendAttempt" ADD CONSTRAINT "SendAttempt_scheduledEmailId_fkey" FOREIGN KEY ("scheduledEmailId") REFERENCES "ScheduledEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendAttempt" ADD CONSTRAINT "SendAttempt_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────────
-- Hand-written: the CHECK Prisma cannot express.
-- ────────────────────────────────────────────────────────────────────────────

-- Backfill BEFORE adding the constraint. `reservedCount` arrives defaulting to 0
-- while existing rows already carry a positive `sentCount`, so every historical row
-- violates the invariant on creation. Adding the CHECK first fails the migration —
-- which is exactly what happened the first time this ran.
--
-- Reserved is set to sentCount, not to 0: those sends already happened, so their
-- reservations are retroactively implied.
UPDATE "MailboxDailyStat"
   SET "reservedCount" = "sentCount"
 WHERE "reservedCount" < "sentCount";

-- The daily cap is enforced by reserving before the provider call, so a
-- reservation may exist for a send that has not completed — but a send can never
-- exist without its reservation. If this invariant breaks, the cap silently stops
-- being enforced, so it is a constraint rather than a convention.
ALTER TABLE "MailboxDailyStat"
  ADD CONSTRAINT "MailboxDailyStat_reserved_gte_sent"
  CHECK ("reservedCount" >= "sentCount");
