-- ═════════════════════════════════════════════════════════════════════════════
-- seed-demo-company-check.sql — the read-only half of seed-demo-company.sql
-- ═════════════════════════════════════════════════════════════════════════════
--
-- What DEMO Monatsplanung GmbH holds on staging, and whether the seed can run.
-- It writes nothing: the whole file is one READ ONLY transaction that is rolled
-- back, so a statement that tried to write would be refused by PostgreSQL
-- itself, not merely by this file's good intentions.
--
-- Run it before the seed (are the preconditions there, and what will the seed
-- add to?) and after it (what will the round 8 months read?):
--
--   ... psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/seed-demo-company-check.sql
--
-- The `ready` lines repeat the seed's two guards as answers, not exceptions, so
-- one run shows every missing precondition at once. A `false` there means the
-- seed would stop and write nothing.

\set ON_ERROR_STOP on
\pset footer off

BEGIN READ ONLY;

-- ── The seed's preconditions ─────────────────────────────────────────────────
SELECT 'ready: exactly one DEMO company' AS what,
       (SELECT count(*) FROM companies WHERE name = 'DEMO Monatsplanung GmbH') = 1 AS answer,
       (SELECT count(*) FROM companies WHERE name = 'DEMO Monatsplanung GmbH') AS found
UNION ALL
SELECT 'ready: the company has an admin profile',
       EXISTS (SELECT 1 FROM user_profiles p JOIN companies c ON c.id = p.company_id
                WHERE c.name = 'DEMO Monatsplanung GmbH' AND p.role = 'admin'),
       (SELECT count(*) FROM user_profiles p JOIN companies c ON c.id = p.company_id
         WHERE c.name = 'DEMO Monatsplanung GmbH' AND p.role = 'admin')
UNION ALL
-- The seed's section 6 joins these three by name and refuses unless each is there once.
SELECT 'ready: Anna Beispiel, Bert Nachtfahrt, Emil Normal once each',
       (SELECT count(*) = 3 AND count(DISTINCT d.name) = 3
          FROM drivers d JOIN companies c ON c.id = d.company_id
         WHERE c.name = 'DEMO Monatsplanung GmbH' AND d.name IN ('Anna Beispiel', 'Bert Nachtfahrt', 'Emil Normal')),
       (SELECT count(*) FROM drivers d JOIN companies c ON c.id = d.company_id
         WHERE c.name = 'DEMO Monatsplanung GmbH' AND d.name IN ('Anna Beispiel', 'Bert Nachtfahrt', 'Emil Normal'));

-- ── The company's simulation settings (D1) ───────────────────────────────────
-- Since 20261127200000 the month script reads this row and refuses
-- --share-percent and --return-to-base beside it. No row means no company
-- share and no return to base, which is a setting too.
SELECT to_regclass('public.company_simulation_settings') IS NOT NULL AS has_sim_settings \gset
\if :has_sim_settings
SELECT 'simulation settings' AS what, s.share_mode, s.share_percent, s.share_scope, s.seed,
       s.return_to_base, s.updated_at
  FROM company_simulation_settings s JOIN companies c ON c.id = s.company_id
 WHERE c.name = 'DEMO Monatsplanung GmbH';
SELECT 'simulation settings row' AS what,
       CASE WHEN EXISTS (SELECT 1 FROM company_simulation_settings s JOIN companies c ON c.id = s.company_id
                          WHERE c.name = 'DEMO Monatsplanung GmbH')
            THEN 'present: the seed leaves it as it is'
            ELSE 'none: the seed writes one only with -v demo_share_percent=30..33' END AS answer;
\else
SELECT 'simulation settings' AS what, 'table missing: this stack predates 20261127200000' AS answer;
\endif

-- ── What the round 8 months will read (the inventory of PLAN.md W1) ──────────
SELECT 'uber rows' AS what, to_char(i.date, 'YYYY-MM') AS month, i.type, count(*) AS rows, sum(i.amount) AS euro,
       count(*) FILTER (WHERE i.amount < 0) AS negative
  FROM income i JOIN companies c ON c.id = i.company_id
 WHERE c.name = 'DEMO Monatsplanung GmbH' AND i.source = 'uber' AND i.date BETWEEN DATE '2026-08-25' AND DATE '2026-11-06'
 GROUP BY 2, 3 ORDER BY 2, 3;
SELECT l.external_driver_id, d.name, l.status
  FROM partner_driver_links l JOIN companies c ON c.id = l.company_id LEFT JOIN drivers d ON d.id = l.driver_id
 WHERE c.name = 'DEMO Monatsplanung GmbH' AND l.partner = 'reidey' ORDER BY 1;
SELECT d.name, d.status, d.employment_type, d.salary_ratio, d.allowed_weekdays,
       d.planning_min_salary, d.planning_max_salary, d.planning_hourly_rate, d.work_window_start, d.work_window_end
  FROM drivers d JOIN companies c ON c.id = d.company_id
 WHERE c.name = 'DEMO Monatsplanung GmbH' ORDER BY d.name;
SELECT x.kennzeichen, x.status FROM cars x JOIN companies c ON c.id = x.company_id
 WHERE c.name = 'DEMO Monatsplanung GmbH' ORDER BY 1;
SELECT 'saved base' AS what, t.base_latitude, t.base_longitude, t.base_radius_km
  FROM trip_analysis_settings t JOIN companies c ON c.id = t.company_id
 WHERE c.name = 'DEMO Monatsplanung GmbH';
SELECT 'address' AS what, s.street IS NOT NULL AND s.house_number IS NOT NULL AS has_street_and_number,
       s.postal_code, s.city
  FROM company_settings s JOIN companies c ON c.id = s.company_id
 WHERE c.name = 'DEMO Monatsplanung GmbH';
-- What the month refuses without (CONFIGURATION_REQUIRED): a city for the
-- address pool, and a base, which is a saved point or a full address geocoded
-- at house level. `false` on either line means the month will not run; the
-- seed fills them with -v demo_city / -v demo_base_lat and -v demo_base_lon.
SELECT 'month needs: a city for the address pool' AS what,
       EXISTS (SELECT 1 FROM company_settings s JOIN companies c ON c.id = s.company_id
                WHERE c.name = 'DEMO Monatsplanung GmbH' AND nullif(btrim(s.city), '') IS NOT NULL) AS answer
UNION ALL
SELECT 'month needs: a base (saved point, or street, number, postal code and city)',
       EXISTS (SELECT 1 FROM trip_analysis_settings t JOIN companies c ON c.id = t.company_id
                WHERE c.name = 'DEMO Monatsplanung GmbH' AND t.base_latitude IS NOT NULL AND t.base_longitude IS NOT NULL)
       OR EXISTS (SELECT 1 FROM company_settings s JOIN companies c ON c.id = s.company_id
                   WHERE c.name = 'DEMO Monatsplanung GmbH' AND s.street IS NOT NULL AND s.house_number IS NOT NULL
                     AND s.postal_code IS NOT NULL AND s.city IS NOT NULL);

-- The deliberate cases of section 6, one line each: the refund (a negative
-- umsatz), Uber activity on a day of leave, and on a weekday the driver may
-- not work (absent while the driver's weekdays leave none out).
SELECT 'case: refund (negative umsatz)' AS what, i.driver_name, i.date, i.amount
  FROM income i JOIN companies c ON c.id = i.company_id
 WHERE c.name = 'DEMO Monatsplanung GmbH' AND i.source = 'uber' AND i.type = 'umsatz' AND i.amount < 0
UNION ALL
SELECT 'case: Uber activity on a day of leave', i.driver_name, i.date, i.amount
  FROM income i JOIN companies c ON c.id = i.company_id
  JOIN drivers d ON d.company_id = c.id AND d.name = i.driver_name
  JOIN driver_notes n ON n.company_id = c.id AND n.driver_id = d.id AND n.note_planning_behavior = 'exclude_from_plan'
                     AND i.date BETWEEN n.start_date AND coalesce(n.end_date, n.start_date)
 WHERE c.name = 'DEMO Monatsplanung GmbH' AND i.source = 'uber' AND i.type = 'umsatz'
   AND i.date BETWEEN DATE '2026-09-01' AND DATE '2026-10-31'
UNION ALL
SELECT 'case: Uber activity on a weekday the driver may not work', i.driver_name, i.date, i.amount
  FROM income i JOIN companies c ON c.id = i.company_id
  JOIN drivers d ON d.company_id = c.id AND d.name = i.driver_name
 WHERE c.name = 'DEMO Monatsplanung GmbH' AND i.source = 'uber' AND i.type = 'umsatz'
   AND i.date BETWEEN DATE '2026-09-01' AND DATE '2026-10-31'
   AND cardinality(coalesce(d.allowed_weekdays, ARRAY[]::integer[])) > 0
   AND NOT (extract(isodow FROM i.date)::int = ANY (d.allowed_weekdays))
 ORDER BY 1, 3;
SELECT 'real trips' AS what, to_char(t.trip_date, 'YYYY-MM') AS month, t.is_simulated, count(*) AS trips,
       count(t.original_driver_id) AS with_driver
  FROM fahrtenbuch_trips t JOIN companies c ON c.id = t.company_id
 WHERE c.name = 'DEMO Monatsplanung GmbH' AND t.trip_date BETWEEN DATE '2026-08-25' AND DATE '2026-11-05'
 GROUP BY 2, 3 ORDER BY 2, 3;

ROLLBACK;
