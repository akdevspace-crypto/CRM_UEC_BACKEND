-- Migration: 20261021_add_website_lead_submission
-- Description: Enforce database-level uniqueness and auditability for external website lead submissions.
-- Release Gate C.2 & C.3: Dedicated durable integration-event model eliminating reliance on text searches within lead notes.

CREATE TABLE IF NOT EXISTS "WebsiteLeadSubmission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sourceId" TEXT NOT NULL,
    "externalSubmissionId" TEXT NOT NULL,
    "leadId" UUID NOT NULL,
    "sourceSubmittedAt" TIMESTAMP(3),
    "payloadHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROCESSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebsiteLeadSubmission_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebsiteLeadSubmission_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Unique index enforcing exactly-once ingestion per source and external submission ID at the DB level
CREATE UNIQUE INDEX IF NOT EXISTS "WebsiteLeadSubmission_sourceId_externalSubmissionId_key" 
ON "WebsiteLeadSubmission"("sourceId", "externalSubmissionId");

-- Index for lead correlation
CREATE INDEX IF NOT EXISTS "WebsiteLeadSubmission_leadId_idx" 
ON "WebsiteLeadSubmission"("leadId");

-- Index for source filtering
CREATE INDEX IF NOT EXISTS "WebsiteLeadSubmission_sourceId_idx" 
ON "WebsiteLeadSubmission"("sourceId");
