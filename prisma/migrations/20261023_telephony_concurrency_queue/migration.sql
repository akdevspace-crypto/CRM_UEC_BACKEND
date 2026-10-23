-- ==============================================================================
-- MIGRATION: 20261023_telephony_concurrency_queue
-- ELDERCARE CRM — Scalable Telephony Concurrency & Queue Engine Architecture
-- Non-destructive additive migration with full backwards compatibility
-- ==============================================================================

-- 1. Telephony Capacity Pool (Persistent configuration per provider)
CREATE TABLE IF NOT EXISTS "TelephonyCapacityPool" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "provider" VARCHAR(50) NOT NULL,
    "totalChannels" INTEGER NOT NULL DEFAULT 3,
    "inboundReserved" INTEGER NOT NULL DEFAULT 1,
    "maxOutboundChannels" INTEGER NOT NULL DEFAULT 2,
    "supportsBursting" BOOLEAN NOT NULL DEFAULT false,
    "maxBurstChannels" INTEGER NOT NULL DEFAULT 0,
    "carrierTrunkId" VARCHAR(100),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "uq_telephony_capacity_provider" UNIQUE ("provider")
);

-- Seed initial capacity configurations for known providers (Vobiz & Exotel)
INSERT INTO "TelephonyCapacityPool" ("provider", "totalChannels", "inboundReserved", "maxOutboundChannels", "metadata")
VALUES 
    ('vobiz', 3, 1, 2, '{"description": "Vobiz primary SIP trunk", "sipDomain": "4c0ct02u07s.sip.livekit.cloud"}'::jsonb),
    ('exotel', 5, 1, 4, '{"description": "Exotel secondary/fallback carrier"}'::jsonb)
ON CONFLICT ("provider") DO NOTHING;

-- 2. Distributed Capacity Reservations Log (Auditing, telemetry, & crash recovery)
CREATE TABLE IF NOT EXISTS "CapacityReservation" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "provider" VARCHAR(50) NOT NULL,
    "providerCallId" VARCHAR(100) NOT NULL,
    "direction" VARCHAR(20) NOT NULL,
    "channelsAllocated" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'RESERVED',
    "reservedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP WITH TIME ZONE,
    "heldAt" TIMESTAMP WITH TIME ZONE,
    "nodeId" VARCHAR(100),
    "metadata" JSONB DEFAULT '{}'::jsonb,
    CONSTRAINT "uq_capacity_reservation_call" UNIQUE ("provider", "providerCallId")
);

CREATE INDEX IF NOT EXISTS "idx_capacity_reservation_provider_status" 
    ON "CapacityReservation" ("provider", "status");
CREATE INDEX IF NOT EXISTS "idx_capacity_reservation_reserved_at" 
    ON "CapacityReservation" ("reservedAt");

-- 3. Inbound Queue Overflow Callback Requests
CREATE TABLE IF NOT EXISTS "CallbackRequest" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "phoneNumber" VARCHAR(50) NOT NULL,
    "customerId" UUID REFERENCES "Customer"("id") ON DELETE SET NULL,
    "leadId" UUID REFERENCES "Lead"("id") ON DELETE SET NULL,
    "department" VARCHAR(50) NOT NULL DEFAULT 'GENERAL',
    "priority" VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP WITH TIME ZONE,
    "processedByAgentId" UUID REFERENCES "Agent"("id") ON DELETE SET NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_callback_request_status_dept" 
    ON "CallbackRequest" ("status", "department");
CREATE INDEX IF NOT EXISTS "idx_callback_request_phone" 
    ON "CallbackRequest" ("phoneNumber");

-- 4. High-Performance Telephony Indexes on Existing Queue & Call Session Tables
CREATE INDEX IF NOT EXISTS "idx_queue_item_status_priority_entered" 
    ON "QueueItem" ("status", "priority", "enteredAt");

CREATE INDEX IF NOT EXISTS "idx_queue_item_dept_status" 
    ON "QueueItem" ("department", "status");

CREATE INDEX IF NOT EXISTS "idx_call_session_provider_reason" 
    ON "CallSession" ("reason");

CREATE INDEX IF NOT EXISTS "idx_call_session_status_started" 
    ON "CallSession" ("status", "startedAt");
