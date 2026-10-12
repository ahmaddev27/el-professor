-- ════════════════════════════════════════════════════════════════════════════
--  M4 — no photo, no Beleg; and the driver's name is ours
-- ════════════════════════════════════════════════════════════════════════════
--
--  `20261008140000`'s three functions. The matrix cell for the accept reads `T`
--  for every authorised principal, because its fixture has neither a document
--  nor a linked driver — so the grid cannot tell the gate from the Beleg's own
--  rules. **This file is what separates them**, which is the lesson from the
--  two empty probes of 07.10 written down as a file rather than as a comment.
--
--  Four probes carry the slice:
--
--    §3  a Beleg with NO PHOTO cannot be accepted. The audit's blocker:
--        `document_path` appeared exactly once in the repository — its own
--        column definition — and the submission's CHECK admits a row with a
--        category, an amount and no document at all.
--    §4  the `receipts` row carries OUR driver row's name, character for
--        character. `receipts` has no `driver_id`; every read joins on that
--        text, so a submitted name is money that belongs to nobody.
--    §4  the Belegnummer comes from the server counter, not from the browser's
--        old `BEL-${Date.now()}`.
--    §5  a rejection leaves the photo in place: a rejected Beleg is still a
--        record of what was claimed.

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _ra_call(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out  text;
  v_hint text;
BEGIN
  EXECUTE p_sql INTO v_out;
  RETURN coalesce(v_out, 'null');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
  RETURN 'ERR ' || SQLSTATE || ' ' || coalesce(nullif(v_hint, ''), '(no hint)');
END;
$$;

CREATE TEMP TABLE _ra_out (
  n integer PRIMARY KEY, label text NOT NULL,
  actual text NOT NULL, expected text NOT NULL, matched boolean NOT NULL
);
GRANT SELECT, INSERT ON _ra_out TO authenticated;

CREATE OR REPLACE FUNCTION _ra_rec(p_n integer, p_label text, p_actual text, p_expected text,
                                   p_like boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := CASE WHEN p_like THEN p_actual LIKE p_expected ELSE p_actual = p_expected END;
  INSERT INTO _ra_out VALUES (p_n, p_label, p_actual, p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', p_actual;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION _ra_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION _ra_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

-- ─── fixtures ───────────────────────────────────────────────────────────────

INSERT INTO drivers (id, company_id, name) VALUES
  ('4a000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'Omar Khalil');

INSERT INTO partner_driver_links
       (id, company_id, partner, external_driver_id, driver_id, status, linked_at)
VALUES ('4b000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'ra-1', '4a000000-0000-4000-8000-000000000001', 'linked', now());

-- ─── 1. the partner's door ──────────────────────────────────────────────────

DO $$
DECLARE v_co constant text := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  -- Flipped on 10.10.2026. It recorded a refusal, and the owner reversed the
  -- rule it was measuring: a driver sends the figures, their app reads the
  -- receipt on the phone, and the image never travels. A door that refused a
  -- documentless Beleg would refuse every submission a current app makes.
  PERFORM _ra_rec(1, 'a Beleg with no document is recorded, not refused',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-nodoc', 'ra-1',
      '2026-10-07', 'Tanken', NULL, '41.47') ->> 'status'$q$, v_co)),
    'pending');

  PERFORM _ra_rec(2, 'and one with no date',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-nodate', 'ra-1',
      NULL, 'Tanken', NULL, '41.47', 'bar', NULL, 'k/partner/x.jpg')::text$q$, v_co)),
    'ERR 22023 invalid_date');

  PERFORM _ra_rec(3, 'an amount that is not a number is refused, never read as zero',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-bad', 'ra-1',
      '2026-10-07', 'Tanken', NULL, 'vierzig', 'bar', NULL, 'k/partner/x.jpg')::text$q$, v_co)),
    'ERR 22023 invalid_amount');

  PERFORM _ra_rec(4, 'and a negative one',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-neg', 'ra-1',
      '2026-10-07', 'Tanken', NULL, '-5.00', 'bar', NULL, 'k/partner/x.jpg')::text$q$, v_co)),
    'ERR 22023 invalid_amount');

  PERFORM _ra_rec(5, 'a complete Beleg arrives pending, with the driver resolved from our link',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-ok', 'ra-1',
      '2026-10-07', 'Tanken', NULL, '41.47', 'bar', '10115',
      'c0000000-0000-4000-8000-00000000000a/partner/ra-ok.jpg') ->> 'driver_id'$q$, v_co)),
    '4a000000-0000-4000-8000-000000000001');

  PERFORM _ra_rec(6, 'a retry is not a second row and returns the existing decision',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-ok', 'ra-1',
      '2026-10-07', 'Autowäsche', NULL, '99.99', 'bar', NULL,
      'c0000000-0000-4000-8000-00000000000a/partner/ra-ok.jpg') ->> 'duplicate'$q$, v_co)),
    'true');

  PERFORM _ra_rec(7, 'and the retry did not overwrite the amount',
    (SELECT amount::text FROM partner_receipt_submissions
      WHERE company_id = v_co::uuid AND external_submission_id = 'ra-ok'),
    '41.47');

  -- An unconfirmed external driver leaves the Beleg waiting, exactly as a note
  -- does: M2's confirmation is the only way a submission reaches a driver.
  PERFORM _ra_rec(8, 'an unlinked external driver leaves the Beleg with no driver',
    _ra_call(format($q$SELECT coalesce(partner_receipt_submission_record(%L, 'reidey', 'ra-unlinked', 'ra-nobody',
      '2026-10-07', 'Tanken', NULL, '10.00', 'bar', NULL,
      'c0000000-0000-4000-8000-00000000000a/partner/ra-unlinked.jpg') ->> 'driver_id', 'null')$q$, v_co)),
    'null');
