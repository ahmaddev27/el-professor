/*
# Create historical_wh_saved_plans table

## Purpose
Stores saved month plans from the "Alter Monat / Steuerberater-Abgleich → Mit Arbeitsstunden"
(historical working-hours reconciliation) flow. When the automatic reconciliation succeeds and
the user explicitly saves the plan, a record is created here so the plan and the final Fahrtenbuch
can be viewed and re-downloaded at any time.

## New Tables

### `historical_wh_saved_plans`
One row per saved plan. Each save captures:

| Column | Type | Description |
|--------|------|-------------|
| id | uuid PK | Unique plan identifier |
| company_id | uuid FK | The company this plan belongs to |
| month | integer 1–12 | The reconciliation month |
| year | integer | The reconciliation year |
| import_id | uuid FK (nullable) | Original fahrtenbuch_imports row (may be deleted later) |
| original_file_name | text | The original uploaded filename (preserved for display) |
| storage_path | text | Supabase Storage path to the original XLSX file |
| source_sheet_name | text | Sheet name in the original XLSX |
| source_columns_json | jsonb | Column order array from the source XLSX |
| saved_by | uuid FK (nullable) | auth.users.id of the user who clicked "Monatsplan speichern" |
| saved_at | timestamptz | When the plan was saved |
| export_ready | boolean | Whether the final validation passed (always true for saved plans) |
| export_block_reason | text | Reason if export was blocked (null for valid plans) |
| boundary_rows_json | jsonb | VehicleBoundaryRow[] — first/last driver per vehicle |
| shift_map_json | jsonb | Serialised shiftMap entries (tripId → {newStartMs, newEndMs, newDriver}) |
| note_reassignments_json | jsonb | Serialised noteReassignments (tripId → driverName) |
| driver_configs_json | jsonb | WzDriverConfig[] snapshot for re-display |
| validation_summary_json | jsonb | Summary of validation result flags |

## Security

- RLS enabled, company-scoped policies (matching pattern in historical_reconciliations).
- All four CRUD verbs covered separately.
- Scoped to `authenticated` because this app has sign-in.

## Notes

1. `shift_map_json` and `note_reassignments_json` together with `storage_path` allow
   re-exporting the exact same final Fahrtenbuch later without re-running the algorithm.
2. `boundary_rows_json` is stored pre-computed so the viewer can display it instantly.
3. The table does NOT store the full originalTrips array to keep row size manageable;
   the original XLSX is in Supabase Storage and trip data remains in fahrtenbuch_trips.
4. `import_id` is nullable (SET NULL on delete) because imports may be pruned.
   `original_file_name` and `storage_path` ensure display and re-download still work.
*/

CREATE TABLE IF NOT EXISTS historical_wh_saved_plans (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month                    integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  year                     integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  import_id                uuid REFERENCES fahrtenbuch_imports(id) ON DELETE SET NULL,
  original_file_name       text,
  storage_path             text,
  source_sheet_name        text,
  source_columns_json      jsonb NOT NULL DEFAULT '[]',
  saved_by                 uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  saved_at                 timestamptz NOT NULL DEFAULT now(),
  export_ready             boolean NOT NULL DEFAULT true,
  export_block_reason      text,
  boundary_rows_json       jsonb NOT NULL DEFAULT '[]',
  shift_map_json           jsonb NOT NULL DEFAULT '[]',
  note_reassignments_json  jsonb NOT NULL DEFAULT '[]',
  driver_configs_json      jsonb NOT NULL DEFAULT '[]',
  validation_summary_json  jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_historical_wh_saved_plans_company
  ON historical_wh_saved_plans (company_id, year DESC, month DESC);

ALTER TABLE historical_wh_saved_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_wh_saved_plans" ON historical_wh_saved_plans;
CREATE POLICY "select_own_wh_saved_plans" ON historical_wh_saved_plans FOR SELECT
  TO authenticated USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );

DROP POLICY IF EXISTS "insert_own_wh_saved_plans" ON historical_wh_saved_plans;
CREATE POLICY "insert_own_wh_saved_plans" ON historical_wh_saved_plans FOR INSERT
  TO authenticated WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );

DROP POLICY IF EXISTS "update_own_wh_saved_plans" ON historical_wh_saved_plans;
CREATE POLICY "update_own_wh_saved_plans" ON historical_wh_saved_plans FOR UPDATE
  TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );

DROP POLICY IF EXISTS "delete_own_wh_saved_plans" ON historical_wh_saved_plans;
CREATE POLICY "delete_own_wh_saved_plans" ON historical_wh_saved_plans FOR DELETE
  TO authenticated USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );
