\set ON_ERROR_STOP on
/*
  STAGING ONLY, and the ids below are staging's. Run as `supabase_admin` inside
  the staging database container; `postgres` has no USAGE on app_private and is
  not what the rest of this repo's host steps use either.

      docker cp tests/fixtures/seed-partner-demo.sql ya-mobility-staging-db-1:/tmp/seed.sql
      docker exec ya-mobility-staging-db-1 psql -U supabase_admin -d postgres -f /tmp/seed.sql

  The photo it names must already be in the `documents` bucket at that path;
  it is uploaded through the storage API with staging's service key, from a
  throwaway container on `ya-mobility-staging_default` (no host port is
  published on this box, which is shared with ridy).
*/
/*
  Two waiting submissions for DEMO Monatsplanung GmbH on STAGING, so the review
  tab can be tried before Reidey is deployed.

  Written through the two `*_submission_record` doors rather than by INSERT, so
  the demo rows pass exactly the validation a real submission passes — a seed
  that bypasses the door proves the screen and nothing else. Re-runnable: both
  doors are idempotent on the external id, and the link upserts.

  The photo is already in the `documents` bucket at the path the Beleg names.
*/
BEGIN;

-- The link a confirmed proposal leaves, so the accept can resolve our driver.
INSERT INTO public.partner_driver_links
       (company_id, partner, external_driver_id, driver_id, status, linked_at)
VALUES ('ef01545b-c9a2-6550-7b26-1851d1618173', 'reidey', 'demo-41',
        'ad698e02-8bb2-a6f0-bb22-837a1267ea37', 'linked', now())
ON CONFLICT (company_id, partner, external_driver_id) DO UPDATE
   SET driver_id = EXCLUDED.driver_id, status = 'linked', linked_at = now();

SELECT public.partner_receipt_submission_record(
  'ef01545b-c9a2-6550-7b26-1851d1618173', 'reidey', 'demo-beleg-0001', 'demo-41',
  '2026-10-07', 'Tanken', NULL, '41.47', 'bar', '10179',
  'ef01545b-c9a2-6550-7b26-1851d1618173/partner/demo-beleg-0001.jpg',
  NULL, true, false, NULL) AS beleg;

SELECT public.partner_note_submission_record(
  'ef01545b-c9a2-6550-7b26-1851d1618173', 'reidey', 'demo-notiz-0001', 'demo-41',
  'breakdown', 'Panne auf der A100, Abschleppdienst gerufen.',
  '2026-10-07', '2026-10-07', false, '08:15', '10:40', NULL) AS notiz;

COMMIT;
