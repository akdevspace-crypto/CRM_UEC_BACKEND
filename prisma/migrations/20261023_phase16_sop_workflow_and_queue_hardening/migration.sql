-- Phase 16: CRM SOP Workflow Persistence & Queue Engine Hardening
-- Adds durable persistence for HR Staff & Requirements, Sales Pipeline Stages, CCR Complaints, SOP Daily Reports, and Advanced Queue Routing

-- 1. Create StaffProfile Table
CREATE TABLE IF NOT EXISTS "StaffProfile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "staffId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "gender" TEXT,
    "category" TEXT NOT NULL,
    "classification" TEXT NOT NULL DEFAULT 'NORMAL',
    "verificationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "qualifications" TEXT,
    "experienceYears" DOUBLE PRECISION,
    "city" TEXT,
    "location" TEXT,
    "preferredShift" TEXT,
    "dailyRate" DECIMAL(10,2),
    "monthlySalary" DECIMAL(10,2),
    "source" TEXT,
    "emergencyContact" TEXT,
    "idProofType" TEXT,
    "idProofNumber" TEXT,
    "policeVerificationDone" BOOLEAN NOT NULL DEFAULT false,
    "medicalFitnessDone" BOOLEAN NOT NULL DEFAULT false,
    "documents" JSONB,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "currentAssignmentId" TEXT,
    "alternateAssignmentId" TEXT,
    "secondHrVerifiedBy" TEXT,
    "secondHrVerifiedAt" TIMESTAMP(3),
    "tlmHandoverAt" TIMESTAMP(3),
    "joiningDate" TIMESTAMP(3),
    "threeDayFollowupDone" BOOLEAN NOT NULL DEFAULT false,
    "threeDayFollowupDate" TIMESTAMP(3),
    "threeDayFollowupNotes" TEXT,
    "unitId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StaffProfile_staffId_key" ON "StaffProfile"("staffId");
CREATE INDEX IF NOT EXISTS "StaffProfile_phone_idx" ON "StaffProfile"("phone");
CREATE INDEX IF NOT EXISTS "StaffProfile_category_idx" ON "StaffProfile"("category");
CREATE INDEX IF NOT EXISTS "StaffProfile_classification_idx" ON "StaffProfile"("classification");
CREATE INDEX IF NOT EXISTS "StaffProfile_verificationStatus_idx" ON "StaffProfile"("verificationStatus");
CREATE INDEX IF NOT EXISTS "StaffProfile_isAvailable_idx" ON "StaffProfile"("isAvailable");
CREATE INDEX IF NOT EXISTS "StaffProfile_unitId_idx" ON "StaffProfile"("unitId");

-- 2. Create StaffRequirement Table (Wanted Staff Alarms)
CREATE TABLE IF NOT EXISTS "StaffRequirement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "requirementCode" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "qualificationRequired" TEXT,
    "location" TEXT,
    "unitId" UUID,
    "openPositions" INTEGER NOT NULL DEFAULT 1,
    "fulfilledPositions" INTEGER NOT NULL DEFAULT 0,
    "urgency" TEXT NOT NULL DEFAULT 'NORMAL',
    "requiredByDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffRequirement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StaffRequirement_requirementCode_key" ON "StaffRequirement"("requirementCode");
CREATE INDEX IF NOT EXISTS "StaffRequirement_category_idx" ON "StaffRequirement"("category");
CREATE INDEX IF NOT EXISTS "StaffRequirement_status_idx" ON "StaffRequirement"("status");
CREATE INDEX IF NOT EXISTS "StaffRequirement_urgency_idx" ON "StaffRequirement"("urgency");
CREATE INDEX IF NOT EXISTS "StaffRequirement_requiredByDate_idx" ON "StaffRequirement"("requiredByDate");

-- 3. Create SopDailyReport Table
CREATE TABLE IF NOT EXISTS "SopDailyReport" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "department" "SopDepartment" NOT NULL,
    "reportDate" DATE NOT NULL,
    "reporterId" UUID NOT NULL,
    "reporterName" TEXT NOT NULL,
    "unitId" UUID,
    "metrics" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SopDailyReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SopDailyReport_dept_date_reporter_key" 
