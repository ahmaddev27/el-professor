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

--  13.10.2026 (20261013100000): there is no review. A Beleg from a LINKED driver
--  is a receipts row the moment the door records it, with nobody accepting it;
--  one from a driver nobody has linked is recorded and waits for the link. The
--  probes below measure that. The review functions are gone (20261013110000
--  dropped them), and section 2 asserts that they stay gone - a removal nobody
--  asserts comes back the next time someone copies an old migration. The
--  probes that exercised them (a viewer refused, an applied Beleg refused, a
--  rejection keeping the photo) are gone with them; probe numbers are not
--  reused, so a gap is a probe that retired.

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
    'accepted');

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

  PERFORM _ra_rec(5, 'a complete Beleg arrives with the driver resolved from our link',
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

-- ─── 2. the review functions are gone ──────────────────────────────────────

DO $$
BEGIN
  -- Counted in the catalogue, never through has_function_privilege: that
  -- raises on a function that does not exist, which would turn this probe into
  -- an error instead of an answer.
  PERFORM _ra_rec(9, 'partner_receipt_accept no longer exists',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_accept'),
    '0');
  PERFORM _ra_rec(10, 'nor does partner_receipt_reject',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_reject'),
    '0');
END $$;

-- ─── 3. the arrival writes the Beleg; an unlinked driver waits ─────────────

DO $$
BEGIN
  -- Flipped on 10.10.2026 for the door; the same decision reaches the Beleg.
  -- The receipts row carries NO document path - a Beleg in the books with
  -- nothing behind it but what the driver's app read and he confirmed.
  PERFORM _ra_rec(11, 'a documentless Beleg from a linked driver became a Beleg on arrival',
    (SELECT count(*)::text FROM receipts WHERE description = 'Tanken'
       AND company_id = 'c0000000-0000-4000-8000-00000000000a'
       AND driver_name = 'Omar Khalil'
       AND document_path IS NULL),
    '1');

  PERFORM _ra_rec(12, 'and its submission names it, with nobody having reviewed it',
    (SELECT status || ' / ' || CASE WHEN receipt_id IS NULL THEN 'null' ELSE 'named' END
            || ' / ' || coalesce(reviewed_by::text, 'no reviewer')
       FROM partner_receipt_submissions WHERE external_submission_id = 'ra-nodoc'),
    'accepted / named / no reviewer');

  -- The edge. A Beleg belongs to a driver by NAME, an unlinked partner driver
  -- has none, and linking is a human act. Recorded, not applied.
  PERFORM _ra_rec(13, 'a Beleg whose driver is not linked is recorded and NOT applied',
    (SELECT status || ' / ' || CASE WHEN receipt_id IS NULL THEN 'no Beleg' ELSE 'named' END
       FROM partner_receipt_submissions WHERE external_submission_id = 'ra-unlinked'),
    'pending / no Beleg');
END $$;

-- ─── 4. the arrival: our name, our number, our author ──────────────────────

DO $$
DECLARE
  v_id      uuid;
  v_receipt uuid;
BEGIN
  SELECT id, receipt_id INTO v_id, v_receipt
    FROM partner_receipt_submissions WHERE external_submission_id = 'ra-ok';

  PERFORM _ra_rec(14, 'a complete Beleg is a Beleg the moment it is recorded',
    CASE WHEN v_receipt IS NULL THEN 'no Beleg' ELSE 'Beleg' END, 'Beleg');

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

  PERFORM _ra_rec(19, 'and the submission is accepted and names its Beleg',
    (SELECT status || ' / ' || CASE WHEN receipt_id IS NULL THEN 'null' ELSE 'named' END
       FROM partner_receipt_submissions WHERE id = v_id),
    'accepted / named');

  -- probe 6 retried this very submission at the door.
  PERFORM _ra_rec(21, 'so there is exactly one Beleg, not two, after the retry',
    (SELECT count(*)::text FROM receipts WHERE document_path =
      'c0000000-0000-4000-8000-00000000000a/partner/ra-ok.jpg'),
    '1');

  -- The owner's ask of 13.10.2026: "Created by" is the driver. There is no
  -- user behind a driver, so both user columns are NULL and the name travels
  -- in its own column, OUR row's name.
  PERFORM _ra_rec(39, 'the author is the driver''s name, with no user behind it',
    (SELECT coalesce(user_id::text, 'no user') || ' / ' || coalesce(created_by, 'no user')
            || ' / ' || coalesce(submitted_by_name, 'null')
       FROM receipts WHERE id = v_receipt),
    'no user / no user / Omar Khalil');

  PERFORM _ra_rec(40, 'two arrivals drew two different Belegnummern',
    (SELECT count(DISTINCT receipt_number)::text FROM receipts
      WHERE company_id = 'c0000000-0000-4000-8000-00000000000a'
        AND submitted_by_name = 'Omar Khalil'),
    (SELECT count(*)::text FROM receipts
      WHERE company_id = 'c0000000-0000-4000-8000-00000000000a'
        AND submitted_by_name = 'Omar Khalil'));
END $$;

-- ─── 6. the shape ──────────────────────────────────────────────────────────

DO $$
DECLARE v_n int;
BEGIN
  PERFORM _ra_rec(26, 'the door is not executable by anon or authenticated',
    (has_function_privilege('anon',
       'public.partner_receipt_submission_record(uuid,text,text,text,date,text,text,text,text,text,text,text,boolean,boolean,jsonb,text,text,text,text,text,text,text,text,text,text,text,text)', 'EXECUTE')::int
     + has_function_privilege('authenticated',
       'public.partner_receipt_submission_record(uuid,text,text,text,date,text,text,text,text,text,text,text,boolean,boolean,jsonb,text,text,text,text,text,text,text,text,text,text,text,text)', 'EXECUTE')::int)::text,
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
--  And probes 31 and 33 are why that matters. The `city` column had existed
--  since 20261005140000 with NO WRITER AT ALL: the door parsed it, Reidey sent
--  it, and the accept copied `v_row.city` into `receipts` in good faith - a
--  column that was always NULL. Nothing failed, nothing logged, and the field
--  the owner asked for on 11.10 stopped at the review screen's own table.
--  20261012100000 appends `p_city`; these two probes are what would have
--  caught it, which is the argument for a kit file per round.
--
--  Probe 33 is the one worth reading twice. The edge function bounds both
--  figures before they ever get here, so this probe asks the OTHER question:
--  with that guard bypassed — which is exactly what a direct RPC call is — does
--  the column still refuse? A rule enforced in one TypeScript function is lost
--  silently by the next writer, and the CHECK is what survives them.

DO $$
DECLARE
  v_co    constant text := 'c0000000-0000-4000-8000-00000000000a';
  v_id    uuid;
BEGIN
  PERFORM _ra_rec(30, 'a Beleg carrying all eight extra fields is recorded and accepted',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-seven', 'ra-1',
      '2026-10-07', 'Tanken', NULL, '41.47', 'bar', '10115',
      'c0000000-0000-4000-8000-00000000000a/partner/ra-seven.jpg',
      NULL, true, false, NULL,
      'ARAL Tankstelle', '14:32', '41.47', '1.789', '25382', '277', 'Berlin') ->> 'status'$q$, v_co)),
    'accepted');

  PERFORM _ra_rec(31, 'and the submission row holds every one of them',
    (SELECT merchant_name || ' / ' || receipt_time::text || ' / ' || litres::text
            || ' / ' || price_per_litre::text || ' / ' || odometer_km::text
            || ' / ' || range_km::text || ' / ' || city
       FROM partner_receipt_submissions
      WHERE company_id = v_co::uuid AND external_submission_id = 'ra-seven'),
    'ARAL Tankstelle / 14:32:00 / 41.47 / 1.789 / 25382 / 277 / Berlin');

  SELECT id INTO v_id FROM partner_receipt_submissions
   WHERE company_id = v_co::uuid AND external_submission_id = 'ra-seven';

  PERFORM _ra_rec(32, 'it is applied in the same transaction as the arrival',
    (SELECT status FROM partner_receipt_submissions WHERE id = v_id), 'accepted');

  -- The whole reason these are columns and not a review-screen detail: the
  -- Beleg the accountant reads has to carry them.
  PERFORM _ra_rec(33, 'and the receipts row carries all eight, the city included',
    (SELECT r.merchant_name || ' / ' || r.receipt_time::text || ' / ' || r.litres::text
            || ' / ' || r.price_per_litre::text || ' / ' || r.odometer_km::text
            || ' / ' || r.range_km::text || ' / ' || r.city
       FROM receipts r
       JOIN partner_receipt_submissions s ON s.receipt_id = r.id
      WHERE s.id = v_id),
    'ARAL Tankstelle / 14:32:00 / 41.47 / 1.789 / 25382 / 277 / Berlin');

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
    'accepted');

  -- A Beleg that is not a refuel has neither, and an app build older than
  -- 12.10.2026 sends neither on any Beleg: a NOT NULL would refuse both.
  PERFORM _ra_rec(37, 'a Beleg with neither figure is recorded, not refused',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-nofuel', 'ra-1',
      '2026-10-07', 'Autowäsche', NULL, '60.00') ->> 'status'$q$, v_co)),
    'accepted');

  PERFORM _ra_rec(38, 'and both read NULL rather than zero',
    (SELECT coalesce(odometer_km::text, 'null') || ' / ' || coalesce(range_km::text, 'null')
       FROM partner_receipt_submissions
      WHERE company_id = v_co::uuid AND external_submission_id = 'ra-nofuel'),
    'null / null');
