-- CI only (the geocoder job). The two tables tests/staging/geocode-placement.sql reads,
-- with the columns it reads, and a month of INVENTED rides whose answers are known:
--
--   r1  Aweg 1 -> Bweg 2     placed both, 4.5 km for a 3.3 km line             compared, fine
--   r2  Cweg 3 -> Dweg 4     placed both, 3.0 km for a 5.0 km line             compared, SHORTER than the line
--   r3  Marktplatz -> Aweg 1 pickup has no house number, dropoff placed        one end
--   r4  Eweg 5 -> Bweg 2     pickup has a number and was never placed          one end
--   r5  canceled             not counted at all
--   r6  Aweg 1 -> Bweg 2     placed both, the sheet has no Kilometer           not compared
--   r7  irgendwo -> Aweg 1   pickup cannot be read as an address               one end
--   r8  in April             not in the month
--   r9  Fweg 6 -> Gweg 7     placed both, 0.1 km apart                         not compared (line < 0.2 km)
--
-- 7 rides, 14 cells: 11 placed, 1 unparseable, 1 without a number, 1 with a number and not placed.
CREATE TABLE public.fahrtenbuch_trips (
  id uuid PRIMARY KEY, company_id uuid NOT NULL, trip_date date NOT NULL,
  route_start text, route_end text, is_canceled boolean NOT NULL DEFAULT false, raw_data_json jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE public.geocode_cache (
  company_id uuid NOT NULL, address_key text NOT NULL, lat double precision NOT NULL, lon double precision NOT NULL,
  PRIMARY KEY (company_id, address_key)
);

INSERT INTO public.geocode_cache (company_id, address_key, lat, lon) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'aweg 1, 42651 solingen', 51.1700, 7.0800),
  ('00000000-0000-4000-8000-0000000000c1', 'bweg 2, 42651 solingen', 51.2000, 7.0800),
  ('00000000-0000-4000-8000-0000000000c1', 'cweg 3, 42651 solingen', 51.1000, 7.1000),
  ('00000000-0000-4000-8000-0000000000c1', 'dweg 4, 42651 solingen', 51.1450, 7.1000),
  ('00000000-0000-4000-8000-0000000000c1', 'fweg 6, 42651 solingen', 51.1500, 7.2000),
  ('00000000-0000-4000-8000-0000000000c1', 'gweg 7, 42651 solingen', 51.1509, 7.2000),
  -- another company's rows must not be read as this company's
  ('00000000-0000-4000-8000-0000000000c2', 'eweg 5, 42651 solingen', 51.3000, 7.3000);

INSERT INTO public.fahrtenbuch_trips (id, company_id, trip_date, route_start, route_end, is_canceled, raw_data_json) VALUES
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1', '2026-05-04', 'Aweg 1, 42651 Solingen, Deutschland', 'Bweg 2, 42651 Solingen, Deutschland', false, '{"Kilometer": 4.5}'),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000c1', '2026-05-05', 'Cweg 3, 42651 Solingen, Deutschland', 'Dweg 4, 42651 Solingen, Deutschland', false, '{"Kilometer": 3.0}'),
  ('00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000c1', '2026-05-06', 'Marktplatz, 42651 Solingen, Deutschland', 'Aweg 1, 42651 Solingen, Deutschland', false, '{"Kilometer": 2.0}'),
  ('00000000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-0000000000c1', '2026-05-07', 'Eweg 5, 42651 Solingen, Deutschland', 'Bweg 2, 42651 Solingen, Deutschland', false, '{"Kilometer": "6,2"}'),
  ('00000000-0000-4000-8000-0000000000b5', '00000000-0000-4000-8000-0000000000c1', '2026-05-08', 'Aweg 1, 42651 Solingen, Deutschland', 'Bweg 2, 42651 Solingen, Deutschland', true,  '{"Kilometer": 1.0}'),
  ('00000000-0000-4000-8000-0000000000b6', '00000000-0000-4000-8000-0000000000c1', '2026-05-09', 'Aweg 1,  42651 Solingen , Deutschland', 'bweg 2, 42651 solingen', false, '{}'),
  ('00000000-0000-4000-8000-0000000000b7', '00000000-0000-4000-8000-0000000000c1', '2026-05-10', 'irgendwo', 'Aweg 1, 42651 Solingen, Deutschland', false, '{"Kilometer": 2.5}'),
  ('00000000-0000-4000-8000-0000000000b8', '00000000-0000-4000-8000-0000000000c1', '2026-04-30', 'Aweg 1, 42651 Solingen, Deutschland', 'Bweg 2, 42651 Solingen, Deutschland', false, '{"Kilometer": 4.5}'),
  ('00000000-0000-4000-8000-0000000000b9', '00000000-0000-4000-8000-0000000000c1', '2026-05-11', 'Fweg 6, 42651 Solingen, Deutschland', 'Gweg 7, 42651 Solingen, Deutschland', false, '{"Kilometer": 0.3}');
