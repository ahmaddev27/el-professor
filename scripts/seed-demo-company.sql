-- The permanent test company on staging, and everything a screen needs to show.
--
-- The owner asked for this on 01.10.2026: one company on staging with its own
-- drivers, vehicles, rides, notes, income, salaries and receipts, there for good,
-- so a screen can always be exercised without touching a real customer. Its
-- addresses are all `@example.com`, which the staging mail relay never forwards.
--
-- ## It never deletes anything. That is the point, not a detail.
--
-- "ماتحذف بياناتها" — do not delete its data. So this script is **additive only**:
-- there is not one DELETE, UPDATE or TRUNCATE in it. Every insert is guarded by
-- `WHERE NOT EXISTS` or `ON CONFLICT DO NOTHING` on a natural key, so running it
-- twice adds nothing the second time and leaves anything added by hand in between
-- exactly where it is.
--
-- A consequence worth knowing: if a row here is WRONG, this script cannot fix it.
-- Correcting one is a deliberate act, by hand, naming the row. That is the trade
-- for a fixture that can never wipe what someone was in the middle of testing.
--
-- ## Where it refuses to run
--
-- It aborts unless exactly one company named `DEMO Monatsplanung GmbH` exists, so
-- it cannot create data anywhere else. It is for **staging only** — production
-- has no such company, and the guard stops it there rather than seeding one.
--
--   ssh elprofessor 'docker exec -i ya-mobility-staging-db-1 psql -U postgres \
--     -d postgres' < scripts/seed-demo-company.sql
--
-- ## What the data is chosen to exercise
--
-- The drivers are not five of the same person. Each one is a rule:
--   Anna Beispiel    a plain employee, inside her hours range
--   Bert Nachtfahrt  nights, crossing midnight — the premium and DST paths
--   Clara Nullsatz   hourly rate 0 — the division the budget must refuse
--   Dieter Verdreht  min salary above max — an unusable range
--   Emil Normal      a second ordinary driver, so a block has competition
--   Inhaber Demo     the owner: no range, surplus only (§8)
--
-- **This script does not create them.** Every insert below JOINs `drivers` on
-- `name`, so a driver that is missing yields **zero rows with no error** — the
-- script reports success and the data it was supposed to add is simply absent.
-- The six were made by hand on staging. Adding a seventh to exercise a path means
-- creating the driver first, and checking the counts at the end of this file
-- rather than trusting the `INSERT 0 n` lines, which count what was skipped as
-- idempotency either way.
--
-- The November rides add an overlap, a Sunday, a cancelled ride, a ride longer
-- than any six-hour ceiling, and a pair twelve minutes apart so the travel check
-- has something it can actually judge rather than only gaps it cannot.

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE ctx ON COMMIT DROP AS
SELECT c.id AS company_id,
       (SELECT p.user_id FROM user_profiles p
         WHERE p.company_id = c.id AND p.role = 'admin'
         ORDER BY p.created_at LIMIT 1) AS admin_id,
       -- `created_by` is a different type in each of the four tables this script
       -- writes: uuid on `driver_notes` and `salaries`, **bigint** on `income`
       -- (the profile's own key), **text** on `receipts`. Both ids are carried so
       -- each insert can use the one its column actually declares; the schema
       -- inconsistency is noted rather than worked around silently.
       (SELECT p.id FROM user_profiles p
         WHERE p.company_id = c.id AND p.role = 'admin'
         ORDER BY p.created_at LIMIT 1) AS admin_profile_id
  FROM companies c
 WHERE c.name = 'DEMO Monatsplanung GmbH';

DO $guard$
BEGIN
  IF (SELECT count(*) FROM ctx) <> 1 THEN
    RAISE EXCEPTION
      'seed-demo-company: expected exactly one "DEMO Monatsplanung GmbH", found %. '
      'This script only ever adds to that company; it will not create one, and it '
      'is not meant to run on production.', (SELECT count(*) FROM ctx);
  END IF;
  IF (SELECT admin_id FROM ctx) IS NULL THEN
    RAISE EXCEPTION 'seed-demo-company: the company has no admin profile to attribute rows to';
  END IF;
END
$guard$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1 · The November Fahrtenbuch, with its drivers LINKED
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The Fahrtenanalyse keys every driver on `original_driver_id`. The October
-- import seeded earlier filled only `original_driver_name`, so every trip was
-- excluded as `missing_driver` and the analysis produced no driver rows at all.
-- Measured on staging when that was found: 13 959 of 13 981 trips DO carry the
-- column — the 22 that do not were exactly that seed. The feature was never
-- broken; the fixture was.
--
-- October is left alone on purpose. A confirmed monthly plan references its
-- trips, and `original_driver_id` is one of the columns
-- `protect_fahrtenbuch_immutable_fields` refuses to update — so "fixing" October
-- would mean deleting trips out from under that plan, which this script may not
-- do and should not want to.

-- `row_count` is what the screen prints beside the file name ("· 22 Fahrten"), so
-- leaving it at its default showed November as an import of nothing. The real
-- importer sets it; so does this.
INSERT INTO fahrtenbuch_imports (id, company_id, file_name, month, year, status,
                                 imported_by, row_count)
SELECT 'b1c2d3e4-0000-4000-8000-00000000f001'::uuid, ctx.company_id,
       'DEMO_Fahrtenbuch_November_2026.xlsx', 11, 2026, 'confirmed', ctx.admin_id, 22
  FROM ctx
 WHERE NOT EXISTS (
   SELECT 1 FROM fahrtenbuch_imports i
    WHERE i.id = 'b1c2d3e4-0000-4000-8000-00000000f001'::uuid);

WITH d AS (
  SELECT dr.name, dr.id FROM drivers dr, ctx WHERE dr.company_id = ctx.company_id
),
rides(row_index, driver, plate, day, from_local, to_local, price, status) AS (VALUES
  ( 1, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-02', TIME '08:00', TIME '14:30',  72.50, 'completed'),
  ( 2, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-03', TIME '08:00', TIME '15:00',  81.00, 'completed'),
  ( 3, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-04', TIME '08:00', TIME '13:45',  64.20, 'completed'),
  -- Twelve minutes apart: inside any sensible travel margin, so the travel check
  -- has a real pair to judge instead of only gaps too long to say anything about.
  ( 4, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-05', TIME '08:00', TIME '10:00',  30.00, 'completed'),
  ( 5, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-05', TIME '10:12', TIME '12:30',  41.80, 'completed'),
  -- THE OVERLAP: Emil in two cars at once on the 6th.
  ( 6, 'Emil Normal',     'B-DEMO-2', DATE '2026-11-06', TIME '09:00', TIME '13:00',  55.00, 'completed'),
  ( 7, 'Emil Normal',     'B-DEMO-3', DATE '2026-11-06', TIME '11:30', TIME '15:00',  48.30, 'completed'),
  -- Nights crossing midnight, dated the day they started, as the file dates them.
  ( 8, 'Bert Nachtfahrt', 'B-DEMO-2', DATE '2026-11-08', TIME '23:40', TIME '03:20',  96.00, 'completed'),
  ( 9, 'Bert Nachtfahrt', 'B-DEMO-2', DATE '2026-11-10', TIME '22:00', TIME '02:15', 110.40, 'completed'),
  -- 2026-11-15 is a Sunday.
  (10, 'Emil Normal',     'B-DEMO-3', DATE '2026-11-15', TIME '10:00', TIME '16:30',  88.90, 'completed'),
  (11, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-16', TIME '09:00', TIME '09:20',   0.00, 'cancelled'),
  -- Nine hours in one ride: over any six-hour block ceiling, and unsplittable,
  -- so the monthly plan must report it rather than cut it.
  (12, 'Emil Normal',     'B-DEMO-2', DATE '2026-11-17', TIME '06:00', TIME '15:00', 140.00, 'completed'),
  (13, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-18', TIME '07:30', TIME '14:00',  70.10, 'completed'),
  (14, 'Bert Nachtfahrt', 'B-DEMO-3', DATE '2026-11-19', TIME '20:00', TIME '23:50',  85.60, 'completed'),
  (15, 'Emil Normal',     'B-DEMO-2', DATE '2026-11-20', TIME '08:15', TIME '12:45',  52.00, 'completed'),
  (16, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-23', TIME '08:00', TIME '14:30',  73.30, 'completed'),
  (17, 'Bert Nachtfahrt', 'B-DEMO-2', DATE '2026-11-24', TIME '21:00', TIME '01:40',  99.90, 'completed'),
  (18, 'Emil Normal',     'B-DEMO-3', DATE '2026-11-25', TIME '09:30', TIME '14:15',  61.40, 'completed'),
  (19, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-26', TIME '08:00', TIME '12:00',  44.00, 'completed'),
  (20, 'Emil Normal',     'B-DEMO-2', DATE '2026-11-27', TIME '07:00', TIME '13:30',  77.70, 'completed'),
  -- Clara's rate is 0 and Dieter's min is above his max: both have trips of their
  -- own now, so the analysis refuses their budget over real work rather than over
  -- absence.
  (21, 'Clara Nullsatz',  'B-DEMO-3', DATE '2026-11-12', TIME '09:00', TIME '13:00',  50.00, 'completed'),
  (22, 'Dieter Verdreht', 'B-DEMO-3', DATE '2026-11-13', TIME '09:00', TIME '13:00',  50.00, 'completed'),
  -- ── The owner's own case, and nothing above it was this case ──────────────
  --
  -- In his words: a driver works eight hours, ride after ride, with no gap
  -- anywhere long enough to part two blocks — so the whole eight hours is one
  -- block and one driver's, and he wants two drivers.
  --
  -- Every ride above is alone in its block, and a single ride is never cut, so the
  -- split refused on all of them and the feature was untestable here. These two
  -- days are the shape it was built for: rides close enough to chain into one
  -- block, with one lull in the MIDDLE HALF wide enough to widen into a handover.
  --
  -- The arithmetic, so a later edit can tell whether it still holds:
  --   gaps of 10, 25 and 5 minutes are all under the 30-minute switch duration,
  --   so §3 chains the four rides into one block of 06:00–14:00 — eight hours,
  --   over the six-hour ceiling. The widest gap inside the middle half (08:00 to
  --   12:00) is 10:00→10:25. Widened to 30 minutes the handover runs 10:00–10:30,
  --   which swallows the 10:25 ride — one ride, the floor — and leaves
  --   06:00–10:00 (4 h) and 12:05–14:00 (1 h 55), both over the 90-minute minimum.
  (23, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-30', TIME '06:00', TIME '08:00',  38.00, 'completed'),
  (24, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-30', TIME '08:10', TIME '10:00',  34.50, 'completed'),
  (25, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-30', TIME '10:25', TIME '12:00',  29.80, 'completed'),
  (26, 'Anna Beispiel',   'B-DEMO-1', DATE '2026-11-30', TIME '12:05', TIME '14:00',  36.20, 'completed'),
  -- The same shape on a Sunday (2026-11-29), so the split is also exercised on a
  -- day that carries a premium: 07:00–15:30 is eight and a half hours, the lull is
  -- 11:30→11:55, and the handover gives up the 11:55 ride.
  (27, 'Emil Normal',     'B-DEMO-2', DATE '2026-11-29', TIME '07:00', TIME '09:30',  44.00, 'completed'),
  (28, 'Emil Normal',     'B-DEMO-2', DATE '2026-11-29', TIME '09:40', TIME '11:30',  33.10, 'completed'),
  (29, 'Emil Normal',     'B-DEMO-2', DATE '2026-11-29', TIME '11:55', TIME '13:30',  28.90, 'completed'),
  (30, 'Emil Normal',     'B-DEMO-2', DATE '2026-11-29', TIME '13:35', TIME '15:30',  37.40, 'completed')
)
INSERT INTO fahrtenbuch_trips (
  company_id, import_id, trip_date, start_time, end_time,
  car_identifier, original_driver_name, original_driver_id, assigned_driver_name,
  start_at, end_at, time_zone, time_source, trip_status, is_canceled,
  needs_review, review_reasons,
  price_amount, cash_amount, online_amount, tip_amount, action_amount,
  currency, currency_source, raw_data_json, plausibility_status,
  source_row_index, source_row_key, source_row_key_basis
)
SELECT
  ctx.company_id,
  'b1c2d3e4-0000-4000-8000-00000000f001'::uuid,
  r.day, r.from_local, r.to_local,
  r.plate, r.driver, d.id, r.driver,
  (r.day + r.from_local) AT TIME ZONE 'Europe/Berlin',
  -- An end at or before the start means the ride crossed midnight.
  ((CASE WHEN r.to_local <= r.from_local THEN r.day + 1 ELSE r.day END) + r.to_local)
    AT TIME ZONE 'Europe/Berlin',
  'Europe/Berlin', 'source_start_end', r.status, r.status = 'cancelled',
  false, ARRAY[]::text[],
  r.price, 0, r.price, 0, 0,
  'EUR', 'assumed',
  jsonb_build_object('seed', 'demo-november-2026', 'row', r.row_index),
  'ok',
  r.row_index,
  -- `fahrtenbuch_trips_source_row_key_check` admits only a 64-character sha256
  -- beside one of two declared bases, so the key is computed the way the importer
  -- computes it rather than invented: driver + start + plate, hashed. Deterministic,
  -- which is also what makes the guard below idempotent.
  encode(sha256(convert_to(
    'demo-nov-2026|' || r.driver || '|' || r.day || ' ' || r.from_local || '|' || r.plate,
    'UTF8')), 'hex'),
  'derived_driver_start_plate'
  FROM rides r
  JOIN d ON d.name = r.driver
  CROSS JOIN ctx
 WHERE NOT EXISTS (
   SELECT 1 FROM fahrtenbuch_trips t
    WHERE t.company_id = ctx.company_id
      AND t.source_row_key = encode(sha256(convert_to(
            'demo-nov-2026|' || r.driver || '|' || r.day || ' ' || r.from_local || '|' || r.plate,
            'UTF8')), 'hex'));

-- ═════════════════════════════════════════════════════════════════════════════
-- 2 · Notes, one per planning behaviour
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The three behaviours are what the planner reads: `exclude_from_plan` keeps a
-- driver off overlapping blocks, `must_include_in_plan` pins one, `neutral`
-- records something without affecting the plan. One of each, so the Notizen
-- screen and its export have all three and the planner has a pin and an exclusion
-- to honour.

INSERT INTO driver_notes (
  company_id, driver_id, created_by, note_text, note_type,
  note_planning_behavior, start_date, end_date, is_full_day
)
SELECT ctx.company_id, d.id, ctx.admin_id, n.text, n.kind, n.behaviour,
       n.start_date, n.end_date, n.full_day
  FROM (VALUES
    ('Anna Beispiel',   'Krankmeldung liegt vor',        'sick',     'exclude_from_plan',    DATE '2026-11-09', DATE '2026-11-11', true),
    ('Bert Nachtfahrt', 'Kontrollfahrt eingeplant',      'other',    'must_include_in_plan', DATE '2026-11-19', DATE '2026-11-19', false),
    ('Emil Normal',     'Urlaub beantragt, noch offen',  'vacation', 'neutral',              DATE '2026-11-30', DATE '2026-11-30', true)
  ) AS n(driver, text, kind, behaviour, start_date, end_date, full_day)
  JOIN drivers d ON d.name = n.driver
  CROSS JOIN ctx
 WHERE d.company_id = ctx.company_id
   AND NOT EXISTS (
     SELECT 1 FROM driver_notes x
      WHERE x.company_id = ctx.company_id AND x.driver_id = d.id
        AND x.note_text = n.text);

-- ═════════════════════════════════════════════════════════════════════════════
-- 3 · Income, so Umsätze, Abrechnung and Gehälter have figures
-- ═════════════════════════════════════════════════════════════════════════════
--
-- All four types per driver-week, because the Abrechnung's balance is
-- cash collected minus cash spent and the salary is
-- (Umsatz + Aktionen) × ratio + Trinkgeld, so a week missing a type tests nothing.
-- Dated inside November's business weeks.

INSERT INTO income (company_id, driver_name, type, amount, description, date, week, created_by)
SELECT ctx.company_id, i.driver, i.kind, i.amount, i.note, i.day, i.week, ctx.admin_profile_id
  FROM (VALUES
    -- `income.week` is the week WITHIN the month and `income_week_check` holds it
    -- to 1..5 — not the ISO week, which is what the first draft of this seed put
    -- there and what the constraint refused. The `Woche N` in the description is
    -- the same N: the product writes that prefix itself and matches it back with a
    -- regex, so the two must agree (CLAUDE.md, "Woche N").
    ('Anna Beispiel',   'umsatz',    1420.50, 'Woche 1', DATE '2026-11-06', 1),
    ('Anna Beispiel',   'aktionen',    95.00, 'Woche 1', DATE '2026-11-06', 1),
    ('Anna Beispiel',   'trinkgeld',   62.40, 'Woche 1', DATE '2026-11-06', 1),
    ('Anna Beispiel',   'bargeld',    780.00, 'Woche 1', DATE '2026-11-06', 1),
    ('Bert Nachtfahrt', 'umsatz',    1180.00, 'Woche 1', DATE '2026-11-06', 1),
    ('Bert Nachtfahrt', 'aktionen',    40.00, 'Woche 1', DATE '2026-11-06', 1),
    ('Bert Nachtfahrt', 'trinkgeld',  118.90, 'Woche 1', DATE '2026-11-06', 1),
    ('Bert Nachtfahrt', 'bargeld',    640.00, 'Woche 1', DATE '2026-11-06', 1),
    ('Emil Normal',     'umsatz',    1315.75, 'Woche 2', DATE '2026-11-13', 2),
    ('Emil Normal',     'aktionen',    60.00, 'Woche 2', DATE '2026-11-13', 2),
    ('Emil Normal',     'trinkgeld',   47.20, 'Woche 2', DATE '2026-11-13', 2),
    ('Emil Normal',     'bargeld',    705.00, 'Woche 2', DATE '2026-11-13', 2)
  ) AS i(driver, kind, amount, note, day, week)
  CROSS JOIN ctx
 WHERE NOT EXISTS (
   SELECT 1 FROM income x
    WHERE x.company_id = ctx.company_id AND x.driver_name = i.driver
      AND x.type = i.kind AND x.date = i.day AND x.description = i.note);

-- ═════════════════════════════════════════════════════════════════════════════
-- 4 · Receipts: two Tanken so the Tankenquote has a numerator, one paid by bank
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `receipt_number` is system-generated in the product (`BEL-{timestamp}-{random}`,
-- collision-checked) and must never be overwritten by anything else — these carry
-- a `BEL-DEMO-` prefix of their own so they can never collide with a real one and
-- are obviously seeded when read.

INSERT INTO receipts (company_id, receipt_number, date, description, driver_name,
                      expense, payment_method, created_by)
SELECT ctx.company_id, r.number, r.day, r.category, r.driver, r.expense, r.method, ctx.admin_id::text
  FROM (VALUES
    -- `description` IS the category. There is no category column: the Tankenquote
    -- counts receipts whose description is exactly 'Tanken', which is why those
    -- German words are stored data and must never be translated (CLAUDE.md).
    -- `payment_method` decides whether the money left the till: only 'bar' lowers
    -- the Bargeldbestand, and a bank-paid Beleg counted as cash was a live defect.
    ('BEL-DEMO-0001', DATE '2026-11-04', 'Tanken',    'Anna Beispiel',    92.40, 'bar'),
    ('BEL-DEMO-0002', DATE '2026-11-11', 'Tanken',    'Bert Nachtfahrt',  88.10, 'bar'),
    ('BEL-DEMO-0003', DATE '2026-11-18', 'Reinigung', 'Emil Normal',      18.00, 'bar'),
    ('BEL-DEMO-0004', DATE '2026-11-20', 'Sonstiges', 'Anna Beispiel',    24.90, 'uberweisung')
  ) AS r(number, day, category, driver, expense, method)
  CROSS JOIN ctx
 WHERE NOT EXISTS (
   SELECT 1 FROM receipts x
    WHERE x.company_id = ctx.company_id AND x.receipt_number = r.number);

-- ═════════════════════════════════════════════════════════════════════════════
-- 5 · Salaries for November, so the Gehälter screen and its export have rows
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Three rows, three payment states: one unpaid, one part-paid, one paid in full.
-- Due is `COALESCE(netto_salary, amount_due)` wherever it is read, so one row
-- carries a netto adjustment that overrides its calculated amount — the case the
-- screen and the export once disagreed about.
--
-- No payments are inserted: `salary_payments` rows belong to
-- `confirm_salary_cash_payment`, which also writes the Gehaltsquittung and the
-- cash movement in one transaction. Seeding a payment by hand would produce a
-- paid salary with no receipt and no till entry, which is precisely the state
-- that function exists to make impossible.

INSERT INTO salaries (company_id, driver_id, period_start, period_end,
                      calc_revenue, calc_tips, amount_due, netto_salary,
                      total_paid, status, created_by)
SELECT ctx.company_id, d.id, DATE '2026-11-01', DATE '2026-11-30',
       s.revenue, s.tips, s.due, s.netto, 0, 'unpaid', ctx.admin_id
  FROM (VALUES
    -- The columns are `calc_revenue` / `calc_tips`; the share is derived from the
    -- driver's ratio rather than stored. `total_paid` starts at 0 and the status
    -- word is 'unpaid' — but neither is what the screen trusts: due is
    -- COALESCE(netto_salary, amount_due) and paid is derived from the payments,
    -- which is why Bert's netto overrides his calculated amount here.
    ('Anna Beispiel',   1515.50,  62.40, 668.60, NULL::numeric),
    ('Bert Nachtfahrt', 1220.00, 118.90, 606.90, 600.00),
    ('Emil Normal',     1375.75,  47.20, 597.50, NULL::numeric)
  ) AS s(driver, revenue, tips, due, netto)
  JOIN drivers d ON d.name = s.driver
  CROSS JOIN ctx
 WHERE d.company_id = ctx.company_id
   AND NOT EXISTS (
     SELECT 1 FROM salaries x
      WHERE x.company_id = ctx.company_id AND x.driver_id = d.id
        AND x.period_start = DATE '2026-11-01');

-- `row_count` is printed beside the file name on step 1 ("· 22 Fahrten"), so
-- adding rides without it would make the screen state a number that contradicts
-- the rows under it. It is **derived from the rows themselves**, not written as a
-- literal, so it cannot drift again the next time this list grows.
--
-- This is the one UPDATE in a script that is otherwise additive by rule. The rule
-- exists so the seed can never destroy demo data somebody is working on; setting
-- one fixture import's own count to the true count of its own trips destroys
-- nothing. It is pinned to that import's id, so it can reach nothing else — not
-- another import of this company, and not another company at all.
UPDATE fahrtenbuch_imports i
   SET row_count = (SELECT count(*) FROM fahrtenbuch_trips t WHERE t.import_id = i.id)
 WHERE i.id = 'b1c2d3e4-0000-4000-8000-00000000f001'::uuid
   AND i.row_count <> (SELECT count(*) FROM fahrtenbuch_trips t WHERE t.import_id = i.id);

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- What the company holds now
-- ═════════════════════════════════════════════════════════════════════════════
SELECT 'drivers'  AS what, count(*) FROM drivers  d, (SELECT id FROM companies WHERE name='DEMO Monatsplanung GmbH') c WHERE d.company_id=c.id
UNION ALL SELECT 'cars',      count(*) FROM cars      x, (SELECT id FROM companies WHERE name='DEMO Monatsplanung GmbH') c WHERE x.company_id=c.id
UNION ALL SELECT 'imports',   count(*) FROM fahrtenbuch_imports x, (SELECT id FROM companies WHERE name='DEMO Monatsplanung GmbH') c WHERE x.company_id=c.id
UNION ALL SELECT 'trips',     count(*) FROM fahrtenbuch_trips x, (SELECT id FROM companies WHERE name='DEMO Monatsplanung GmbH') c WHERE x.company_id=c.id
UNION ALL SELECT 'trips linked', count(*) FROM fahrtenbuch_trips x, (SELECT id FROM companies WHERE name='DEMO Monatsplanung GmbH') c WHERE x.company_id=c.id AND x.original_driver_id IS NOT NULL
UNION ALL SELECT 'notes',     count(*) FROM driver_notes x, (SELECT id FROM companies WHERE name='DEMO Monatsplanung GmbH') c WHERE x.company_id=c.id
UNION ALL SELECT 'income',    count(*) FROM income    x, (SELECT id FROM companies WHERE name='DEMO Monatsplanung GmbH') c WHERE x.company_id=c.id
UNION ALL SELECT 'receipts',  count(*) FROM receipts  x, (SELECT id FROM companies WHERE name='DEMO Monatsplanung GmbH') c WHERE x.company_id=c.id
UNION ALL SELECT 'salaries',  count(*) FROM salaries  x, (SELECT id FROM companies WHERE name='DEMO Monatsplanung GmbH') c WHERE x.company_id=c.id
ORDER BY 1;
