-- Placement report: how many of a month's addresses the locator has placed, and
-- whether the points it placed are believable (address locator, 22.10.2026).
--
-- This is the acceptance read-out, and it makes NO request to anybody. The locator
-- asks ridy's Nominatim once per address and keeps the answer in geocode_cache; this
-- script reads the cache and the month's trips and says what came out. Run it after
-- the first real month has gone through the Fahrtenanalyse, and do NOT run that month
-- through ridy's service a second time to see it again: every address asked is in
-- their request log.
--
-- The check it makes is the one that needs nothing but the points and the sheet:
-- a road is never shorter than the straight line between its two ends. A ride whose
-- `Kilometer` is BELOW the line between its two placed addresses (beyond a slack for
-- the placement of both points and for the sheet's rounding) is either a misplaced
-- address or a bad cell. It finds gross errors, not small ones: a point 200 m off
-- passes. Routed distance (OSRM) is the finer instrument and arrives with our own
-- OSRM; this does not wait for it.
--
-- It writes nothing: BEGIN READ ONLY, and ROLLBACK even so. Staging only, and never
-- production. The company is one you name (the output is a summary: counts, ratios,
-- and for the rides to look at the trip id with two numbers, never an address):
--
--   ssh elprofessor 'docker exec -i ya-mobility-staging-db-1 \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--          -v company=<company uuid> -v year=2026 -v month=5 -f -' \
--     < tests/staging/geocode-placement.sql
--
-- The key a cell is looked up by is addressKey() of supabase/functions/_shared/
-- geocode-core.ts written in SQL: tidy spaces and commas, no country at the end,
-- lower case. A cell this reads differently from the browser shows as "not placed".

BEGIN READ ONLY;

WITH
rides AS (
  SELECT t.id,
         NULLIF(btrim(t.route_start), '') AS pickup,
         NULLIF(btrim(t.route_end), '')   AS dropoff,
         CASE WHEN (t.raw_data_json ->> 'Kilometer') ~ '^[0-9]+([.,][0-9]+)?$'
              THEN replace(t.raw_data_json ->> 'Kilometer', ',', '.')::numeric END AS km
    FROM public.fahrtenbuch_trips t
   WHERE t.company_id = :'company'::uuid
     AND NOT t.is_canceled
     AND t.trip_date >= make_date(:year::int, :month::int, 1)
     AND t.trip_date <  make_date(:year::int, :month::int, 1) + interval '1 month'
),
cells AS (
  SELECT r.id, 'pickup'  AS side, r.pickup  AS txt FROM rides r
  UNION ALL
  SELECT r.id, 'dropoff' AS side, r.dropoff AS txt FROM rides r
),
keyed AS (
  SELECT c.id, c.side, c.txt,
         lower(regexp_replace(regexp_replace(regexp_replace(btrim(c.txt), '\s+', ' ', 'g'),
               '\s*,\s*', ', ', 'g'), ',\s*(deutschland|germany)$', '', 'i')) AS k
    FROM cells c
),
classified AS (
  SELECT q.id, q.side, g.lat, g.lon,
         CASE
           WHEN g.address_key IS NOT NULL THEN 'placed'
           WHEN q.txt IS NULL THEN 'missing'
           WHEN q.k !~ ', [0-9]{5} [^,]+$' THEN 'unparseable'
           WHEN substring(q.k FROM '([^,]+), [0-9]{5} [^,]+$') !~ ' [0-9]+ ?[a-z]?([-/] ?[0-9]+ ?[a-z]?)?$' THEN 'no_house_number'
           ELSE 'house_number_not_placed'
         END AS cls
    FROM keyed q
    LEFT JOIN public.geocode_cache g
           ON g.company_id = :'company'::uuid AND g.address_key = q.k
),
pairs AS (
  SELECT r.id, r.km, p.cls AS pickup_cls, d.cls AS dropoff_cls,
         p.lat AS plat, p.lon AS plon, d.lat AS dlat, d.lon AS dlon
    FROM rides r
    JOIN classified p ON p.id = r.id AND p.side = 'pickup'
    JOIN classified d ON d.id = r.id AND d.side = 'dropoff'
),
measured AS (
  SELECT x.id, x.km,
         2 * 6371.0088 * asin(sqrt(power(sin(radians(x.dlat - x.plat) / 2), 2)
           + cos(radians(x.plat)) * cos(radians(x.dlat)) * power(sin(radians(x.dlon - x.plon) / 2), 2))) AS line_km
    FROM pairs x
   WHERE x.pickup_cls = 'placed' AND x.dropoff_cls = 'placed' AND x.km > 0
),
usable AS (
  SELECT m.*, m.km / m.line_km AS ratio,
         (m.km + 0.15 + 0.05 * m.line_km < m.line_km) AS shorter_than_line
    FROM measured m
   WHERE m.line_km >= 0.2
),
spread AS (
  SELECT percentile_cont(ARRAY[0.05, 0.25, 0.5, 0.75, 0.95]) WITHIN GROUP (ORDER BY u.ratio) AS q FROM usable u
)
SELECT section, label, n, detail FROM (
  SELECT 1 AS o, 'address cells' AS section, cls AS label, count(*)::numeric AS n,
         round(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1)::text || ' %' AS detail
    FROM classified GROUP BY cls
  UNION ALL
  SELECT 2, 'rides', 'completed rides in the month', count(*), NULL FROM rides
  UNION ALL
  SELECT 3, 'rides', 'both ends placed', count(*), NULL FROM pairs WHERE pickup_cls = 'placed' AND dropoff_cls = 'placed'
  UNION ALL
  SELECT 4, 'rides', 'one end placed', count(*), NULL FROM pairs WHERE (pickup_cls = 'placed') <> (dropoff_cls = 'placed')
  UNION ALL
  SELECT 5, 'rides', 'no end placed', count(*), NULL FROM pairs WHERE pickup_cls <> 'placed' AND dropoff_cls <> 'placed'
  UNION ALL
  SELECT 6, 'straight line', 'rides compared (both placed, km > 0, line >= 0.2 km)', count(*), NULL FROM usable
  UNION ALL
  SELECT 7, 'straight line', 'km shorter than the line: a misplaced address or a bad cell', count(*), NULL FROM usable WHERE shorter_than_line
  UNION ALL
  SELECT 8, 'straight line', 'km / line, percentiles 5 25 50 75 95',
         (SELECT count(*) FROM usable),
         (SELECT array_to_string(ARRAY(SELECT round(v::numeric, 2) FROM unnest(q) AS v), '  ') FROM spread)
  UNION ALL
  SELECT 9, 'to look at', 'trip ' || u.id::text, round(u.km, 1), 'line ' || round(u.line_km::numeric, 1) || ' km'
    FROM (SELECT * FROM usable WHERE shorter_than_line ORDER BY line_km - km DESC LIMIT 30) u
) report
ORDER BY o, label;

ROLLBACK;
