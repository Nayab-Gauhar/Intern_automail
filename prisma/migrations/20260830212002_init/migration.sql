-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "EmailProvider" AS ENUM ('GMAIL', 'OUTLOOK', 'SMTP');

-- CreateEnum
CREATE TYPE "EmailAccountStatus" AS ENUM ('CONNECTING', 'ACTIVE', 'PAUSED', 'DISCONNECTED', 'THROTTLED', 'ERROR');

-- CreateEnum
CREATE TYPE "WarmupStatus" AS ENUM ('DISABLED', 'RAMPING', 'COMPLETE', 'PAUSED');

-- CreateEnum
CREATE TYPE "DnsRecordStatus" AS ENUM ('UNKNOWN', 'PASS', 'WARN', 'FAIL', 'LOOKUP_ERROR');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('IDLE', 'BACKFILLING', 'INCREMENTAL', 'CURSOR_EXPIRED', 'ERROR');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'ENGAGED', 'REPLIED', 'UNSUBSCRIBED', 'BOUNCED', 'DISQUALIFIED', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'VALID', 'RISKY', 'INVALID', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'DATE', 'URL', 'SELECT');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EnrollmentState" AS ENUM ('PENDING', 'ACTIVE', 'WAITING', 'PAUSED', 'COMPLETED', 'STOPPED', 'REPLIED', 'BOUNCED', 'UNSUBSCRIBED', 'FAILED');

-- CreateEnum
CREATE TYPE "EnrollmentStopReason" AS ENUM ('HUMAN_REPLY', 'HARD_BOUNCE', 'SOFT_BOUNCE_LIMIT', 'UNSUBSCRIBED', 'SUPPRESSED', 'SPAM_COMPLAINT', 'MANUAL', 'CAMPAIGN_DELETED', 'CONDITION_EXIT', 'LEAD_DISQUALIFIED', 'NO_ELIGIBLE_MAILBOX', 'INVALID_EMAIL', 'DUPLICATE_ENROLLMENT');

-- CreateEnum
CREATE TYPE "SequenceStepType" AS ENUM ('EMAIL', 'WAIT', 'CONDITION');

-- CreateEnum
CREATE TYPE "ConditionKind" AS ENUM ('HAS_OPENED_ANY', 'HAS_CLICKED_ANY', 'HAS_REPLIED', 'LEAD_FIELD_EQUALS', 'LEAD_HAS_TAG', 'LEAD_IN_LIST');

-- CreateEnum
CREATE TYPE "ConditionOutcome" AS ENUM ('CONTINUE', 'SKIP_NEXT', 'STOP');

-- CreateEnum
CREATE TYPE "ScheduledEmailState" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "ScheduledEmailKind" AS ENUM ('CAMPAIGN_STEP', 'WARMUP', 'MANUAL');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "MessageClassification" AS ENUM ('UNCLASSIFIED', 'HUMAN_REPLY', 'AUTO_REPLY', 'OUT_OF_OFFICE', 'BOUNCE', 'AUTOMATED_NOTIFICATION', 'UNSUBSCRIBE_REQUEST', 'SPAM_COMPLAINT');

