-- Add include_in_reconciliation and is_owner_driver to historical_reconciliation_drivers
ALTER TABLE historical_reconciliation_drivers
  ADD COLUMN IF NOT EXISTS include_in_reconciliation boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_owner_driver            boolean NOT NULL DEFAULT false;

-- Add Inhaber/Ausgleichsfahrer config to historical_reconciliations
ALTER TABLE historical_reconciliations
  ADD COLUMN IF NOT EXISTS use_inhaber          boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS inhaber_driver_id    uuid    REFERENCES drivers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS inhaber_generate_pdf boolean NOT NULL DEFAULT true;
