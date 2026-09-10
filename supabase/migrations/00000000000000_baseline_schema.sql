/*
  # Baseline schema — the four tables the migration chain never creates

  ## Why this file exists

  `companies`, `drivers`, `receipts` and `saved_stundennachweise` appear in the
  other 149 migrations only as `ALTER TABLE`. Nobody ever committed their
  `CREATE TABLE`; they were made by hand in the Supabase dashboard early on.
  Replaying the chain against an empty database therefore fails on the first
  statement that touches `companies`, which means the schema could not be
  rebuilt — and a schema you cannot rebuild cannot be migrated to a VPS.

  Timestamped `00000000000000` so it sorts before everything else and the rest of
  the chain layers on top as it always expected to.

  ## Where these definitions come from

  Not guessed. Two sources, combined:

  1. The live schema's own `information_schema.columns`, which gives exact types,
     precision, nullability and defaults.
  2. The constraint and foreign-key list from the live database.

  The distinction mattered. Supabase's "schema for AI context" export renders
  `receipts.expense` as bare `numeric`; the catalogue says `numeric(10,2)`.
  Building that column unqualified would have introduced rounding drift into a
  money column that feeds the Stundennachweis and then the Steuerberater. Array
  columns are likewise unusable from that export — `allowed_weekdays` shows as
  `ARRAY`, while `udt_name` resolves it to `_int4`, i.e. `integer[]`.

  ## Interaction with the rest of the chain

  Every table is created with its **current** column set, so the later
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements become no-ops. That is
  intentional: it keeps this file a faithful snapshot rather than a guess at
  which columns were original.

  Everything is `IF NOT EXISTS`, so applying this to the existing production
  database changes nothing.

  ## Verify before trusting it

      node scripts/schema-diff.mjs schema-prod.sql schema-chain.sql

  Done means that exits clean. Foreign keys to `discount_codes`, `referrals` and
  `auth.users` are deliberately added at the end, after the chain has created
  those tables — see the note there.
*/

-- ─── companies ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.companies (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        text NOT NULL,
  slug                        text NOT NULL UNIQUE,
  legal_name                  text,
  email                       text,
  phone                       text,
  address                     text,
  city                        text,
  postal_code                 text,
  country                     text DEFAULT 'Deutschland'::text,
  logo_url                    text,
  status                      text NOT NULL DEFAULT 'active'::text
                                CHECK (status = ANY (ARRAY['active'::text, 'suspended'::text, 'inactive'::text, 'trial'::text])),
  created_at                  timestamptz DEFAULT now(),
  updated_at                  timestamptz DEFAULT now(),
  trial_start                 timestamptz,
  trial_end                   timestamptz,
  plan                        text NOT NULL DEFAULT 'basic'::text,
  archived_at                 timestamptz,
  deleted_at                  timestamptz,
  subscription_car_limit      integer NOT NULL DEFAULT 5 CHECK (subscription_car_limit >= 1),
  billing_cycle               text NOT NULL DEFAULT 'monthly'::text
                                CHECK (billing_cycle = ANY (ARRAY['monthly'::text, 'yearly'::text])),
  active_discount_code_id     uuid,
  active_discount_usage_mode  text
                                CHECK (active_discount_usage_mode = ANY (ARRAY['once'::text, 'monthly'::text])),
  active_discount_started_at  timestamptz,
  approval_status             text NOT NULL DEFAULT 'approved'::text
                                CHECK (approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'suspended'::text])),
  approval_note               text,
  rejection_reason            text,
  approved_at                 timestamptz,
  approved_by                 uuid,
  rejected_at                 timestamptz,
  rejected_by                 uuid,
  referral_id                 uuid,
  referral_code_used          text,
  referred_at                 timestamptz,
  subscription_status         text NOT NULL DEFAULT 'inactive'::text
                                CHECK (subscription_status = ANY (ARRAY['inactive'::text, 'active'::text, 'expired'::text, 'suspended'::text])),
  subscription_started_at     timestamptz,
  subscription_expires_at     timestamptz,
  subscription_duration_type  text,
  last_activation_code_id     uuid
);

