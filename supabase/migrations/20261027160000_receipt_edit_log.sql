-- ════════════════════════════════════════════════════════════════════════════
--  Every manual edit of a Beleg leaves a row: field, old, new, editor, time
--
--  Since 20261013100000 a driver's Beleg is a `receipts` row the moment it
--  arrives — no status, no review, the owner's decision — so the ONE place a
--  human corrects a Beleg is the Belege screen's modal, and nothing recorded
--  what was corrected. A reviewer who changes 41,08 to 41,80 changes
--  `bar_zuruck` (what the driver owes the company) and the Tankenquote, and
--  the driver who photographed the receipt could never learn their figure was
--  moved, by whom, or from what. `public.receipt_edits` is that record.
--
--  ── The log is written BY A TRIGGER, not by the screen ──────────────────────
--
--  `app_private.record_receipt_edit()`, AFTER UPDATE on `public.receipts`,
--  diffs OLD against NEW column by column and writes one row per changed
--  field, with `auth.uid()` as the editor — in the same transaction as the
--  edit, so the log cannot be skipped, reordered or lost by a crash between
--  the two. The screen keeps writing `receipts` exactly as it always has
--  (`useDatabase.updateReceipt`); a rule enforced in one browser function is
--  lost silently by the next writer, and this one is about money.
--
--  A write with NO session (auth.uid() IS NULL) is not logged: migrations, a
--  backfill at psql and the service role are not a person's edit, and an edit
--  row without an editor would claim one. Every client UPDATE has a session by
--  construction — `receipts_update` is TO authenticated.
--
--  The diff is GENERIC (to_jsonb over the row, minus id/company_id/created_at/
--  updated_at) rather than a list of columns, so a column added later —
--  exactly what 20261027150000 just did five times — is logged without anyone
--  remembering this trigger exists.
--
--  ── `confirm` is the other verb, and the only client INSERT ────────────────
--
--  A reviewer who checks a Beleg and finds it RIGHT records that too: one row
--  with action `confirm`, field `receipt`, no values — a vouch for the Beleg
--  as it stands. Because every change is logged, the state the vouch covered
--  is reconstructable: today's row minus the changes logged after it.
--
--  The INSERT policy admits exactly that shape and nothing else: `confirm`
--  only (a client cannot forge a `change` row that never happened), the
--  caller's own id in `edited_by` (the fahrtenbuch_imports.imported_by rule:
--  a page says WHETHER you may write, never AS WHOM), the tenant term, the
--  `receipts` page's edit right, and the named Beleg visible in the caller's
--  own company.
--
--  ── Append-only, the conflict_reviews way ───────────────────────────────────
--
--  No UPDATE or DELETE policy, and no UPDATE, DELETE or TRUNCATE privilege for
--  any API role — so a client's attempt is a named refusal (42501), never a
--  200 with zero rows, and no SECURITY DEFINER function writes this table but
--  the trigger. Deliberately NOT a refusal trigger: `receipt_id` cascades, so
--  deleting a Beleg deletes its history and deleting a company deletes both —
--  the history is ABOUT the row, and this product deletes a Beleg outright. A
--  BEFORE DELETE refusal would block every receipt deletion through that
--  cascade, and an ENABLE ALWAYS one would also refuse the matrix's owner
--  validity pass, which must succeed on every table but the trip move. What a
--  table owner at psql can still do is the audit log's own U3 residual.
--
--  ── The shape every company table takes ─────────────────────────────────────
--
--  SELECT is the tenant term with the platform seam, writes carry the tenant
--  term in USING and WITH CHECK plus the `receipts` page (slice C's rule), and
--  both context triggers are attached because the policies name
--  get_active_company_id() (tests/rls/platform-contexts.sql section 14;
--  support-write-audit.sql section 1 requires the pair). A support session's
--  confirm or logged change therefore leaves the 3.4c audit rows as well.
--
--  The support-write audit copies edit rows in clear, like the Beleg columns
--  they quote (20261023180000's stated rule: a purchase, not a person's
--  circumstances). `tests/rls/receipt-edits.sql` probes all of it.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. the table ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.receipt_edits (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  receipt_id uuid        NOT NULL REFERENCES public.receipts(id)  ON DELETE CASCADE,
  action     text        NOT NULL CHECK (action IN ('change', 'confirm')),
  -- the receipts column a change names; the sentinel 'receipt' for a confirm
  field      text        NOT NULL CHECK (btrim(field) <> ''),
  old_value  text        NULL,
  new_value  text        NULL,
  -- a user id, deliberately without a foreign key: the history of an edit
  -- outlives the account that made it, as the platform audit log's actor does
  edited_by  uuid        NOT NULL,
  edited_at  timestamptz NOT NULL DEFAULT now(),

  -- A change states a real difference; a confirm vouches and carries no values.
  CONSTRAINT receipt_edits_shape CHECK (
    (action = 'change'  AND field <> 'receipt' AND old_value IS DISTINCT FROM new_value)
    OR
    (action = 'confirm' AND field = 'receipt' AND old_value IS NULL AND new_value IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS receipt_edits_by_receipt
  ON public.receipt_edits (receipt_id, edited_at DESC);
CREATE INDEX IF NOT EXISTS receipt_edits_by_company
  ON public.receipt_edits (company_id, edited_at DESC);

COMMENT ON TABLE public.receipt_edits IS
  'One row per manually changed Beleg field (written by the trigger on '
  'receipts, never by a client) and one per reviewer confirmation (the only '
  'client INSERT). Append-only for every API role: no UPDATE or DELETE policy '
  'and no privilege; rows end only with their Beleg''s own cascade.';

-- ─── 2. RLS: the tenant shape, writes on the receipts page ──────────────────

ALTER TABLE public.receipt_edits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS receipt_edits_select ON public.receipt_edits;
CREATE POLICY receipt_edits_select ON public.receipt_edits FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_active_company_id())
         OR (SELECT public.platform_reads_company_data()));

-- `confirm` rows only: the trigger writes `change` rows as the table's owner,
-- so a client-shaped `change` is a forged history entry and is refused here.
DROP POLICY IF EXISTS receipt_edits_insert ON public.receipt_edits;
CREATE POLICY receipt_edits_insert ON public.receipt_edits FOR INSERT TO authenticated
  WITH CHECK (
    company_id = (SELECT public.get_active_company_id())
    AND (SELECT public.current_role_permits('receipts', true))
    AND action = 'confirm'
    AND edited_by = (SELECT auth.uid())
    AND EXISTS (SELECT 1 FROM public.receipts r
                 WHERE r.id = receipt_id AND r.company_id = receipt_edits.company_id)
  );

-- No UPDATE and no DELETE policy, and no privilege either. Supabase's default
-- privileges hand every new table to the API roles with ALL; the policies gate
-- rows, but UPDATE and DELETE have no policy and must not be privileged, so a
-- refused write is a named refusal and not a 200 with zero rows (the
-- writeOutcome lesson). INSERT and SELECT stay granted to authenticated — the
-- policies above are their gate — and anon keeps nothing at all.
REVOKE ALL ON public.receipt_edits FROM PUBLIC, anon;
REVOKE UPDATE, DELETE, TRUNCATE ON public.receipt_edits FROM authenticated, service_role;

-- Both context triggers, because the policies name get_active_company_id().
DROP TRIGGER IF EXISTS refuse_read_only_context_write ON public.receipt_edits;
CREATE TRIGGER refuse_read_only_context_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.receipt_edits
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.refuse_read_only_context_write();

DROP TRIGGER IF EXISTS record_support_write ON public.receipt_edits;
CREATE TRIGGER record_support_write
  AFTER INSERT OR UPDATE OR DELETE ON public.receipt_edits
  FOR EACH ROW
  WHEN (current_setting('app_private.support_write_context', true) <> '')
  EXECUTE FUNCTION app_private.record_support_write();

-- ─── 3. the trigger that writes the history ─────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.record_receipt_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_editor uuid;
  v_old    jsonb;
  v_new    jsonb;
  v_key    text;
BEGIN
  -- auth.uid(), exactly as the policies resolve the caller. NULL — a
  -- migration, a psql backfill, the service role — is not a person's edit.
  v_editor := auth.uid();
  IF v_editor IS NULL THEN
    RETURN NULL;
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);

  -- Generic on purpose: a receipts column added later is logged without this
  -- function being restated. id and company_id cannot change (the policies
  -- pin the tenant on both sides); the two clock columns are bookkeeping.
  FOR v_key IN
    SELECT k FROM jsonb_object_keys(v_new) AS t(k)
     WHERE k NOT IN ('id', 'company_id', 'created_at', 'updated_at')
  LOOP
    IF (v_old -> v_key) IS DISTINCT FROM (v_new -> v_key) THEN
      INSERT INTO public.receipt_edits
             (company_id, receipt_id, action, field, old_value, new_value, edited_by)
      VALUES (OLD.company_id, OLD.id, 'change', v_key,
              v_old ->> v_key, v_new ->> v_key, v_editor);
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app_private.record_receipt_edit() IS
  'AFTER UPDATE on public.receipts: one receipt_edits row per changed column, '
  'with auth.uid() as the editor, in the edit''s own transaction. A session-less '
  'write (migration, service role) is not logged: it is not a person''s edit.';

REVOKE ALL ON FUNCTION app_private.record_receipt_edit()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS record_receipt_edit ON public.receipts;
CREATE TRIGGER record_receipt_edit
  AFTER UPDATE ON public.receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.record_receipt_edit();

-- ─── 4. self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  n      int;
  v_def  text;
  v_frag text;
  v_miss text[] := '{}';
  r      record;
BEGIN
  -- 1. exactly two policies: SELECT and the confirm-only INSERT. An UPDATE or
  --    DELETE policy here is a path around append-only.
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'receipt_edits';
  IF n <> 2 THEN
    RAISE EXCEPTION 'receipt-edits self-check 1: % policies instead of 2', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'receipt_edits' AND cmd IN ('UPDATE', 'DELETE');
  IF n > 0 THEN
    RAISE EXCEPTION 'receipt-edits self-check 1: an UPDATE or DELETE policy appeared';
  END IF;

  -- 2. the INSERT policy carries every term the header names.
  SELECT with_check INTO v_def FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'receipt_edits' AND cmd = 'INSERT';
  FOREACH v_frag IN ARRAY ARRAY[
    'get_active_company_id', 'current_role_permits', 'receipts',
    'confirm', 'edited_by', 'uid'
  ] LOOP
    IF position(v_frag IN coalesce(v_def, '')) = 0 THEN
      v_miss := v_miss || ('insert policy: ' || v_frag);
    END IF;
  END LOOP;

  -- 3. both context triggers (the pair rule) on the log, and the history
  --    trigger on receipts.
  FOR r IN SELECT unnest(ARRAY['refuse_read_only_context_write',
                               'record_support_write']) AS g LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
       WHERE c.relname = 'receipt_edits' AND tg.tgname = r.g AND NOT tg.tgisinternal
    ) THEN
      RAISE EXCEPTION 'receipt-edits self-check 3: receipt_edits is missing trigger %', r.g;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
     WHERE c.relname = 'receipts' AND tg.tgname = 'record_receipt_edit' AND NOT tg.tgisinternal
  ) THEN
    RAISE EXCEPTION 'receipt-edits self-check 3: receipts is missing record_receipt_edit';
  END IF;

  -- 4. the writer runs as the owner with a pinned path, and no API role can
  --    call it by hand.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'app_private' AND p.proname = 'record_receipt_edit'
       AND p.prosecdef
       AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION 'receipt-edits self-check 4: record_receipt_edit is not SECURITY DEFINER with a pinned search_path';
  END IF;
  IF has_function_privilege('anon', 'app_private.record_receipt_edit()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.record_receipt_edit()', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.record_receipt_edit()', 'EXECUTE') THEN
    RAISE EXCEPTION 'receipt-edits self-check 4: record_receipt_edit is executable by an API role';
  END IF;

  -- 5. the diff skips exactly the four bookkeeping columns and resolves the
  --    editor the way the policies do.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'app_private' AND p.proname = 'record_receipt_edit';
  FOREACH v_frag IN ARRAY ARRAY[
    'auth.uid()', 'IS DISTINCT FROM', 'to_jsonb(OLD)', 'to_jsonb(NEW)',
    '''id'', ''company_id'', ''created_at'', ''updated_at''',
    'IF v_editor IS NULL'
  ] LOOP
    IF position(v_frag IN v_def) = 0 THEN
      v_miss := v_miss || ('record_receipt_edit: ' || v_frag);
    END IF;
  END LOOP;

  -- 6. the privileges the header promises: anon holds nothing at all;
  --    authenticated and the service role hold neither UPDATE nor DELETE, so a
  --    client's attempt is a named refusal rather than 200 with zero rows.
  IF has_table_privilege('anon', 'public.receipt_edits', 'SELECT')
     OR has_table_privilege('anon', 'public.receipt_edits', 'INSERT')
     OR has_table_privilege('anon', 'public.receipt_edits', 'UPDATE')
     OR has_table_privilege('anon', 'public.receipt_edits', 'DELETE') THEN
    RAISE EXCEPTION 'receipt-edits self-check 6: anon holds a privilege on receipt_edits';
  END IF;
  IF has_table_privilege('authenticated', 'public.receipt_edits', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.receipt_edits', 'DELETE')
     OR has_table_privilege('service_role', 'public.receipt_edits', 'UPDATE')
     OR has_table_privilege('service_role', 'public.receipt_edits', 'DELETE') THEN
    RAISE EXCEPTION 'receipt-edits self-check 6: an API role holds UPDATE or DELETE on receipt_edits';
  END IF;

  IF array_length(v_miss, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'receipt-edits self-check: missing %', array_to_string(v_miss, ', ');
  END IF;

  RAISE NOTICE 'receipt edit log: self-checks passed';
END;
$check$;
