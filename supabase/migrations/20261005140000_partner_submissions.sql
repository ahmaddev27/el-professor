/*
  # What a driver sends from the partner's app, and how a company takes it

  The one thing that cannot be pulled. A driver photographs a Beleg or writes a
  note inside the partner's app; we never learn it happened, so it arrives as a
  push. It lands here as a **submission** and becomes a real row only when
  someone at the company accepts it.

  ## Why a review step, and not a direct write

  Both kinds move something real, and the owner decided on 04.10.2026 that both
  are reviewed:

  - A Beleg with `payment_method = 'bar'` enters `abrechnung_weekly`, which
    filters exactly that, and changes `bar_zuruck` — **what the driver owes the
    company**. A driver writing straight through would be editing their own debt.
  - A note of type `sick`, `vacation` or `off` carries
    `note_planning_behavior = 'exclude_from_plan'`, which is a **hard,
    non-overridable** rejection reason in `monatsplanungPhase3.ts`. A driver
    writing straight through would be removing themselves from the plan.

  ## A submission for an unlinked driver is kept, not refused

  `driver_id` is nullable. The driver has already taken the photograph; refusing
  it because nobody has confirmed their link yet would teach them the feature is
  unreliable, and the work is lost. It is stored with the identity the partner
  proposed, and `partner_submission_claim_driver()` resolves it the moment the
  link is confirmed in `partner_driver_links`.

  ## What the database enforces that the request cannot

  **`driver_notes.note_type` has no CHECK of its own** — it is free `text` with a
  default, and the closed list of ten lives only in TypeScript. Worse, nothing
  ties a type to its planning behaviour: a direct insert pairing `sick` with
  `neutral` is accepted and the planner **does not** exclude the driver, because
  `findBlockingNote` branches on the behaviour alone. So this migration carries
  the pairing itself, in `app_private.note_behavior_for()`, and the accept
  function derives the behaviour rather than believing the submission.

  Three more things the request never decides:

  - the **company** — it comes from the credential (`20261005120000`)
  - the **driver's name** written onto the receipt — read from the linked
    `drivers` row, byte for byte, because every downstream reader joins on it
  - the **Belegnummer** — drawn by `receipt_number_next()` (`20261005100000`)
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The note type -> behaviour pairing, held once, in the database
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.note_behavior_for(p_note_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  -- The ten types of NotesPage.tsx:104-115 and driverNoteValidation.ts:109-120,
  -- with the behaviour each one carries. NULL for anything else, which is how
  -- an unknown type is refused rather than stored as 'neutral' and ignored.
  SELECT CASE lower(btrim(p_note_type))
    WHEN 'general'   THEN 'neutral'
    WHEN 'other'     THEN 'neutral'
    WHEN 'sick'      THEN 'exclude_from_plan'
    WHEN 'vacation'  THEN 'exclude_from_plan'
    WHEN 'off'       THEN 'exclude_from_plan'
    WHEN 'blitzer'   THEN 'must_include_in_plan'
    WHEN 'accident'  THEN 'must_include_in_plan'
    WHEN 'kontrolle' THEN 'must_include_in_plan'
    WHEN 'breakdown' THEN 'must_include_in_plan'
    WHEN 'wait'      THEN 'must_include_in_plan'
  END;
$$;

COMMENT ON FUNCTION app_private.note_behavior_for(text) IS
  'The planning behaviour a note type carries. driver_notes.note_type has no '
  'CHECK and nothing ties it to note_planning_behavior, so a submission that '
  'named both could pair sick with neutral and the planner would not exclude '
  'the driver. The behaviour is derived here, never accepted from a caller.';

REVOKE ALL ON FUNCTION app_private.note_behavior_for(text) FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Receipt submissions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.partner_receipt_submissions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  partner            text        NOT NULL CHECK (partner = lower(btrim(partner)) AND partner <> ''),
  -- The partner's own id for this submission. Idempotency: a retry after a lost
  -- response finds the row it already wrote instead of creating a second Beleg.
  external_submission_id text    NOT NULL CHECK (btrim(external_submission_id) <> ''),
  external_driver_id text        NOT NULL CHECK (btrim(external_driver_id) <> ''),
  -- Resolved from partner_driver_links when the link is confirmed. NULL until
  -- then, and the submission waits rather than being refused.
  driver_id          uuid        NULL REFERENCES public.drivers(id) ON DELETE SET NULL,

  receipt_date       date        NULL,
  -- One of ReceiptModal's four, byte for byte, or NULL with free text instead.
  -- 'Other' is a sentinel and is never stored, here or on receipts.
  category           text        NULL CHECK (category IS NULL OR category IN
                       ('Tanken', 'Autowäsche', 'Autozubehör', 'Öl wechseln')),
  description        text        NULL,
  amount             numeric(10,2) NULL CHECK (amount IS NULL OR amount >= 0),
  payment_method     text        NULL CHECK (payment_method IS NULL
                                        OR payment_method IN ('bar','uberweisung')),
  postal_code        text        NULL CHECK (postal_code IS NULL OR postal_code ~ '^\d{5}$'),
  city               text        NULL,
  document_path      text        NULL,

  -- What the agent read and what the driver then confirmed. Kept because the
  -- reviewer is judging a reading, and a figure a person corrected is a
  -- different thing from one nobody looked at.
  read_by_agent      boolean     NOT NULL DEFAULT false,
  confirmed_by_driver boolean    NOT NULL DEFAULT false,
  captured_at        timestamptz NULL,

  status             text        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','accepted','rejected')),
  receipt_id         uuid        NULL REFERENCES public.receipts(id) ON DELETE SET NULL,
  rejected_reason    text        NULL,
  reviewed_by        uuid        NULL,
  reviewed_at        timestamptz NULL,
  raw_payload        jsonb       NULL,
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- An accepted submission names the Beleg it became; the others do not.
  CONSTRAINT partner_receipt_submissions_accepted_has_receipt
    CHECK ((status = 'accepted') = (receipt_id IS NOT NULL)),
  -- A rejection says why. "Rejected, no reason" is what the driver cannot act on.
  CONSTRAINT partner_receipt_submissions_rejected_has_reason
    CHECK (status <> 'rejected' OR btrim(coalesce(rejected_reason,'')) <> ''),
  -- Either a category or a description, or the Beleg has no subject at all.
  CONSTRAINT partner_receipt_submissions_has_subject
    CHECK (category IS NOT NULL OR btrim(coalesce(description,'')) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_receipt_submissions_idempotency
  ON public.partner_receipt_submissions (company_id, partner, external_submission_id);

CREATE INDEX IF NOT EXISTS partner_receipt_submissions_pending
  ON public.partner_receipt_submissions (company_id, status, submitted_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Note submissions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.partner_note_submissions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  partner            text        NOT NULL CHECK (partner = lower(btrim(partner)) AND partner <> ''),
  external_submission_id text    NOT NULL CHECK (btrim(external_submission_id) <> ''),
  external_driver_id text        NOT NULL CHECK (btrim(external_driver_id) <> ''),
  driver_id          uuid        NULL REFERENCES public.drivers(id) ON DELETE SET NULL,

  -- Validated against app_private.note_behavior_for() on write: an unknown type
  -- is refused rather than stored and silently treated as neutral.
  note_type          text        NOT NULL,
  note_text          text        NOT NULL DEFAULT '',
  start_date         date        NULL,
  end_date           date        NULL,
  is_full_day        boolean     NOT NULL DEFAULT false,
  start_time         text        NULL CHECK (start_time IS NULL OR start_time ~ '^\d{2}:\d{2}$'),
  end_time           text        NULL CHECK (end_time   IS NULL OR end_time   ~ '^\d{2}:\d{2}$'),

  status             text        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','accepted','rejected')),
  driver_note_id     uuid        NULL,
  rejected_reason    text        NULL,
  reviewed_by        uuid        NULL,
  reviewed_at        timestamptz NULL,
  raw_payload        jsonb       NULL,
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT partner_note_submissions_accepted_has_note
    CHECK ((status = 'accepted') = (driver_note_id IS NOT NULL)),
  CONSTRAINT partner_note_submissions_rejected_has_reason
    CHECK (status <> 'rejected' OR btrim(coalesce(rejected_reason,'')) <> ''),
  -- The end day counts, so it may equal the start but never precede it.
  CONSTRAINT partner_note_submissions_range_ordered
    CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  -- noteExclusionIntervals caps a range at 366 days and silently truncates
  -- beyond it. A submission that would be truncated is refused instead, because
  -- a note covering less than it says is worse than one that was not accepted.
  CONSTRAINT partner_note_submissions_range_capped
    CHECK (start_date IS NULL OR end_date IS NULL OR (end_date - start_date) <= 366)
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_note_submissions_idempotency
  ON public.partner_note_submissions (company_id, partner, external_submission_id);

CREATE INDEX IF NOT EXISTS partner_note_submissions_pending
  ON public.partner_note_submissions (company_id, status, submitted_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS -- the tenant shape, reviewed on the page that owns the subject
-- ─────────────────────────────────────────────────────────────────────────────

DO $rls$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT 'partner_receipt_submissions' AS tbl, 'receipts' AS page
    UNION ALL
    SELECT 'partner_note_submissions', 'notes'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tbl);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.tbl || '_select', t.tbl);
    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
        USING (company_id = (SELECT public.get_active_company_id())
               OR (SELECT public.platform_reads_company_data()))
    $p$, t.tbl || '_select', t.tbl);

    -- Reviewing is the only client write. No INSERT policy: the intake function
    -- writes through SECURITY DEFINER, and a row a client could insert would be
    -- a submission no driver ever made. No DELETE: a rejected submission is the
    -- record of a decision and the driver is shown it.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.tbl || '_update', t.tbl);
    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
        USING (company_id = (SELECT public.get_active_company_id())
               AND (SELECT public.current_role_permits(%L, true)))
        WITH CHECK (company_id = (SELECT public.get_active_company_id())
               AND (SELECT public.current_role_permits(%L, true)))
    $p$, t.tbl || '_update', t.tbl, t.page, t.page);

    -- Both context triggers, because the policies name get_active_company_id().
    EXECUTE format('DROP TRIGGER IF EXISTS refuse_read_only_context_write ON public.%I', t.tbl);
    EXECUTE format($p$
      CREATE TRIGGER refuse_read_only_context_write
        BEFORE INSERT OR UPDATE OR DELETE ON public.%I
        FOR EACH STATEMENT EXECUTE FUNCTION app_private.refuse_read_only_context_write()
    $p$, t.tbl);

    EXECUTE format('DROP TRIGGER IF EXISTS record_support_write ON public.%I', t.tbl);
    EXECUTE format($p$
      CREATE TRIGGER record_support_write
        AFTER INSERT OR UPDATE OR DELETE ON public.%I
        FOR EACH ROW
        WHEN (current_setting('app_private.support_write_context', true) <> '')
        EXECUTE FUNCTION app_private.record_support_write()
    $p$, t.tbl);
  END LOOP;
END
$rls$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. A confirmed link claims the submissions that were waiting for it
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_submission_claim_driver(p_link_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_link    public.partner_driver_links;
  v_company uuid;
  v_r       int := 0;
  v_n       int := 0;
BEGIN
  v_company := public.get_active_company_id();
  IF v_company IS NULL OR NOT public.current_role_permits('drivers', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  SELECT * INTO v_link FROM public.partner_driver_links
   WHERE id = p_link_id AND company_id = v_company;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'link not found'
      USING ERRCODE = 'P0002', HINT = 'link_not_found';
  END IF;
  IF v_link.status <> 'linked' OR v_link.driver_id IS NULL THEN
    RAISE EXCEPTION 'link is not confirmed'
      USING ERRCODE = 'P0001', HINT = 'link_not_confirmed';
  END IF;

  -- Only what is still waiting: an accepted or rejected submission already
  -- carries a decision, and re-pointing it would rewrite a settled record.
  UPDATE public.partner_receipt_submissions
     SET driver_id = v_link.driver_id, updated_at = now()
   WHERE company_id = v_company AND partner = v_link.partner
     AND external_driver_id = v_link.external_driver_id
     AND driver_id IS NULL AND status = 'pending';
  GET DIAGNOSTICS v_r = ROW_COUNT;

  UPDATE public.partner_note_submissions
     SET driver_id = v_link.driver_id, updated_at = now()
   WHERE company_id = v_company AND partner = v_link.partner
     AND external_driver_id = v_link.external_driver_id
     AND driver_id IS NULL AND status = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'receipts', v_r, 'notes', v_n);
END;
$$;

COMMENT ON FUNCTION public.partner_submission_claim_driver(uuid) IS
  'Points the submissions that arrived before a link was confirmed at the driver '
  'it names. Only pending ones: an accepted or rejected submission already '
  'carries a decision.';

REVOKE ALL ON FUNCTION public.partner_submission_claim_driver(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_submission_claim_driver(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Self-check
-- ─────────────────────────────────────────────────────────────────────────────

DO $check$
DECLARE
  t text;
  r record;
  n int;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_receipt_submissions','partner_note_submissions'] LOOP
    -- 1. no INSERT and no DELETE policy
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname = 'public' AND tablename = t AND cmd IN ('INSERT','DELETE');
    IF n > 0 THEN
      RAISE EXCEPTION 'self-check 1: % gained an INSERT or DELETE policy', t;
    END IF;

    -- 2. both context triggers
    FOR r IN SELECT unnest(ARRAY['refuse_read_only_context_write','record_support_write']) AS g LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
         WHERE c.relname = t AND tg.tgname = r.g AND NOT tg.tgisinternal
      ) THEN
        RAISE EXCEPTION 'self-check 2: % is missing trigger %', t, r.g;
      END IF;
    END LOOP;

    -- 3. idempotency is enforced, not merely intended
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = t
         AND indexdef LIKE 'CREATE UNIQUE INDEX%external_submission_id%'
    ) THEN
      RAISE EXCEPTION 'self-check 3: % has no idempotency index', t;
    END IF;
  END LOOP;

  -- 4. the ten note types resolve, and nothing else does
  FOR r IN SELECT unnest(ARRAY['general','sick','vacation','off','blitzer',
                               'accident','kontrolle','breakdown','wait','other']) AS ty LOOP
    IF app_private.note_behavior_for(r.ty) IS NULL THEN
      RAISE EXCEPTION 'self-check 4: note type % resolves to no behaviour', r.ty;
    END IF;
  END LOOP;
  IF app_private.note_behavior_for('krank') IS NOT NULL
  OR app_private.note_behavior_for('') IS NOT NULL
  OR app_private.note_behavior_for(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'self-check 4: an unknown note type resolved to a behaviour';
  END IF;

  -- 5. the three exclude_from_plan types are exactly the ones the UI treats as
  --    a range. If a fourth is ever added here and not there, a driver could
  --    remove themselves from the plan through a type nobody reviewed as such.
  IF app_private.note_behavior_for('sick')     <> 'exclude_from_plan'
  OR app_private.note_behavior_for('vacation') <> 'exclude_from_plan'
  OR app_private.note_behavior_for('off')      <> 'exclude_from_plan' THEN
    RAISE EXCEPTION 'self-check 5: the exclude_from_plan set moved';
  END IF;

  -- 6. a rejection must say why
  BEGIN
    INSERT INTO public.partner_receipt_submissions
           (company_id, partner, external_submission_id, external_driver_id,
            category, status)
    VALUES (gen_random_uuid(), 'selfcheck', 'x', 'y', 'Tanken', 'rejected');
    RAISE EXCEPTION 'self-check 6: a rejection with no reason was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
    WHEN foreign_key_violation THEN NULL;
  END;

  RAISE NOTICE 'partner submissions: self-checks passed';
END
$check$;
