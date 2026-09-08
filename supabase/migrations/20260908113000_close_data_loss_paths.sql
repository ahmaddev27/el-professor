/*
  # Close three paths that destroy closed-payroll-month records

  ## 1. Re-opened direct UPDATE on fahrtenbuch_trips

  20260607124839 — titled "harden_security_definer_functions_and_storage" —
  added an UPDATE policy to fahrtenbuch_trips:

      CREATE POLICY "fahrtenbuch_trips_update" ON fahrtenbuch_trips
        FOR UPDATE TO authenticated
        USING (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()))

  with the comment "Needed for plan apply operations that update mutable fields
  directly". Nothing does that. Every write to this table in the codebase goes
  through apply_monthly_planning_run, replace_monthly_planning_run or
  reassign_fahrtenbuch_trip — all SECURITY DEFINER, all bypassing RLS by
  design. A grep for a direct `.update()` on fahrtenbuch_trips across src/
  returns nothing.

  The policy's only effect is to re-open the client write path that the
  immutability trigger and the audit RPC exist to close: a direct UPDATE writes
  no audit row and runs none of the RPC's validation. Dropped.

  ## 2. The assignment audit trail dies with the trips it audits

  fahrtenbuch_assignment_audit.trip_id is ON DELETE CASCADE from
  fahrtenbuch_trips (20260605082427). The table is the record of who reassigned
  which trip and why, so cascading it away with its subject means the audit
  cannot outlive exactly the event it exists to prove.

  Changed to ON DELETE SET NULL and trip_id made nullable, so audit rows survive
  as an orphaned but readable record. The audit row already carries company_id,
  driver ids and names, so it remains meaningful without the trip.

  ## 3. Deleting an import destroys a finalized month's trips

  fahrtenbuch_trips.import_id is ON DELETE CASCADE from fahrtenbuch_imports, so
  removing one import row deletes every trip of that month. company_planning_runs
  .import_id is only SET NULL, so the run and its planning_finalizations survive
  — pointing at a month whose trips no longer exist.

  No client code deletes imports (this is reachable through the SQL editor or
  the dashboard rather than the app), but the cost is unrecoverable, so a
  trigger refuses the delete when a finalization exists for that import's month.
*/

-- ─── 1. Drop the redundant direct-write policy ──────────────────────────────

DROP POLICY IF EXISTS "fahrtenbuch_trips_update" ON public.fahrtenbuch_trips;

-- ─── 2. Let the audit trail outlive its trips ───────────────────────────────

DO $$
DECLARE
  v_constraint text;
BEGIN
  IF to_regclass('public.fahrtenbuch_assignment_audit') IS NULL THEN
    RAISE NOTICE 'fahrtenbuch_assignment_audit missing — skipping';
    RETURN;
  END IF;

  SELECT conname INTO v_constraint
  FROM pg_constraint
  WHERE conrelid = 'public.fahrtenbuch_assignment_audit'::regclass
    AND contype = 'f'
    AND conkey = ARRAY[
      (SELECT attnum FROM pg_attribute
        WHERE attrelid = 'public.fahrtenbuch_assignment_audit'::regclass
          AND attname = 'trip_id')
    ];

  IF v_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.fahrtenbuch_assignment_audit DROP CONSTRAINT %I',
      v_constraint
    );
  END IF;

  EXECUTE 'ALTER TABLE public.fahrtenbuch_assignment_audit ALTER COLUMN trip_id DROP NOT NULL';

  EXECUTE '
    ALTER TABLE public.fahrtenbuch_assignment_audit
      ADD CONSTRAINT fahrtenbuch_assignment_audit_trip_id_fkey
      FOREIGN KEY (trip_id) REFERENCES public.fahrtenbuch_trips(id) ON DELETE SET NULL';
END $$;

COMMENT ON COLUMN public.fahrtenbuch_assignment_audit.trip_id IS
  'Nullable on purpose: the audit row outlives the trip it describes. '
  'An audit trail that cascades away with its subject proves nothing.';

-- ─── 3. Refuse to delete an import belonging to a finalized month ───────────

CREATE OR REPLACE FUNCTION public.prevent_finalized_import_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_finalizations int;
BEGIN
  SELECT COUNT(*)
    INTO v_finalizations
  FROM planning_finalizations pf
  JOIN company_planning_runs r ON r.id = pf.planning_run_id
  WHERE r.import_id = OLD.id;

  IF v_finalizations > 0 THEN
    RAISE EXCEPTION
      'Fahrtenbuch-Import % kann nicht gelöscht werden: % abgeschlossene Planung(en) beziehen sich darauf. '
      'Die Stundennachweise und das Fahrtenbuch dieses Monats wurden bereits final erstellt.',
      OLD.id, v_finalizations
      USING ERRCODE = 'P0001';
  END IF;

  RETURN OLD;
END;
$fn$;

DROP TRIGGER IF EXISTS fahrtenbuch_imports_protect_finalized ON public.fahrtenbuch_imports;

CREATE TRIGGER fahrtenbuch_imports_protect_finalized
BEFORE DELETE ON public.fahrtenbuch_imports
FOR EACH ROW
EXECUTE FUNCTION public.prevent_finalized_import_delete();
