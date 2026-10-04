-- A driver's e-mail and phone number, so the Abrechnung can be sent to them.
--
-- The owner asked for this on 02.10.2026: every driver gets an address and a
-- number in their profile, and the weekly Abrechnung can then be mailed to one
-- driver or to all of them at once.
--
-- ## Two nullable columns, and no policy touched
--
-- `public.drivers` already carries 20260917130000's shape, and every one of its
-- four policies keys on `company_id` rather than on a column list — so two new
-- columns are covered by them the moment they exist. Nothing here grants, revokes
-- or redefines a policy, and nothing needs to.
--
-- **No `SCHEMA_EPOCH` bump.** Adding a nullable column is backward compatible: the
-- previous release writes every driver without naming either column and simply
-- never reads them, so a rollback across this migration is safe.
--
-- ## Why the phone is E.164 and the CHECK is not decoration
--
-- The owner's stated next step for the number is WhatsApp. A `wa.me` link takes
-- digits in international form with no plus, no zero and no spaces —
-- `wa.me/4917012345678` — so a number stored the way an operator types it
-- ("0170 1234567") cannot be turned into a link later without reprocessing every
-- row by hand. Storing E.164 from the first day is what avoids that, and the CHECK
-- is what keeps it true: the browser normalises what is typed, and a number it
-- cannot read is refused rather than stored dead.
--
-- ## And why the e-mail CHECK is deliberately loose
--
-- It refuses what cannot be an address — no `@`, whitespace, more than one `@`,
-- nothing before or after it — and nothing more. A strict RFC pattern in a CHECK
-- constraint rejects valid addresses (quoted local parts, new TLDs) and the cost
-- of that is an operator who cannot save a driver whose address works. What this
-- document is for is deciding where a person's financial summary is sent, so the
-- real guard is the operator reading the address in the confirmation before the
-- send, not a regular expression.
--
-- Neither column is UNIQUE. Two drivers may share an address — a family, a shared
-- household — and a unique index would refuse the second one for no reason.

ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.drivers'::regclass AND conname = 'drivers_email_shape'
  ) THEN
    ALTER TABLE public.drivers
      ADD CONSTRAINT drivers_email_shape
      CHECK (
        email IS NULL
        OR email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.drivers'::regclass AND conname = 'drivers_phone_shape'
  ) THEN
    ALTER TABLE public.drivers
      ADD CONSTRAINT drivers_phone_shape
      -- E.164: a plus, a country code that cannot start with 0, then 6 to 14 more
      -- digits. No spaces, no separators, nothing to strip at the point of use.
      CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$');
  END IF;
END
$$;

COMMENT ON COLUMN public.drivers.email IS
  'Where this driver''s Abrechnung is sent. Nullable: a driver without one is '
  'skipped by the send and named in the confirmation, never guessed at.';
COMMENT ON COLUMN public.drivers.phone IS
  'E.164 (+4917012345678), so a wa.me link can be built from it without '
  'reprocessing. The browser normalises what the operator types.';

-- ── Self-check ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_bad text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'drivers' AND column_name = 'email'
  ) THEN
    RAISE EXCEPTION 'drivers.email was not added';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'drivers' AND column_name = 'phone'
  ) THEN
    RAISE EXCEPTION 'drivers.phone was not added';
  END IF;

  -- Both must stay nullable. A NOT NULL here would refuse every existing driver,
  -- and there are thousands of them with no contact details at all.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'drivers'
       AND column_name IN ('email', 'phone') AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'drivers.email / drivers.phone must stay nullable';
  END IF;

  -- The two CHECKs exist and actually refuse. Asserted by trying, not by reading
  -- the catalogue: a constraint can be present and permissive.
  --
  -- Cleared first: a run that failed between the valid insert and its delete would
  -- leave the row behind, and the next run's valid insert would then raise
  -- `unique_violation` — which this block would report as "the CHECKs refuse a
  -- valid address", naming the wrong defect entirely.
  DELETE FROM public.drivers WHERE id = '00000000-0000-4000-8000-00000000dead';

  BEGIN
    INSERT INTO public.drivers (id, name, email)
    VALUES ('00000000-0000-4000-8000-00000000dead', '__selfcheck__', 'not-an-address');
    RAISE EXCEPTION 'drivers_email_shape accepted an address with no @';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.drivers (id, name, phone)
    VALUES ('00000000-0000-4000-8000-00000000dead', '__selfcheck__', '0170 1234567');
    RAISE EXCEPTION 'drivers_phone_shape accepted a national number with spaces';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  -- And they admit what they must.
  BEGIN
    INSERT INTO public.drivers (id, name, email, phone)
    VALUES ('00000000-0000-4000-8000-00000000dead', '__selfcheck__',
            'fahrer@example.com', '+4917012345678');
    DELETE FROM public.drivers WHERE id = '00000000-0000-4000-8000-00000000dead';
  EXCEPTION
    WHEN check_violation THEN
      RAISE EXCEPTION 'the CHECKs refuse a valid address or a valid E.164 number';
  END;

  -- No policy was touched: the four that exist key on company_id, which covers a
  -- new column by construction. A migration that starts naming columns in a
  -- policy would have to say so here.
  SELECT string_agg(polname, ', ' ORDER BY polname) INTO v_bad
    FROM pg_policy
   WHERE polrelid = 'public.drivers'::regclass
     AND (pg_get_expr(polqual, polrelid) ILIKE '%email%'
       OR pg_get_expr(polqual, polrelid) ILIKE '%phone%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a drivers policy now names a contact column: %', v_bad;
  END IF;
END
$$;
