-- Add applied subscription period fields to activation_codes
-- These capture exactly what subscription period was granted when the code was redeemed.
ALTER TABLE activation_codes
  ADD COLUMN IF NOT EXISTS applied_subscription_started_at  timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS applied_subscription_expires_at  timestamptz DEFAULT NULL;

-- Backfill for already-used codes: we can approximate from companies data
-- The most recent used code per company gets the company's current subscription dates.
UPDATE activation_codes ac
SET
  applied_subscription_started_at = c.subscription_started_at,
  applied_subscription_expires_at = c.subscription_expires_at
FROM companies c
WHERE ac.id = c.last_activation_code_id
  AND ac.status = 'used'
  AND ac.applied_subscription_expires_at IS NULL;