END $$;

-- ─── 2. the role gate ───────────────────────────────────────────────────────

DO $$
DECLARE v_viewer constant uuid := 'a0000000-0000-4000-8000-000000000003';
BEGIN
  PERFORM _ra_as(v_viewer);
  PERFORM _ra_rec(9, 'a viewer may not accept a Beleg',
    _ra_call($q$SELECT partner_receipt_accept(
      (SELECT id FROM partner_receipt_submissions WHERE external_submission_id = 'ra-ok'))::text$q$),
    'ERR 42501 not_authorized');
  PERFORM _ra_rec(10, 'nor reject one',
    _ra_call($q$SELECT partner_receipt_reject(
      (SELECT id FROM partner_receipt_submissions WHERE external_submission_id = 'ra-ok'), 'x')::text$q$),
    'ERR 42501 not_authorized');
  PERFORM _ra_reset();
END $$;

-- ─── 3. no photo, no Beleg — the audit's blocker ───────────────────────────

DO $$
DECLARE
  v_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id uuid;
BEGIN
  -- A submission with no document, written past the door the way a row from
  -- before this migration would look.
  INSERT INTO partner_receipt_submissions
         (id, company_id, partner, external_submission_id, external_driver_id,
          driver_id, receipt_date, category, amount, payment_method)
  VALUES ('4c000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
          'reidey', 'ra-legacy', 'ra-1', '4a000000-0000-4000-8000-000000000001',
          '2026-10-07', 'Tanken', 41.47, 'bar');

  PERFORM _ra_as(v_admin);
  -- Flipped with probe 1, and for the same decision.
  PERFORM _ra_rec(11, 'a Beleg with NO PHOTO is accepted',
    _ra_call($q$SELECT partner_receipt_accept('4c000000-0000-4000-8000-000000000001') ->> 'ok'$q$),
    'true');
  PERFORM _ra_reset();

  -- And the receipts row it wrote carries NO document path. That is the whole
  -- of what the reversal costs, stated as an assertion rather than as prose:
  -- a Beleg in the books with nothing behind it but what a driver typed.
  PERFORM _ra_rec(12, 'and its receipts row carries no document path',
    (SELECT count(*)::text FROM receipts WHERE description = 'Tanken'
       AND company_id = 'c0000000-0000-4000-8000-00000000000a'
       AND driver_name = 'Omar Khalil'
       AND document_path IS NULL),
    '1');

  -- An unlinked driver is the other refusal, and it must not be confused with
  -- the first: the repairs are different screens.
  INSERT INTO partner_receipt_submissions
         (id, company_id, partner, external_submission_id, external_driver_id,
          receipt_date, category, amount, document_path)
  VALUES ('4c000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a',
          'reidey', 'ra-nodriver', 'ra-nobody', '2026-10-07', 'Tanken', 10.00,
          'c0000000-0000-4000-8000-00000000000a/partner/ra-nodriver.jpg');

  PERFORM _ra_as(v_admin);
  PERFORM _ra_rec(13, 'and one whose driver is not linked is refused differently',
    _ra_call($q$SELECT partner_receipt_accept('4c000000-0000-4000-8000-000000000002')::text$q$),
    'ERR P0001 driver_not_linked');
  PERFORM _ra_reset();
