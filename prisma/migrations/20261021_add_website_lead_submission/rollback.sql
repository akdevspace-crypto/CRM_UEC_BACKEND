-- Rollback Migration: 20261021_add_website_lead_submission
-- Description: Drop WebsiteLeadSubmission table and all associated indexes/foreign keys.

DROP TABLE IF EXISTS "WebsiteLeadSubmission" CASCADE;