-- ─── drivers ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.drivers (
  id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                                text NOT NULL,
  created_at                          timestamptz DEFAULT now(),
  user_id                             uuid,
  created_by                          text,
  -- numeric(5,4): a commission ratio between 0 and 1, four decimal places.
  salary_ratio                        numeric(5,4) NOT NULL DEFAULT 0.5000
                                        CHECK (salary_ratio >= 0::numeric AND salary_ratio <= 1::numeric),
  status                              text DEFAULT 'active'::text
                                        CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text])),
  company_id                          uuid,
  personalnummer                      text,
  gender                              text
                                        CHECK (gender IS NULL OR (gender = ANY (ARRAY['male'::text, 'female'::text]))),
  driver_usage_type                   text NOT NULL DEFAULT 'regular'::text
                                        CHECK (driver_usage_type = ANY (ARRAY['regular'::text, 'coverage_only'::text])),
  target_monthly_hours                numeric,
  max_monthly_hours                   numeric,
  planning_target_salary              numeric,
  planning_hourly_rate                numeric,
  planning_priority                   integer NOT NULL DEFAULT 100,
  planning_enabled                    boolean NOT NULL DEFAULT true,
  -- udt_name _int4 — ISO weekday numbers, not day names.
  allowed_weekdays                    integer[],
  work_window_start                   text,
  work_window_end                     text,
  can_cover_other_drivers             boolean DEFAULT true,
  preferred_shift_start_time          text,
  preferred_shift_end_time            text,
  allow_extra_hours_before_first_ride boolean NOT NULL DEFAULT true,
  allow_extra_hours_after_last_ride   boolean NOT NULL DEFAULT true,
  planned_shift_start_time            text,
  planned_shift_end_time              text,
  -- udt_name _text — three-letter day keys.
  planned_working_days                text[] NOT NULL
                                        DEFAULT ARRAY['mon'::text, 'tue'::text, 'wed'::text, 'thu'::text, 'fri'::text],
  allow_outside_shift_exceptions      boolean NOT NULL DEFAULT false,
  is_full_day_available               boolean NOT NULL DEFAULT false,
  employment_type                     text NOT NULL DEFAULT 'employee'::text,
  planning_min_salary                 numeric(10,2),
  planning_max_salary                 numeric(10,2)
);

-- ─── receipts ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number text NOT NULL,
  date           date NOT NULL,
  description    text NOT NULL,
  driver_name    text NOT NULL,
  -- Money. numeric(10,2), never float — this figure reaches the Steuerberater.
  expense        numeric(10,2) DEFAULT 0,
  created_at     timestamptz DEFAULT now(),
  user_id        uuid,
  created_by     text,
  postal_code    text,
  city           text,
  payment_method text DEFAULT 'bar'::text
                   CHECK (payment_method = ANY (ARRAY['bar'::text, 'uberweisung'::text])),
  company_id     uuid
);

-- ─── saved_stundennachweise ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.saved_stundennachweise (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL,
  driver_id                uuid NOT NULL,
  driver_name              text NOT NULL,
  personalnummer           text,
  month                    integer NOT NULL CHECK (month >= 1 AND month <= 12),
  year                     integer NOT NULL CHECK (year >= 2000 AND year <= 2100),
  -- Minute buckets per Lohnart. Integers, so no rounding can creep in here.
  grundlohn_min            integer NOT NULL DEFAULT 0,
  nachtarbeit_min          integer NOT NULL DEFAULT 0,
  nacht04_min              integer NOT NULL DEFAULT 0,
  samstag_min              integer NOT NULL DEFAULT 0,
  sonntag_min              integer NOT NULL DEFAULT 0,
  feiertag_min             integer NOT NULL DEFAULT 0,
  weihnachten_min          integer NOT NULL DEFAULT 0,
  working_days             integer NOT NULL DEFAULT 0,
  rows_json                jsonb NOT NULL DEFAULT '[]'::jsonb,
  saved_by                 uuid,
  saved_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  target_salary            numeric,
  hourly_rate              numeric,
  calculated_salary        numeric,
  generation_mode          text,
  grundlohn_ratio          numeric,
  totals_target_json       jsonb,
  work_window_json         jsonb,
  generation_source        text,
  source_import_id         uuid,
  source_run_id            uuid,
  generated_at             timestamptz,
  warnings_json            jsonb,
  notes_snapshot_json      jsonb DEFAULT '[]'::jsonb,
  coverage_summary_json    jsonb,
  generation_settings_json jsonb,
  pdf_storage_path         text,
  snapshot_hash            text
);