END $$;

-- ─── 4. the accept: our name, our number ────────────────────────────────────

DO $$
DECLARE
  v_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id      uuid;
  v_receipt uuid;
BEGIN
  SELECT id INTO v_id FROM partner_receipt_submissions WHERE external_submission_id = 'ra-ok';

  PERFORM _ra_as(v_admin);
  PERFORM _ra_rec(14, 'a complete Beleg is accepted',
    _ra_call(format($q$SELECT partner_receipt_accept(%L) ->> 'ok'$q$, v_id)),
    'true');
  PERFORM _ra_reset();

  SELECT receipt_id INTO v_receipt FROM partner_receipt_submissions WHERE id = v_id;

  -- `receipts` has no driver_id at all; every read joins on this text.
  PERFORM _ra_rec(15, 'the receipts row carries OUR driver row''s name, character for character',
    (SELECT driver_name FROM receipts WHERE id = v_receipt),
    'Omar Khalil');

  PERFORM _ra_rec(16, 'the Belegnummer comes from the server counter',
    (SELECT receipt_number FROM receipts WHERE id = v_receipt),
    'BEL-%', true);

  PERFORM _ra_rec(17, 'and the photo''s key is on the Beleg itself',
    (SELECT document_path FROM receipts WHERE id = v_receipt),
    'c0000000-0000-4000-8000-00000000000a/partner/ra-ok.jpg');

  -- `Tanken` in `description` is what the Tankenquote counts; `bar` is what
  -- moves the driver's weekly balance. Both must survive the transfer exactly.
  PERFORM _ra_rec(18, 'the category, the amount and the payment method survive exactly',
    (SELECT description || ' / ' || expense::text || ' / ' || payment_method
       FROM receipts WHERE id = v_receipt),
    'Tanken / 41.47 / bar');

  PERFORM _ra_rec(19, 'and the submission names its Beleg',
    (SELECT status || ' / ' || CASE WHEN receipt_id IS NULL THEN 'null' ELSE 'named' END
       FROM partner_receipt_submissions WHERE id = v_id),
    'accepted / named');

  PERFORM _ra_as(v_admin);
  PERFORM _ra_rec(20, 'accepting it twice is refused',
    _ra_call(format($q$SELECT partner_receipt_accept(%L)::text$q$, v_id)),
    'ERR P0001 already_reviewed');
  PERFORM _ra_reset();

  PERFORM _ra_rec(21, 'so there is exactly one Beleg, not two',
    (SELECT count(*)::text FROM receipts WHERE document_path =
      'c0000000-0000-4000-8000-00000000000a/partner/ra-ok.jpg'),
    '1');
END $$;

-- ─── 5. the reject keeps the record ────────────────────────────────────────

