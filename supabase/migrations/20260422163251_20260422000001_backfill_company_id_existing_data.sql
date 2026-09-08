/*
  # Backfill company_id on all existing business data rows

  ## Summary
  This migration assigns the existing company's ID to all rows that currently have
  company_id = NULL. This is required before tenant isolation can be enforced at the
  RLS level. Without this, all existing data would become invisible once company-scoped
  RLS policies are activated.

  ## Existing company
  The single existing company (Y&A Mobility) with id bc7e0e4d-6072-42f4-8029-4f0f0304c2c6
  owns all currently stored data. This migration formalizes that ownership.

  ## Tables backfilled
  1. receipts            - business receipts/belege
  2. income              - daily income/umsatze entries
  3. drivers             - driver profiles
  4. fixed_costs         - monthly fixed costs
  5. salaries            - salary records
  6. salary_payments     - individual salary payment records
  7. cash_transactions   - cash balance transactions
  8. cars                - vehicle registry
  9. car_driver_assignments - car/driver assignment links
  10. driver_notes       - notes attached to drivers
  11. werkstatt_checks   - vehicle workshop inspection records
  12. documents          - document builder records
  13. document_templates - uploaded document templates
  14. company_settings   - company identity/branding settings
  15. roles              - custom roles (system roles stay NULL, company roles get assigned)

  ## Safety
  - Only updates rows where company_id IS NULL
  - Does not touch rows that already have a company_id assigned
  - Fully idempotent: safe to run multiple times
  - Non-destructive: no data is deleted or duplicated
*/

DO $$
DECLARE
  v_company_id uuid := 'bc7e0e4d-6072-42f4-8029-4f0f0304c2c6';
  v_count integer;
BEGIN

  -- receipts
  UPDATE receipts SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'receipts backfilled: %', v_count;

  -- income
  UPDATE income SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'income backfilled: %', v_count;

  -- drivers
  UPDATE drivers SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'drivers backfilled: %', v_count;

  -- fixed_costs
  UPDATE fixed_costs SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'fixed_costs backfilled: %', v_count;

  -- salaries
  UPDATE salaries SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'salaries backfilled: %', v_count;

  -- salary_payments
  UPDATE salary_payments SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'salary_payments backfilled: %', v_count;

  -- cash_transactions
  UPDATE cash_transactions SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'cash_transactions backfilled: %', v_count;

  -- cars
  UPDATE cars SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'cars backfilled: %', v_count;

  -- car_driver_assignments
  UPDATE car_driver_assignments SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'car_driver_assignments backfilled: %', v_count;

  -- driver_notes
  UPDATE driver_notes SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'driver_notes backfilled: %', v_count;

  -- werkstatt_checks
  UPDATE werkstatt_checks SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'werkstatt_checks backfilled: %', v_count;

  -- documents
  UPDATE documents SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'documents backfilled: %', v_count;

  -- document_templates
  UPDATE document_templates SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'document_templates backfilled: %', v_count;

  -- company_settings (the single existing settings row)
  UPDATE company_settings SET company_id = v_company_id WHERE company_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'company_settings backfilled: %', v_count;

  -- roles: only assign company roles (non-system roles). System roles stay NULL (global).
  UPDATE roles SET company_id = v_company_id WHERE company_id IS NULL AND is_system = false;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'roles (non-system) backfilled: %', v_count;

  -- user_profiles: assign all users without a company to this company
  UPDATE user_profiles SET company_id = v_company_id WHERE company_id IS NULL AND is_super_admin = false;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'user_profiles backfilled: %', v_count;

END $$;