END $$;

-- ─── 8. the letterhead split, the printed Bon and the TSE clock ─────────────
--
--  Five more on 27.10.2026 (20261027150000), read off a real JET Hagen receipt
--  by the shared parser: the station, the operator, the street, the number the
--  till itself printed (90521, beside `Bon`) and the TSE clock. Probe 44 is
--  the one that keeps the two numbers apart: the Belegnummer stays the server
--  draw, whatever digits the paper carries.

DO $$
DECLARE
  v_co constant text := 'c0000000-0000-4000-8000-00000000000a';
  v_id uuid;
BEGIN
  PERFORM _ra_rec(41, 'a Beleg carrying the five header fields is recorded and accepted',
    _ra_call(format($q$SELECT partner_receipt_submission_record(%L, 'reidey', 'ra-jet', 'ra-1',
      '2026-10-20', 'Tanken', NULL, '41.08', 'bar', '58089', NULL,
      NULL, true, false, NULL,
      'JET Tankstelle Detlev Wüstenfelder', '08:45', '19.95', '2.059', '25382', '277', 'Hagen',
      'JET Tankstelle', 'Detlev Wüstenfelder', 'Eckeseyer Straße 113-115', '90521', '08:46:19') ->> 'status'$q$, v_co)),
    'accepted');

  SELECT id INTO v_id FROM partner_receipt_submissions
   WHERE company_id = v_co::uuid AND external_submission_id = 'ra-jet';

  PERFORM _ra_rec(42, 'the submission row holds all five',
    (SELECT station_name || ' / ' || operator_name || ' / ' || street || ' / '
            || printed_receipt_number || ' / ' || tse_time::text
       FROM partner_receipt_submissions WHERE id = v_id),
    'JET Tankstelle / Detlev Wüstenfelder / Eckeseyer Straße 113-115 / 90521 / 08:46:19');

  PERFORM _ra_rec(43, 'and the receipts row carries all five',
    (SELECT r.station_name || ' / ' || r.operator_name || ' / ' || r.street || ' / '
            || r.printed_receipt_number || ' / ' || r.tse_time::text
       FROM receipts r JOIN partner_receipt_submissions s ON s.receipt_id = r.id
      WHERE s.id = v_id),
    'JET Tankstelle / Detlev Wüstenfelder / Eckeseyer Straße 113-115 / 90521 / 08:46:19');

  PERFORM _ra_rec(44, 'the Belegnummer stays the server draw, not the printed number',
    (SELECT CASE WHEN r.receipt_number LIKE 'BEL-%' AND r.receipt_number <> r.printed_receipt_number
                 THEN 'server draw' ELSE r.receipt_number END
       FROM receipts r JOIN partner_receipt_submissions s ON s.receipt_id = r.id
      WHERE s.id = v_id),
    'server draw');

  -- An older app's call names none of the five; appended-with-defaults is what
  -- keeps that call valid, and NULL — not '' — is what the columns read.
  PERFORM _ra_rec(45, 'an older build''s call leaves all five NULL',
    (SELECT coalesce(station_name, 'null') || ' / ' || coalesce(operator_name, 'null') || ' / '
            || coalesce(street, 'null') || ' / ' || coalesce(printed_receipt_number, 'null')
            || ' / ' || coalesce(tse_time::text, 'null')
       FROM partner_receipt_submissions
      WHERE company_id = v_co::uuid AND external_submission_id = 'ra-nofuel'),
    'null / null / null / null / null');
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