DO $$
DECLARE
  v_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM partner_receipt_submissions WHERE external_submission_id = 'ra-unlinked';

  PERFORM _ra_as(v_admin);
  PERFORM _ra_rec(22, 'a rejection with no reason is refused by name',
    _ra_call(format($q$SELECT partner_receipt_reject(%L, '  ')::text$q$, v_id)),
    'ERR 22023 reason_required');

  PERFORM _ra_rec(23, 'with a reason it is rejected',
    _ra_call(format($q$SELECT partner_receipt_reject(%L, 'Foto unleserlich') ->> 'ok'$q$, v_id)),
    'true');
  PERFORM _ra_reset();

  -- A rejected Beleg is still a record of what was claimed, so the photo stays.
  PERFORM _ra_rec(24, 'the photo stays with the rejected submission',
    (SELECT status || ' / ' || coalesce(rejected_reason, 'null') || ' / '
            || CASE WHEN document_path IS NULL THEN 'gone' ELSE 'kept' END
       FROM partner_receipt_submissions WHERE id = v_id),
    'rejected / Foto unleserlich / kept');

  PERFORM _ra_rec(25, 'and it wrote no Beleg',
    (SELECT coalesce(receipt_id::text, 'null') FROM partner_receipt_submissions WHERE id = v_id),
    'null');
END $$;

-- ─── 6. the shape ──────────────────────────────────────────────────────────

DO $$
DECLARE v_n int;
BEGIN
  PERFORM _ra_rec(26, 'the door is not executable by anon or authenticated',
    (has_function_privilege('anon',
       'public.partner_receipt_submission_record(uuid,text,text,text,date,text,text,text,text,text,text,text,boolean,boolean,jsonb,text,text,text,text,text,text)', 'EXECUTE')::int
     + has_function_privilege('authenticated',
       'public.partner_receipt_submission_record(uuid,text,text,text,date,text,text,text,text,text,text,text,boolean,boolean,jsonb,text,text,text,text,text,text)', 'EXECUTE')::int)::text,
    '0');

  PERFORM _ra_rec(27, 'and the two decisions are not executable by anon',
    (has_function_privilege('anon', 'public.partner_receipt_accept(uuid)', 'EXECUTE')::int
     + has_function_privilege('anon', 'public.partner_receipt_reject(uuid,text)', 'EXECUTE')::int)::text,
    '0');

  -- 20260920100000 refuses a database where a policy names a company bucket
  -- without pinning it, so a partner-specific policy would force restating all
  -- fifteen.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE '%partner%';
  PERFORM _ra_rec(28, 'no partner-specific storage policy was added',
    v_n::text, '0');

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_receipt_submissions'
     AND cmd IN ('INSERT', 'DELETE');
  PERFORM _ra_rec(29, 'the submission table still has no INSERT and no DELETE policy',
    v_n::text, '0');
END $$;

-- ─── 7. the seven fields, and the column behind them ───────────────────────
--
--  Four columns arrived on 11.10.2026 (merchant, time, litres, unit price) and
--  two on 12.10.2026 (the odometer and the range left), on the submission AND
--  on `receipts` — the point being that they reach the Steuerberater, so a
--  figure that stops at the review screen answers nobody. 11.10 shipped with
--  no kit file at all, which is why this section covers both rounds together.
--
--  Probe 33 is the one worth reading twice. The edge function bounds both
--  figures before they ever get here, so this probe asks the OTHER question:
--  with that guard bypassed — which is exactly what a direct RPC call is — does
--  the column still refuse? A rule enforced in one TypeScript function is lost
--  silently by the next writer, and the CHECK is what survives them.

DO $$
DECLARE
  v_co    constant text := 'c0000000-0000-4000-8000-00000000000a';
  v_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id    uuid;