/*
  MonatsplanungStundennachweisPreview.tsx upserts with
  `onConflict: 'company_id,driver_id,month,year'`. Without a matching unique
  constraint PostgREST cannot resolve that conflict target, so the upsert either
  errors or silently degrades to an insert and duplicates a statutory record.

  Verified present in production on 2026-09-10:

    saved_stundennachweise_company_id_driver_id_month_year_key
    UNIQUE (company_id, driver_id, month, year)

  The name is reproduced exactly. schema-diff.mjs compares constraint *names*, so
  inventing a tidier one here would report a difference that does not exist.
*/
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'saved_stundennachweise_company_id_driver_id_month_year_key'
  ) THEN
    ALTER TABLE public.saved_stundennachweise
      ADD CONSTRAINT saved_stundennachweise_company_id_driver_id_month_year_key
      UNIQUE (company_id, driver_id, month, year);
  END IF;
END $$;

/*
  ─── Foreign keys, added last ──────────────────────────────────────────────

  These reference tables that later migrations create — `discount_codes`,
  `referrals`, `roles` — and `auth.users`, which Supabase Auth provides. Adding
  them inline above would make this file depend on objects that do not exist
  yet, so they are attached here and guarded, letting the chain create their
  targets first.

  On a fresh database where those tables do not yet exist, each block is skipped
  and the constraint is added by whichever later migration owns it.
*/
DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_drivers_user') THEN
      ALTER TABLE public.drivers
        ADD CONSTRAINT fk_drivers_user FOREIGN KEY (user_id) REFERENCES auth.users(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_receipts_user') THEN
      ALTER TABLE public.receipts
        ADD CONSTRAINT fk_receipts_user FOREIGN KEY (user_id) REFERENCES auth.users(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_approved_by_fkey') THEN
      ALTER TABLE public.companies
        ADD CONSTRAINT companies_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_rejected_by_fkey') THEN
      ALTER TABLE public.companies
        ADD CONSTRAINT companies_rejected_by_fkey FOREIGN KEY (rejected_by) REFERENCES auth.users(id);
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_company_id_fkey') THEN
    ALTER TABLE public.drivers
      ADD CONSTRAINT drivers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receipts_company_id_fkey') THEN
    ALTER TABLE public.receipts
      ADD CONSTRAINT receipts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_stundennachweise_company_id_fkey') THEN
    ALTER TABLE public.saved_stundennachweise
      ADD CONSTRAINT saved_stundennachweise_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES public.companies(id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_stundennachweise_driver_id_fkey') THEN
    ALTER TABLE public.saved_stundennachweise
      ADD CONSTRAINT saved_stundennachweise_driver_id_fkey
      FOREIGN KEY (driver_id) REFERENCES public.drivers(id);
  END IF;

  IF to_regclass('public.discount_codes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_active_discount_code_id_fkey') THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_active_discount_code_id_fkey
      FOREIGN KEY (active_discount_code_id) REFERENCES public.discount_codes(id);
  END IF;

  IF to_regclass('public.referrals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_companies_referral_id') THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT fk_companies_referral_id
      FOREIGN KEY (referral_id) REFERENCES public.referrals(id);
  END IF;
END $$;

-- RLS is enabled here so no table is ever briefly readable during a rebuild.
-- The policies themselves come from the chain.
ALTER TABLE public.companies              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drivers                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_stundennachweise ENABLE ROW LEVEL SECURITY;