-- CreateEnum
CREATE TYPE "BounceType" AS ENUM ('NONE', 'HARD', 'SOFT', 'BLOCKED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "EmailEventType" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'OPENED', 'CLICKED', 'REPLIED', 'UNSUBSCRIBED', 'FAILED', 'COMPLAINED');

-- CreateEnum
CREATE TYPE "SuppressionScope" AS ENUM ('EMAIL', 'DOMAIN');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBED', 'HARD_BOUNCE', 'SPAM_COMPLAINT', 'MANUAL', 'IMPORTED', 'POLICY');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "OpportunityStage" AS ENUM ('NEW', 'QUALIFYING', 'MEETING_BOOKED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('LEAD_CREATED', 'LEAD_IMPORTED', 'LEAD_UPDATED', 'ENROLLED', 'EMAIL_SENT', 'EMAIL_OPENED', 'EMAIL_CLICKED', 'EMAIL_REPLIED', 'EMAIL_BOUNCED', 'UNSUBSCRIBED', 'SEQUENCE_STOPPED', 'NOTE_ADDED', 'TASK_CREATED', 'TASK_COMPLETED', 'OPPORTUNITY_CREATED', 'OPPORTUNITY_STAGE_CHANGED', 'OPPORTUNITY_WON', 'OPPORTUNITY_LOST', 'AI_CLASSIFIED', 'MANUAL_EMAIL_SENT');

-- CreateEnum
CREATE TYPE "AIAnalysisTarget" AS ENUM ('EMAIL_MESSAGE', 'EMAIL_THREAD', 'LEAD', 'CAMPAIGN', 'CAMPAIGN_LEAD');

-- CreateEnum
CREATE TYPE "AIAnalysisKind" AS ENUM ('REPLY_CLASSIFICATION', 'THREAD_SUMMARY', 'DRAFT_REPLY', 'LEAD_SCORE', 'PERSONALISATION', 'CAMPAIGN_INSIGHT');

-- CreateEnum
CREATE TYPE "SentimentLabel" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('PENDING', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'DEAD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('SCHEDULER_TICK', 'SEND_SCHEDULED_EMAIL', 'MAILBOX_SYNC', 'MAILBOX_BACKFILL', 'MAILBOX_RENEW_WATCH', 'PROCESS_INBOUND_MESSAGE', 'PROCESS_WEBHOOK_EVENT', 'AI_CLASSIFY_MESSAGE', 'AI_SUMMARISE_THREAD', 'AI_SCORE_LEAD', 'ROLLUP_ANALYTICS', 'DOMAIN_HEALTH_CHECK', 'WARMUP_TICK', 'LEAD_IMPORT_BATCH', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "WebhookState" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'UNMATCHED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT,
    "avatarUrl" TEXT,
    "emailVerifiedAt" TIMESTAMPTZ(6),
    "lastLoginAt" TIMESTAMPTZ(6),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeWorkspaceId" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "absoluteExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "dailySendLimit" INTEGER,
    "trackOpensDefault" BOOLEAN NOT NULL DEFAULT true,
    "trackClicksDefault" BOOLEAN NOT NULL DEFAULT true,
    "unsubscribeFooterHtml" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceInvite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkspaceInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "workspaceId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "EmailProvider" NOT NULL,
    "email" TEXT NOT NULL,
    "fromName" TEXT,
    "replyToEmail" TEXT,
    "providerAccountId" TEXT,
    "encryptedRefreshToken" TEXT,
    "encryptedAccessToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(6),
    "encryptionKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "grantedScopes" TEXT,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpUsername" TEXT,
    "encryptedSmtpPassword" TEXT,
    "imapHost" TEXT,
    "imapPort" INTEGER,
    "status" "EmailAccountStatus" NOT NULL DEFAULT 'CONNECTING',
    "statusMessage" TEXT,
    "throttledUntil" TIMESTAMPTZ(6),
    "dailySendLimit" INTEGER NOT NULL DEFAULT 50,
    "minSecondsBetweenSends" INTEGER NOT NULL DEFAULT 90,
    "sendJitterSeconds" INTEGER NOT NULL DEFAULT 120,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "sendWindowStartMinute" INTEGER NOT NULL DEFAULT 480,
    "sendWindowEndMinute" INTEGER NOT NULL DEFAULT 1020,
    "sendWindowDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "warmupStatus" "WarmupStatus" NOT NULL DEFAULT 'DISABLED',
    "warmupDailyTarget" INTEGER NOT NULL DEFAULT 0,
    "warmupStartedAt" TIMESTAMPTZ(6),
    "healthScore" INTEGER NOT NULL DEFAULT 100,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "bouncedCount" INTEGER NOT NULL DEFAULT 0,
    "repliedCount" INTEGER NOT NULL DEFAULT 0,
    "complainedCount" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMPTZ(6),
    "lastSyncedAt" TIMESTAMPTZ(6),
    "lastErrorAt" TIMESTAMPTZ(6),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "domainId" TEXT,
    "connectedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "EmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spfStatus" "DnsRecordStatus" NOT NULL DEFAULT 'UNKNOWN',
    "dkimStatus" "DnsRecordStatus" NOT NULL DEFAULT 'UNKNOWN',
    "dmarcStatus" "DnsRecordStatus" NOT NULL DEFAULT 'UNKNOWN',
    "mxStatus" "DnsRecordStatus" NOT NULL DEFAULT 'UNKNOWN',
    "spfRecord" TEXT,
    "dkimRecord" TEXT,
    "dmarcRecord" TEXT,
    "dkimSelector" TEXT,
    "dmarcPolicy" TEXT,
    "issues" JSONB,
    "healthScore" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMPTZ(6),
    "lastCheckError" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'IDLE',
    "historyId" TEXT,
    "deltaToken" TEXT,
    "watchExpiresAt" TIMESTAMPTZ(6),
    "backfillPageToken" TEXT,
    "backfillCompletedAt" TIMESTAMPTZ(6),
    "backfillAfter" TIMESTAMPTZ(6),
    "lastSyncStartedAt" TIMESTAMPTZ(6),
    "lastSyncCompletedAt" TIMESTAMPTZ(6),
    "messagesSynced" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxDailyStat" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "localDate" DATE NOT NULL,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "warmupCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "bouncedCount" INTEGER NOT NULL DEFAULT 0,
    "repliedCount" INTEGER NOT NULL DEFAULT 0,
    "openedCount" INTEGER NOT NULL DEFAULT 0,
    "clickedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MailboxDailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupPool" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "startDailyVolume" INTEGER NOT NULL DEFAULT 2,
    "maxDailyVolume" INTEGER NOT NULL DEFAULT 20,
    "rampIncrement" INTEGER NOT NULL DEFAULT 2,
    "replyRate" DECIMAL(4,3) NOT NULL DEFAULT 0.300,
    "spamRescueRate" DECIMAL(4,3) NOT NULL DEFAULT 1.000,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WarmupPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupPoolMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "warmupPoolId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "rampDay" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarmupPoolMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailRaw" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "fullName" TEXT,
    "companyName" TEXT,
    "jobTitle" TEXT,
    "phone" TEXT,
    "linkedinUrl" TEXT,
    "websiteUrl" TEXT,
    "emailDomain" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "timezone" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMPTZ(6),
    "score" INTEGER,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT,
    "ownerUserId" TEXT,
    "leadImportId" TEXT,
    "lastContactedAt" TIMESTAMPTZ(6),
    "lastRepliedAt" TIMESTAMPTZ(6),
    "lastOpenedAt" TIMESTAMPTZ(6),
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadList" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "leadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "LeadList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadListMembership" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leadListId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadListMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadTag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colorToken" TEXT NOT NULL DEFAULT 'info',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeadTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadTagLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leadTagId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadTagLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldDefinition" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL DEFAULT 'TEXT',
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "defaultValue" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadImport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "columnMap" JSONB NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errorSample" JSONB,
    "state" "JobState" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeadImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scope" "SuppressionScope" NOT NULL DEFAULT 'EMAIL',
    "value" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL DEFAULT 'UNSUBSCRIBED',
    "note" TEXT,
    "sourceCampaignId" TEXT,
    "sourceLeadId" TEXT,
    "sourceMessageId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "sendWindowStartMinute" INTEGER NOT NULL DEFAULT 480,
    "sendWindowEndMinute" INTEGER NOT NULL DEFAULT 1020,
    "sendWindowDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "dailySendLimit" INTEGER,
    "startAt" TIMESTAMPTZ(6),
    "endAt" TIMESTAMPTZ(6),
    "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
    "stopOnReplyAnyCampaign" BOOLEAN NOT NULL DEFAULT false,
    "stopOnClick" BOOLEAN NOT NULL DEFAULT false,
    "stopOnOpen" BOOLEAN NOT NULL DEFAULT false,
    "trackOpens" BOOLEAN NOT NULL DEFAULT true,
    "trackClicks" BOOLEAN NOT NULL DEFAULT true,
    "skipIfInOtherCampaign" BOOLEAN NOT NULL DEFAULT true,
    "threadFollowUps" BOOLEAN NOT NULL DEFAULT true,
    "launchedAt" TIMESTAMPTZ(6),
    "pausedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "leadCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "openedCount" INTEGER NOT NULL DEFAULT 0,
    "clickedCount" INTEGER NOT NULL DEFAULT 0,
    "repliedCount" INTEGER NOT NULL DEFAULT 0,
    "bouncedCount" INTEGER NOT NULL DEFAULT 0,
    "unsubscribedCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueOpenedCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueClickedCount" INTEGER NOT NULL DEFAULT 0,
    "statsUpdatedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignMailbox" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignMailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignLeadListSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "leadListId" TEXT NOT NULL,
    "addedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignLeadListSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Sequence',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceStep" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "type" "SequenceStepType" NOT NULL DEFAULT 'EMAIL',
    "position" INTEGER NOT NULL,
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "conditionKind" "ConditionKind",
    "conditionField" TEXT,
    "conditionValue" TEXT,
    "conditionOutcome" "ConditionOutcome",
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "openedCount" INTEGER NOT NULL DEFAULT 0,
    "clickedCount" INTEGER NOT NULL DEFAULT 0,
    "repliedCount" INTEGER NOT NULL DEFAULT 0,
    "bouncedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SequenceStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceStepVariant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sequenceStepId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'A',
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "openedCount" INTEGER NOT NULL DEFAULT 0,
    "clickedCount" INTEGER NOT NULL DEFAULT 0,
    "repliedCount" INTEGER NOT NULL DEFAULT 0,
    "bouncedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SequenceStepVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignLead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "state" "EnrollmentState" NOT NULL DEFAULT 'PENDING',
    "currentStepId" TEXT,
    "lastCompletedPosition" INTEGER NOT NULL DEFAULT 0,
    "nextStepAt" TIMESTAMPTZ(6),
    "assignedEmailAccountId" TEXT,
    "primaryThreadId" TEXT,
    "stopReason" "EnrollmentStopReason",
    "stoppedAt" TIMESTAMPTZ(6),
    "enrolledAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMPTZ(6),
    "lastRepliedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CampaignLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledEmail" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "ScheduledEmailKind" NOT NULL DEFAULT 'CAMPAIGN_STEP',
    "campaignId" TEXT,
    "campaignLeadId" TEXT,
    "sequenceStepId" TEXT,
    "variantId" TEXT,
    "sequenceVersion" INTEGER NOT NULL DEFAULT 1,
    "leadId" TEXT,
    "emailAccountId" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "threadId" TEXT,
    "inReplyToMessageId" TEXT,
    "referencesHeader" TEXT,
    "state" "ScheduledEmailState" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMPTZ(6) NOT NULL,
    "claimedAt" TIMESTAMPTZ(6),
    "claimedBy" TEXT,
    "sentAt" TIMESTAMPTZ(6),
    "providerMessageId" TEXT,
    "rfcMessageId" TEXT,
    "providerThreadId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "permanentFailure" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelledReason" "EnrollmentStopReason",
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ScheduledEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "scheduledEmailId" TEXT NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "firstClickAt" TIMESTAMPTZ(6),
    "lastClickAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailThread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "providerThreadId" TEXT,
    "rootMessageId" TEXT,
    "subject" TEXT,
    "normalizedSubject" TEXT,
    "lastMessageAt" TIMESTAMPTZ(6) NOT NULL,
    "lastMessagePreview" TEXT,
    "lastMessageDirection" "MessageDirection" NOT NULL DEFAULT 'OUTBOUND',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "participants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isRead" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isStarred" BOOLEAN NOT NULL DEFAULT false,
    "isSpam" BOOLEAN NOT NULL DEFAULT false,
    "leadId" TEXT,
    "campaignId" TEXT,
    "campaignLeadId" TEXT,
    "hasHumanReply" BOOLEAN NOT NULL DEFAULT false,
    "firstReplyAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmailThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "rfcMessageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "toEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ccEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bccEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "replyTo" TEXT,
    "subject" TEXT,
    "snippet" TEXT,
    "bodyHtml" TEXT,
    "bodyText" TEXT,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "attachments" JSONB,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "headers" JSONB,
    "classification" "MessageClassification" NOT NULL DEFAULT 'UNCLASSIFIED',
    "classifiedByAi" BOOLEAN NOT NULL DEFAULT false,
    "classifiedAt" TIMESTAMPTZ(6),
    "bounceType" "BounceType" NOT NULL DEFAULT 'NONE',
    "bounceCode" TEXT,
    "bouncedRecipient" TEXT,
    "scheduledEmailId" TEXT,
    "campaignLeadId" TEXT,
    "sentAt" TIMESTAMPTZ(6) NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailEvent" (
    "id" BIGSERIAL NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "EmailEventType" NOT NULL,
    "campaignId" TEXT,
    "campaignLeadId" TEXT,
    "sequenceStepId" TEXT,
    "variantId" TEXT,
    "leadId" TEXT,
    "emailAccountId" TEXT,
    "scheduledEmailId" TEXT,
    "threadId" TEXT,
    "emailMessageId" TEXT,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "isFirstForSend" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "dueAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "assigneeUserId" TEXT,
    "createdByUserId" TEXT,
    "leadId" TEXT,
    "threadId" TEXT,
    "emailMessageId" TEXT,
    "opportunityId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorUserId" TEXT,
    "leadId" TEXT,
    "threadId" TEXT,
    "opportunityId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stage" "OpportunityStage" NOT NULL DEFAULT 'NEW',
    "value" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "probability" INTEGER NOT NULL DEFAULT 0,
    "expectedCloseAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "lostReason" TEXT,
    "ownerUserId" TEXT,
    "leadId" TEXT NOT NULL,
    "campaignId" TEXT,
    "campaignLeadId" TEXT,
    "threadId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" BIGSERIAL NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "actorUserId" TEXT,
    "leadId" TEXT,
    "campaignLeadId" TEXT,
    "opportunityId" TEXT,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "sequenceStepId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryMetric" TEXT NOT NULL DEFAULT 'reply',
    "minSamplePerArm" INTEGER NOT NULL DEFAULT 100,
    "startedAt" TIMESTAMPTZ(6),
    "endedAt" TIMESTAMPTZ(6),
    "winnerVariantLabel" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentArm" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "openedCount" INTEGER NOT NULL DEFAULT 0,
    "clickedCount" INTEGER NOT NULL DEFAULT 0,
    "repliedCount" INTEGER NOT NULL DEFAULT 0,
    "bouncedCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueOpenedCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueClickedCount" INTEGER NOT NULL DEFAULT 0,
    "pValue" DECIMAL(6,5),
    "computedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ExperimentArm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIAnalysis" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetType" "AIAnalysisTarget" NOT NULL,
    "targetId" TEXT NOT NULL,
    "kind" "AIAnalysisKind" NOT NULL,
    "emailMessageId" TEXT,
    "threadId" TEXT,
    "leadId" TEXT,
    "campaignId" TEXT,
    "campaignLeadId" TEXT,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "classification" "MessageClassification",
    "sentiment" "SentimentLabel",
    "confidence" DECIMAL(4,3),
    "summary" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,
    "acceptedByHuman" BOOLEAN NOT NULL DEFAULT false,
    "acceptedAt" TIMESTAMPTZ(6),
    "humanCorrection" "MessageClassification",
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AIAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "emailAccountId" TEXT,
    "provider" "EmailProvider" NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" "WebhookState" NOT NULL DEFAULT 'RECEIVED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" BIGSERIAL NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "state" "JobState" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "runAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMPTZ(6),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "dedupeKey" TEXT NOT NULL,
    "lastError" TEXT,
    "lastErrorStack" TEXT,
    "failedAt" TIMESTAMPTZ(6),
    "replayCount" INTEGER NOT NULL DEFAULT 0,
    "scheduledEmailId" TEXT,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Session_activeWorkspaceId_idx" ON "Session"("activeWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "Workspace_deletedAt_idx" ON "Workspace"("deletedAt");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE INDEX "WorkspaceMember_workspaceId_role_idx" ON "WorkspaceMember"("workspaceId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvite_tokenHash_key" ON "WorkspaceInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkspaceInvite_workspaceId_email_idx" ON "WorkspaceInvite"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "WorkspaceInvite_status_expiresAt_idx" ON "WorkspaceInvite"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "EmailAccount_workspaceId_status_idx" ON "EmailAccount"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "EmailAccount_workspaceId_deletedAt_idx" ON "EmailAccount"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "EmailAccount_domainId_idx" ON "EmailAccount"("domainId");

-- CreateIndex
CREATE INDEX "EmailAccount_status_throttledUntil_idx" ON "EmailAccount"("status", "throttledUntil");

-- CreateIndex
CREATE INDEX "EmailAccount_providerAccountId_idx" ON "EmailAccount"("providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAccount_workspaceId_email_key" ON "EmailAccount"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "Domain_workspaceId_idx" ON "Domain"("workspaceId");

-- CreateIndex
CREATE INDEX "Domain_lastCheckedAt_idx" ON "Domain"("lastCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_workspaceId_name_key" ON "Domain"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_emailAccountId_key" ON "SyncState"("emailAccountId");

-- CreateIndex
CREATE INDEX "SyncState_workspaceId_idx" ON "SyncState"("workspaceId");

-- CreateIndex
CREATE INDEX "SyncState_status_watchExpiresAt_idx" ON "SyncState"("status", "watchExpiresAt");

-- CreateIndex
CREATE INDEX "MailboxDailyStat_workspaceId_localDate_idx" ON "MailboxDailyStat"("workspaceId", "localDate");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxDailyStat_emailAccountId_localDate_key" ON "MailboxDailyStat"("emailAccountId", "localDate");

-- CreateIndex
CREATE INDEX "WarmupPool_workspaceId_enabled_idx" ON "WarmupPool"("workspaceId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "WarmupPool_workspaceId_name_key" ON "WarmupPool"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "WarmupPoolMember_workspaceId_idx" ON "WarmupPoolMember"("workspaceId");

-- CreateIndex
CREATE INDEX "WarmupPoolMember_warmupPoolId_idx" ON "WarmupPoolMember"("warmupPoolId");

-- CreateIndex
CREATE UNIQUE INDEX "WarmupPoolMember_warmupPoolId_emailAccountId_key" ON "WarmupPoolMember"("warmupPoolId", "emailAccountId");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_deletedAt_createdAt_idx" ON "Lead"("workspaceId", "deletedAt", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Lead_workspaceId_status_idx" ON "Lead"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_ownerUserId_idx" ON "Lead"("workspaceId", "ownerUserId");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_emailDomain_idx" ON "Lead"("workspaceId", "emailDomain");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_score_idx" ON "Lead"("workspaceId", "score" DESC);

-- CreateIndex
CREATE INDEX "Lead_leadImportId_idx" ON "Lead"("leadImportId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_workspaceId_email_key" ON "Lead"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "LeadList_workspaceId_deletedAt_idx" ON "LeadList"("workspaceId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadList_workspaceId_name_key" ON "LeadList"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "LeadListMembership_leadId_idx" ON "LeadListMembership"("leadId");

-- CreateIndex
CREATE INDEX "LeadListMembership_workspaceId_idx" ON "LeadListMembership"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadListMembership_leadListId_leadId_key" ON "LeadListMembership"("leadListId", "leadId");

-- CreateIndex
CREATE INDEX "LeadTag_workspaceId_idx" ON "LeadTag"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadTag_workspaceId_name_key" ON "LeadTag"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "LeadTagLink_leadId_idx" ON "LeadTagLink"("leadId");

-- CreateIndex
CREATE INDEX "LeadTagLink_workspaceId_idx" ON "LeadTagLink"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadTagLink_leadTagId_leadId_key" ON "LeadTagLink"("leadTagId", "leadId");

-- CreateIndex
CREATE INDEX "CustomFieldDefinition_workspaceId_position_idx" ON "CustomFieldDefinition"("workspaceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_workspaceId_key_key" ON "CustomFieldDefinition"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "LeadImport_workspaceId_createdAt_idx" ON "LeadImport"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "LeadImport_uploadedByUserId_idx" ON "LeadImport"("uploadedByUserId");

-- CreateIndex
CREATE INDEX "Suppression_workspaceId_value_idx" ON "Suppression"("workspaceId", "value");

-- CreateIndex
CREATE INDEX "Suppression_workspaceId_reason_idx" ON "Suppression"("workspaceId", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_workspaceId_scope_value_key" ON "Suppression"("workspaceId", "scope", "value");

-- CreateIndex
CREATE INDEX "Campaign_workspaceId_status_updatedAt_idx" ON "Campaign"("workspaceId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Campaign_workspaceId_deletedAt_idx" ON "Campaign"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "Campaign_status_startAt_idx" ON "Campaign"("status", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_workspaceId_name_key" ON "Campaign"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "CampaignMailbox_emailAccountId_idx" ON "CampaignMailbox"("emailAccountId");

-- CreateIndex
CREATE INDEX "CampaignMailbox_workspaceId_idx" ON "CampaignMailbox"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMailbox_campaignId_emailAccountId_key" ON "CampaignMailbox"("campaignId", "emailAccountId");

-- CreateIndex
CREATE INDEX "CampaignLeadListSource_leadListId_idx" ON "CampaignLeadListSource"("leadListId");

-- CreateIndex
CREATE INDEX "CampaignLeadListSource_workspaceId_idx" ON "CampaignLeadListSource"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignLeadListSource_campaignId_leadListId_key" ON "CampaignLeadListSource"("campaignId", "leadListId");

-- CreateIndex
CREATE UNIQUE INDEX "Sequence_campaignId_key" ON "Sequence"("campaignId");

-- CreateIndex
CREATE INDEX "Sequence_workspaceId_idx" ON "Sequence"("workspaceId");

-- CreateIndex
CREATE INDEX "SequenceStep_workspaceId_idx" ON "SequenceStep"("workspaceId");

-- CreateIndex
CREATE INDEX "SequenceStep_sequenceId_position_idx" ON "SequenceStep"("sequenceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceStep_sequenceId_position_key" ON "SequenceStep"("sequenceId", "position");

-- CreateIndex
CREATE INDEX "SequenceStepVariant_workspaceId_idx" ON "SequenceStepVariant"("workspaceId");

-- CreateIndex
CREATE INDEX "SequenceStepVariant_sequenceStepId_enabled_idx" ON "SequenceStepVariant"("sequenceStepId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceStepVariant_sequenceStepId_label_key" ON "SequenceStepVariant"("sequenceStepId", "label");

-- CreateIndex
CREATE INDEX "CampaignLead_state_nextStepAt_idx" ON "CampaignLead"("state", "nextStepAt");

-- CreateIndex
CREATE INDEX "CampaignLead_campaignId_state_idx" ON "CampaignLead"("campaignId", "state");

-- CreateIndex
CREATE INDEX "CampaignLead_workspaceId_state_idx" ON "CampaignLead"("workspaceId", "state");

-- CreateIndex
CREATE INDEX "CampaignLead_leadId_state_idx" ON "CampaignLead"("leadId", "state");

-- CreateIndex
CREATE INDEX "CampaignLead_currentStepId_idx" ON "CampaignLead"("currentStepId");

-- CreateIndex
CREATE INDEX "CampaignLead_primaryThreadId_idx" ON "CampaignLead"("primaryThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignLead_campaignId_leadId_key" ON "CampaignLead"("campaignId", "leadId");

-- CreateIndex
CREATE INDEX "ScheduledEmail_state_scheduledAt_idx" ON "ScheduledEmail"("state", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledEmail_emailAccountId_state_scheduledAt_idx" ON "ScheduledEmail"("emailAccountId", "state", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledEmail_campaignId_state_idx" ON "ScheduledEmail"("campaignId", "state");

-- CreateIndex
CREATE INDEX "ScheduledEmail_campaignLeadId_idx" ON "ScheduledEmail"("campaignLeadId");

-- CreateIndex
CREATE INDEX "ScheduledEmail_workspaceId_state_idx" ON "ScheduledEmail"("workspaceId", "state");

-- CreateIndex
CREATE INDEX "ScheduledEmail_leadId_idx" ON "ScheduledEmail"("leadId");

-- CreateIndex
CREATE INDEX "ScheduledEmail_threadId_idx" ON "ScheduledEmail"("threadId");

-- CreateIndex
CREATE INDEX "ScheduledEmail_rfcMessageId_idx" ON "ScheduledEmail"("rfcMessageId");

-- CreateIndex
CREATE INDEX "ScheduledEmail_providerMessageId_idx" ON "ScheduledEmail"("providerMessageId");

-- CreateIndex
CREATE INDEX "ScheduledEmail_sequenceStepId_idx" ON "ScheduledEmail"("sequenceStepId");

-- CreateIndex
CREATE INDEX "ScheduledEmail_variantId_idx" ON "ScheduledEmail"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledEmail_campaignLeadId_sequenceStepId_key" ON "ScheduledEmail"("campaignLeadId", "sequenceStepId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledEmail_dedupeKey_key" ON "ScheduledEmail"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingLink_token_key" ON "TrackingLink"("token");

-- CreateIndex
CREATE INDEX "TrackingLink_workspaceId_idx" ON "TrackingLink"("workspaceId");

-- CreateIndex
CREATE INDEX "TrackingLink_scheduledEmailId_idx" ON "TrackingLink"("scheduledEmailId");

-- CreateIndex
CREATE INDEX "EmailThread_emailAccountId_isArchived_lastMessageAt_idx" ON "EmailThread"("emailAccountId", "isArchived", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "EmailThread_workspaceId_isArchived_lastMessageAt_idx" ON "EmailThread"("workspaceId", "isArchived", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "EmailThread_emailAccountId_isRead_lastMessageAt_idx" ON "EmailThread"("emailAccountId", "isRead", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "EmailThread_workspaceId_hasHumanReply_lastMessageAt_idx" ON "EmailThread"("workspaceId", "hasHumanReply", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "EmailThread_campaignLeadId_idx" ON "EmailThread"("campaignLeadId");

-- CreateIndex
CREATE INDEX "EmailThread_leadId_idx" ON "EmailThread"("leadId");

-- CreateIndex
CREATE INDEX "EmailThread_campaignId_idx" ON "EmailThread"("campaignId");

-- CreateIndex
CREATE INDEX "EmailThread_emailAccountId_rootMessageId_idx" ON "EmailThread"("emailAccountId", "rootMessageId");

-- CreateIndex
CREATE INDEX "EmailThread_workspaceId_normalizedSubject_idx" ON "EmailThread"("workspaceId", "normalizedSubject");

-- CreateIndex
CREATE UNIQUE INDEX "EmailThread_emailAccountId_providerThreadId_key" ON "EmailThread"("emailAccountId", "providerThreadId");

-- CreateIndex
CREATE INDEX "EmailMessage_threadId_sentAt_idx" ON "EmailMessage"("threadId", "sentAt");

-- CreateIndex
CREATE INDEX "EmailMessage_workspaceId_sentAt_idx" ON "EmailMessage"("workspaceId", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "EmailMessage_emailAccountId_rfcMessageId_idx" ON "EmailMessage"("emailAccountId", "rfcMessageId");

-- CreateIndex
CREATE INDEX "EmailMessage_emailAccountId_inReplyTo_idx" ON "EmailMessage"("emailAccountId", "inReplyTo");

-- CreateIndex
CREATE INDEX "EmailMessage_workspaceId_direction_classification_sentAt_idx" ON "EmailMessage"("workspaceId", "direction", "classification", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "EmailMessage_scheduledEmailId_idx" ON "EmailMessage"("scheduledEmailId");

-- CreateIndex
CREATE INDEX "EmailMessage_campaignLeadId_idx" ON "EmailMessage"("campaignLeadId");

-- CreateIndex
CREATE INDEX "EmailMessage_emailAccountId_direction_sentAt_idx" ON "EmailMessage"("emailAccountId", "direction", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "EmailMessage_workspaceId_bounceType_idx" ON "EmailMessage"("workspaceId", "bounceType");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_emailAccountId_providerMessageId_key" ON "EmailMessage"("emailAccountId", "providerMessageId");

-- CreateIndex
CREATE INDEX "EmailEvent_campaignId_type_occurredAt_idx" ON "EmailEvent"("campaignId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailEvent_sequenceStepId_type_occurredAt_idx" ON "EmailEvent"("sequenceStepId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailEvent_variantId_type_occurredAt_idx" ON "EmailEvent"("variantId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailEvent_emailAccountId_type_occurredAt_idx" ON "EmailEvent"("emailAccountId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailEvent_workspaceId_type_occurredAt_idx" ON "EmailEvent"("workspaceId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailEvent_campaignLeadId_type_idx" ON "EmailEvent"("campaignLeadId", "type");

-- CreateIndex
CREATE INDEX "EmailEvent_leadId_occurredAt_idx" ON "EmailEvent"("leadId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "EmailEvent_scheduledEmailId_type_idx" ON "EmailEvent"("scheduledEmailId", "type");

-- CreateIndex
CREATE INDEX "EmailEvent_threadId_idx" ON "EmailEvent"("threadId");

-- CreateIndex
CREATE INDEX "EmailEvent_emailMessageId_idx" ON "EmailEvent"("emailMessageId");

-- CreateIndex
CREATE INDEX "EmailEvent_workspaceId_occurredAt_idx" ON "EmailEvent"("workspaceId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailEvent_dedupeKey_key" ON "EmailEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "Task_workspaceId_assigneeUserId_status_dueAt_idx" ON "Task"("workspaceId", "assigneeUserId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_workspaceId_status_dueAt_idx" ON "Task"("workspaceId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_leadId_idx" ON "Task"("leadId");

-- CreateIndex
CREATE INDEX "Task_opportunityId_idx" ON "Task"("opportunityId");

-- CreateIndex
CREATE INDEX "Task_threadId_idx" ON "Task"("threadId");

-- CreateIndex
CREATE INDEX "Note_workspaceId_createdAt_idx" ON "Note"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Note_leadId_createdAt_idx" ON "Note"("leadId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Note_opportunityId_createdAt_idx" ON "Note"("opportunityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Note_threadId_idx" ON "Note"("threadId");

-- CreateIndex
CREATE INDEX "Note_authorUserId_idx" ON "Note"("authorUserId");

-- CreateIndex
CREATE INDEX "Opportunity_workspaceId_stage_position_idx" ON "Opportunity"("workspaceId", "stage", "position");

-- CreateIndex
CREATE INDEX "Opportunity_workspaceId_ownerUserId_stage_idx" ON "Opportunity"("workspaceId", "ownerUserId", "stage");

-- CreateIndex
CREATE INDEX "Opportunity_leadId_idx" ON "Opportunity"("leadId");

-- CreateIndex
CREATE INDEX "Opportunity_campaignId_idx" ON "Opportunity"("campaignId");

-- CreateIndex
CREATE INDEX "Opportunity_threadId_idx" ON "Opportunity"("threadId");

-- CreateIndex
CREATE INDEX "Opportunity_campaignLeadId_idx" ON "Opportunity"("campaignLeadId");

-- CreateIndex
CREATE INDEX "Activity_leadId_occurredAt_idx" ON "Activity"("leadId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Activity_workspaceId_occurredAt_idx" ON "Activity"("workspaceId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Activity_opportunityId_occurredAt_idx" ON "Activity"("opportunityId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Activity_campaignLeadId_idx" ON "Activity"("campaignLeadId");

-- CreateIndex
CREATE INDEX "Activity_actorUserId_idx" ON "Activity"("actorUserId");

-- CreateIndex
CREATE INDEX "Experiment_sequenceStepId_idx" ON "Experiment"("sequenceStepId");

-- CreateIndex
CREATE INDEX "Experiment_workspaceId_campaignId_idx" ON "Experiment"("workspaceId", "campaignId");

-- CreateIndex
CREATE INDEX "ExperimentArm_variantId_idx" ON "ExperimentArm"("variantId");

-- CreateIndex
CREATE INDEX "ExperimentArm_workspaceId_idx" ON "ExperimentArm"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentArm_experimentId_variantId_key" ON "ExperimentArm"("experimentId", "variantId");

-- CreateIndex
CREATE INDEX "AIAnalysis_workspaceId_kind_createdAt_idx" ON "AIAnalysis"("workspaceId", "kind", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AIAnalysis_emailMessageId_idx" ON "AIAnalysis"("emailMessageId");

-- CreateIndex
CREATE INDEX "AIAnalysis_threadId_idx" ON "AIAnalysis"("threadId");

-- CreateIndex
CREATE INDEX "AIAnalysis_leadId_idx" ON "AIAnalysis"("leadId");

-- CreateIndex
CREATE INDEX "AIAnalysis_campaignId_idx" ON "AIAnalysis"("campaignId");

-- CreateIndex
CREATE INDEX "AIAnalysis_campaignLeadId_idx" ON "AIAnalysis"("campaignLeadId");

-- CreateIndex
CREATE INDEX "AIAnalysis_workspaceId_classification_idx" ON "AIAnalysis"("workspaceId", "classification");

-- CreateIndex
CREATE UNIQUE INDEX "AIAnalysis_targetType_targetId_kind_promptVersion_key" ON "AIAnalysis"("targetType", "targetId", "kind", "promptVersion");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_providerEventId_key" ON "WebhookEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_state_receivedAt_idx" ON "WebhookEvent"("state", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_workspaceId_receivedAt_idx" ON "WebhookEvent"("workspaceId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "WebhookEvent_emailAccountId_idx" ON "WebhookEvent"("emailAccountId");

-- CreateIndex
CREATE INDEX "Job_state_runAt_priority_idx" ON "Job"("state", "runAt", "priority" DESC);

-- CreateIndex
CREATE INDEX "Job_state_leaseExpiresAt_idx" ON "Job"("state", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "Job_workspaceId_state_createdAt_idx" ON "Job"("workspaceId", "state", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Job_type_state_idx" ON "Job"("type", "state");

-- CreateIndex
CREATE INDEX "Job_scheduledEmailId_idx" ON "Job"("scheduledEmailId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_dedupeKey_key" ON "Job"("dedupeKey");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_activeWorkspaceId_fkey" FOREIGN KEY ("activeWorkspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_connectedByUserId_fkey" FOREIGN KEY ("connectedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxDailyStat" ADD CONSTRAINT "MailboxDailyStat_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxDailyStat" ADD CONSTRAINT "MailboxDailyStat_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupPool" ADD CONSTRAINT "WarmupPool_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupPoolMember" ADD CONSTRAINT "WarmupPoolMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupPoolMember" ADD CONSTRAINT "WarmupPoolMember_warmupPoolId_fkey" FOREIGN KEY ("warmupPoolId") REFERENCES "WarmupPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupPoolMember" ADD CONSTRAINT "WarmupPoolMember_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_leadImportId_fkey" FOREIGN KEY ("leadImportId") REFERENCES "LeadImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadList" ADD CONSTRAINT "LeadList_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadListMembership" ADD CONSTRAINT "LeadListMembership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadListMembership" ADD CONSTRAINT "LeadListMembership_leadListId_fkey" FOREIGN KEY ("leadListId") REFERENCES "LeadList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadListMembership" ADD CONSTRAINT "LeadListMembership_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadTag" ADD CONSTRAINT "LeadTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadTagLink" ADD CONSTRAINT "LeadTagLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadTagLink" ADD CONSTRAINT "LeadTagLink_leadTagId_fkey" FOREIGN KEY ("leadTagId") REFERENCES "LeadTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadTagLink" ADD CONSTRAINT "LeadTagLink_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldDefinition" ADD CONSTRAINT "CustomFieldDefinition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadImport" ADD CONSTRAINT "LeadImport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadImport" ADD CONSTRAINT "LeadImport_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMailbox" ADD CONSTRAINT "CampaignMailbox_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMailbox" ADD CONSTRAINT "CampaignMailbox_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMailbox" ADD CONSTRAINT "CampaignMailbox_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLeadListSource" ADD CONSTRAINT "CampaignLeadListSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLeadListSource" ADD CONSTRAINT "CampaignLeadListSource_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLeadListSource" ADD CONSTRAINT "CampaignLeadListSource_leadListId_fkey" FOREIGN KEY ("leadListId") REFERENCES "LeadList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sequence" ADD CONSTRAINT "Sequence_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sequence" ADD CONSTRAINT "Sequence_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep" ADD CONSTRAINT "SequenceStep_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep" ADD CONSTRAINT "SequenceStep_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStepVariant" ADD CONSTRAINT "SequenceStepVariant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStepVariant" ADD CONSTRAINT "SequenceStepVariant_sequenceStepId_fkey" FOREIGN KEY ("sequenceStepId") REFERENCES "SequenceStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_currentStepId_fkey" FOREIGN KEY ("currentStepId") REFERENCES "SequenceStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_primaryThreadId_fkey" FOREIGN KEY ("primaryThreadId") REFERENCES "EmailThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_sequenceStepId_fkey" FOREIGN KEY ("sequenceStepId") REFERENCES "SequenceStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "SequenceStepVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingLink" ADD CONSTRAINT "TrackingLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_scheduledEmailId_fkey" FOREIGN KEY ("scheduledEmailId") REFERENCES "ScheduledEmail"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_sequenceStepId_fkey" FOREIGN KEY ("sequenceStepId") REFERENCES "SequenceStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "SequenceStepVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_scheduledEmailId_fkey" FOREIGN KEY ("scheduledEmailId") REFERENCES "ScheduledEmail"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_sequenceStepId_fkey" FOREIGN KEY ("sequenceStepId") REFERENCES "SequenceStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentArm" ADD CONSTRAINT "ExperimentArm_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentArm" ADD CONSTRAINT "ExperimentArm_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentArm" ADD CONSTRAINT "ExperimentArm_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "SequenceStepVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIAnalysis" ADD CONSTRAINT "AIAnalysis_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIAnalysis" ADD CONSTRAINT "AIAnalysis_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIAnalysis" ADD CONSTRAINT "AIAnalysis_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIAnalysis" ADD CONSTRAINT "AIAnalysis_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIAnalysis" ADD CONSTRAINT "AIAnalysis_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIAnalysis" ADD CONSTRAINT "AIAnalysis_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_scheduledEmailId_fkey" FOREIGN KEY ("scheduledEmailId") REFERENCES "ScheduledEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ────────────────────────────────────────────────────────────────────────────
-- Hand-written objects that Prisma's schema language cannot express.
--
-- prisma/schema.prisma delegates each of these to "migration SQL" in a doc
-- comment. They are not optional: two of them serve the hottest paths in the
-- product (the queue lease and the scheduler's due-scan), and two are the sole
-- enforcement of a stated business rule.
--
-- Keep this block in sync with the schema comments that reference it.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. At most one LIVE invite per email per workspace.
--    A plain unique would forbid ever re-inviting someone whose invite expired
--    or was revoked, so the constraint applies only to PENDING rows.
CREATE UNIQUE INDEX "WorkspaceInvite_pending_unique"
  ON "WorkspaceInvite" ("workspaceId", "email")
  WHERE "status" = 'PENDING';

-- 2. A mailbox belongs to at most one warmup pool.
--    Declared here rather than as @@unique so Prisma keeps the relation
--    one-to-many and does not collapse EmailAccount.warmupMemberships into a
--    single optional row.
CREATE UNIQUE INDEX "WarmupPoolMember_emailAccount_unique"
  ON "WarmupPoolMember" ("emailAccountId");

-- 3. THE scheduler due-scan index.
--    SENT rows dominate ScheduledEmail forever, so a partial index over just
--    the pending states stays small and cache-resident while the full index
--    grows without bound.
CREATE INDEX "ScheduledEmail_due_idx"
  ON "ScheduledEmail" ("scheduledAt")
  WHERE "state" = 'SCHEDULED';

-- 4. THE queue lease index.
--    Same reasoning: SUCCEEDED rows accumulate between maintenance sweeps, and
--    the lease query only ever looks at leasable states.
CREATE INDEX "Job_leasable_idx"
  ON "Job" ("runAt", "priority" DESC)
  WHERE "state" IN ('PENDING', 'RETRYING');

-- 5. Reply attribution by RFC822 References.
--    Answers "is there an inbound message whose References contains a
--    Message-ID we sent" without a sequential scan over every message.
CREATE INDEX "EmailMessage_references_gin"
  ON "EmailMessage" USING GIN ("references");

-- 6. Inbox participant filter.
--    Lets the inbox filter threads by address without joining EmailMessage.
CREATE INDEX "EmailThread_participants_gin"
  ON "EmailThread" USING GIN ("participants");

-- 7. One LIVE experiment per sequence step.
--    Partial so a step can be tested again after an experiment ends; a plain
--    unique would permit exactly one test per step for all time.
CREATE UNIQUE INDEX "Experiment_live_per_step_unique"
  ON "Experiment" ("sequenceStepId")
  WHERE "endedAt" IS NULL;

-- 8. EmailEvent is append-only.
--    Analytics derive from this table, so a corrected or deleted row would
--    silently rewrite history. Enforced by a trigger rather than by convention,
--    because an application bug must not be able to do it.
CREATE OR REPLACE FUNCTION "emailevent_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'EmailEvent is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EmailEvent_no_update"
  BEFORE UPDATE OR DELETE ON "EmailEvent"
  FOR EACH ROW EXECUTE FUNCTION "emailevent_append_only"();