BEGIN
  PERFORM _ra_rec(30, 'a Beleg carrying all seven extra fields is recorded pending',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-seven', 'ra-1',
      '2026-10-07', 'Tanken', NULL, '41.47', 'bar', '10115',
      'c0000000-0000-4000-8000-00000000000a/partner/ra-seven.jpg',
      NULL, true, false, NULL,
      'ARAL Tankstelle', '14:32', '41.47', '1.789', '25382', '277') ->> 'status'$q$, v_co)),
    'pending');

  PERFORM _ra_rec(31, 'and the submission row holds every one of them',
    (SELECT merchant_name || ' / ' || receipt_time::text || ' / ' || litres::text
            || ' / ' || price_per_litre::text || ' / ' || odometer_km::text
            || ' / ' || range_km::text
       FROM partner_receipt_submissions
      WHERE company_id = v_co::uuid AND external_submission_id = 'ra-seven'),
    'ARAL Tankstelle / 14:32:00 / 41.47 / 1.789 / 25382 / 277');

  SELECT id INTO v_id FROM partner_receipt_submissions
   WHERE company_id = v_co::uuid AND external_submission_id = 'ra-seven';

  PERFORM _ra_as(v_admin);
  PERFORM _ra_rec(32, 'accepting it is one transaction and answers ok',
    _ra_call(format($q$SELECT partner_receipt_accept(%L) ->> 'ok'$q$, v_id)), 'true');
  PERFORM _ra_reset();

  -- The whole reason these are columns and not a review-screen detail: the
  -- Beleg the accountant reads has to carry them.
  PERFORM _ra_rec(33, 'and the receipts row carries all seven, not just the amount',
    (SELECT r.merchant_name || ' / ' || r.receipt_time::text || ' / ' || r.litres::text
            || ' / ' || r.price_per_litre::text || ' / ' || r.odometer_km::text
            || ' / ' || r.range_km::text
       FROM receipts r
       JOIN partner_receipt_submissions s ON s.receipt_id = r.id
      WHERE s.id = v_id),
    'ARAL Tankstelle / 14:32:00 / 41.47 / 1.789 / 25382 / 277');

  -- With the edge function's bound bypassed, the column is the wall. 100 is
  -- the floor and 10000000 the ceiling (20261012100000); a three-digit value
  -- is the range or a trip meter, the exact confusion the app's rule refuses.
  PERFORM _ra_rec(34, 'an odometer under the floor is refused by the column itself',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-odo-low', 'ra-1',
      '2026-10-07', 'Tanken', NULL, '41.47', 'bar', NULL, NULL,
      NULL, true, false, NULL, NULL, NULL, NULL, NULL, '99', NULL)::text$q$, v_co)),
    'ERR 23514%', true);

  PERFORM _ra_rec(35, 'and a range no car holds, likewise',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-range-high', 'ra-1',
      '2026-10-07', 'Tanken', NULL, '41.47', 'bar', NULL, NULL,
      NULL, true, false, NULL, NULL, NULL, NULL, NULL, '25382', '9000')::text$q$, v_co)),
    'ERR 23514%', true);

  -- Zero is a real reading - a car driven to empty shows it - and a `> 0`
  -- bound copied from the litres would have refused exactly that case.
  PERFORM _ra_rec(36, 'a range of zero is a reading, not an error',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-range-zero', 'ra-1',
      '2026-10-07', 'Tanken', NULL, '41.47', 'bar', NULL, NULL,
      NULL, true, false, NULL, NULL, NULL, NULL, NULL, '25382', '0') ->> 'status'$q$, v_co)),
    'pending');

  -- A Beleg that is not a refuel has neither, and an app build older than
  -- 12.10.2026 sends neither on any Beleg: a NOT NULL would refuse both.
  PERFORM _ra_rec(37, 'a Beleg with neither figure is recorded, not refused',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-nofuel', 'ra-1',
      '2026-10-07', 'Autowäsche', NULL, '60.00') ->> 'status'$q$, v_co)),
    'pending');

  PERFORM _ra_rec(38, 'and both read NULL rather than zero',
    (SELECT coalesce(odometer_km::text, 'null') || ' / ' || coalesce(range_km::text, 'null')
       FROM partner_receipt_submissions
      WHERE company_id = v_co::uuid AND external_submission_id = 'ra-nofuel'),
    'null / null');
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_bad, v_all FROM _ra_out;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'partner receipt accept: % of % probe(s) did not match — read the XX lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '── partner receipt accept: all % probes matched ──', v_all;
END $$;

ROLLBACK;
