-- ==============================================================================
-- ROLLBACK SCRIPT: 20261023_telephony_concurrency_queue
-- ELDERCARE CRM — Safe Reversible Rollback Script
-- Drops newly added telephony tables and indexes cleanly without touching customer/agent data
-- ==============================================================================

-- 1. Drop Indexes
DROP INDEX IF EXISTS "idx_call_session_status_started";
DROP INDEX IF EXISTS "idx_call_session_provider_reason";
DROP INDEX IF EXISTS "idx_queue_item_dept_status";
DROP INDEX IF EXISTS "idx_queue_item_status_priority_entered";
DROP INDEX IF EXISTS "idx_callback_request_phone";
DROP INDEX IF EXISTS "idx_callback_request_status_dept";
DROP INDEX IF EXISTS "idx_capacity_reservation_reserved_at";
DROP INDEX IF EXISTS "idx_capacity_reservation_provider_status";

-- 2. Drop Tables
DROP TABLE IF EXISTS "CallbackRequest" CASCADE;
DROP TABLE IF EXISTS "CapacityReservation" CASCADE;
DROP TABLE IF EXISTS "TelephonyCapacityPool" CASCADE;