ON "SopDailyReport"("department", "reportDate", "reporterId");
CREATE INDEX IF NOT EXISTS "SopDailyReport_department_idx" ON "SopDailyReport"("department");
CREATE INDEX IF NOT EXISTS "SopDailyReport_reportDate_idx" ON "SopDailyReport"("reportDate");

-- 4. Create SalesPipelineStage Table
CREATE TABLE IF NOT EXISTS "SalesPipelineStage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "leadId" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "previousStage" TEXT,
    "actorId" UUID NOT NULL,
    "actorName" TEXT NOT NULL,
    "notes" TEXT,
    "tariffAmount" DECIMAL(12,2),
    "officeServiceCharge" DECIMAL(12,2),
    "paymentStatus" TEXT,
    "matchedStaffId" TEXT,
    "alternateStaffId" TEXT,
    "nextActionDate" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesPipelineStage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SalesPipelineStage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "SalesPipelineStage_leadId_idx" ON "SalesPipelineStage"("leadId");
CREATE INDEX IF NOT EXISTS "SalesPipelineStage_stage_idx" ON "SalesPipelineStage"("stage");
CREATE INDEX IF NOT EXISTS "SalesPipelineStage_actorId_idx" ON "SalesPipelineStage"("actorId");
CREATE INDEX IF NOT EXISTS "SalesPipelineStage_nextActionDate_idx" ON "SalesPipelineStage"("nextActionDate");

-- 5. Extend Ticket Table for CCR Complaints
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "severity" TEXT DEFAULT 'NORMAL';
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "affectedStaffId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "replacementStaffId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "investigationNotes" TEXT;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "managerApprovalStatus" TEXT DEFAULT 'NOT_REQUIRED';
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "threeDayFollowupDate" TIMESTAMP(3);
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "threeDayFollowupNotes" TEXT;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "tenDayFollowupDate" TIMESTAMP(3);
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "tenDayFollowupNotes" TEXT;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "customerSatisfactionScore" INTEGER;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "testimonialNotes" TEXT;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "referralNotes" TEXT;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "closedById" UUID;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3);

-- 6. Extend Queue Table for Configurable Routing
ALTER TABLE "Queue" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN DEFAULT true;
ALTER TABLE "Queue" ADD COLUMN IF NOT EXISTS "priority" INTEGER DEFAULT 1;
ALTER TABLE "Queue" ADD COLUMN IF NOT EXISTS "skillsRequired" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Queue" ADD COLUMN IF NOT EXISTS "serviceCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Queue" ADD COLUMN IF NOT EXISTS "businessHours" JSONB;
ALTER TABLE "Queue" ADD COLUMN IF NOT EXISTS "maxWaitSeconds" INTEGER DEFAULT 300;
ALTER TABLE "Queue" ADD COLUMN IF NOT EXISTS "agentRingTimeoutSeconds" INTEGER DEFAULT 25;
ALTER TABLE "Queue" ADD COLUMN IF NOT EXISTS "overflowQueueId" UUID;
ALTER TABLE "Queue" ADD COLUMN IF NOT EXISTS "assignmentStrategy" TEXT DEFAULT 'LONGEST_IDLE';

-- 7. Extend QueueItem Table for Contact-Center Metrics
ALTER TABLE "QueueItem" ADD COLUMN IF NOT EXISTS "callSessionId" UUID;
ALTER TABLE "QueueItem" ADD COLUMN IF NOT EXISTS "enteredAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "QueueItem" ADD COLUMN IF NOT EXISTS "assignedAt" TIMESTAMP(3);
ALTER TABLE "QueueItem" ADD COLUMN IF NOT EXISTS "assignmentAttempts" INTEGER DEFAULT 0;
ALTER TABLE "QueueItem" ADD COLUMN IF NOT EXISTS "assignedAgentId" UUID;
ALTER TABLE "QueueItem" ADD COLUMN IF NOT EXISTS "waitDuration" INTEGER;
ALTER TABLE "QueueItem" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
