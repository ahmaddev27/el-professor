/*
  # Add subscription car limit, billing cycle, and pricing fields to companies

  ## Summary
  Adds the columns needed to implement per-car metered pricing with fleet
  discounts and yearly billing discounts. Also adds DB-level triggers to
  enforce the car and driver limits derived from the subscription.

  ## New columns on companies table

  - `subscription_car_limit` (integer, default 3) — maximum number of active
    cars allowed. Drives pricing and the driver limit (car_limit * 2).
  - `billing_cycle` (text, default 'monthly') — 'monthly' or 'yearly'.

  ## Price calculation (done on the fly in frontend)

  Price per car per month:
    basic:   20 EUR
    advanced: 40 EUR
    premium:  70 EUR

  Fleet discount:
    1–5  cars: 0%
    6–10 cars: 5%
    11+  cars: 10%

  Yearly discount: additional 10% off yearly total.

  ## DB enforcement

  Two triggers added:
  1. `enforce_car_limit` — prevents INSERT/UPDATE on `cars` that would push
     active car count above `subscription_car_limit` for the company.
  2. `enforce_driver_limit` — prevents INSERT/UPDATE on `drivers` that would
     push active driver count above `subscription_car_limit * 2` for the
     company.

  ## Security
  - No RLS changes needed (existing company-isolation policies cover new columns)
  - Triggers run as SECURITY DEFINER on service role to bypass RLS when counting

  ## Notes
  - Existing companies get default car_limit=3, billing_cycle='monthly'
  - Triggers only fire when status = 'active' (not 'inactive') to match
    business rules
  - Trigger checks status IS DISTINCT FROM 'inactive' so null rows are counted
*/

-- ── 1. New columns on companies ─────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'subscription_car_limit'
  ) THEN
    ALTER TABLE companies ADD COLUMN subscription_car_limit integer NOT NULL DEFAULT 3;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'billing_cycle'
  ) THEN
    ALTER TABLE companies ADD COLUMN billing_cycle text NOT NULL DEFAULT 'monthly'
      CHECK (billing_cycle IN ('monthly', 'yearly'));
  END IF;
END $$;

-- Ensure car limit is at least 1
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companies_car_limit_positive'
  ) THEN
    ALTER TABLE companies ADD CONSTRAINT companies_car_limit_positive
      CHECK (subscription_car_limit >= 1);
  END IF;
END $$;

-- ── 2. Trigger function: enforce car limit ───────────────────────────────────

CREATE OR REPLACE FUNCTION enforce_car_limit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  car_limit   integer;
  active_cars integer;
BEGIN
  -- Only enforce when the car is active (not being deactivated)
  IF NEW.status IS NOT DISTINCT FROM 'inactive' THEN
    RETURN NEW;
  END IF;

  -- Get the company's car limit
  SELECT subscription_car_limit INTO car_limit
  FROM companies
  WHERE id = NEW.company_id;

  IF car_limit IS NULL THEN
    RETURN NEW; -- No limit set, allow
  END IF;

  -- Count currently active cars for this company (excluding this row on UPDATE)
  SELECT COUNT(*) INTO active_cars
  FROM cars
  WHERE company_id = NEW.company_id
    AND status IS DISTINCT FROM 'inactive'
    AND id IS DISTINCT FROM NEW.id;

  IF active_cars >= car_limit THEN
    RAISE EXCEPTION 'Fahrzeuglimit erreicht. Ihr Abonnement erlaubt maximal % aktive Fahrzeuge.', car_limit
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_car_limit ON cars;
CREATE TRIGGER trg_enforce_car_limit
  BEFORE INSERT OR UPDATE ON cars
  FOR EACH ROW EXECUTE FUNCTION enforce_car_limit();

-- ── 3. Trigger function: enforce driver limit (car_limit * 2) ───────────────

CREATE OR REPLACE FUNCTION enforce_driver_limit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  car_limit      integer;
  driver_limit   integer;
  active_drivers integer;
BEGIN
  -- Only enforce when the driver is active
  IF NEW.status IS NOT DISTINCT FROM 'inactive' THEN
    RETURN NEW;
  END IF;

  -- Get the company's car limit
  SELECT subscription_car_limit INTO car_limit
  FROM companies
  WHERE id = NEW.company_id;

  IF car_limit IS NULL THEN
    RETURN NEW;
  END IF;

  driver_limit := car_limit * 2;

  -- Count currently active drivers for this company (excluding this row on UPDATE)
  SELECT COUNT(*) INTO active_drivers
  FROM drivers
  WHERE company_id = NEW.company_id
    AND status IS DISTINCT FROM 'inactive'
    AND id IS DISTINCT FROM NEW.id;

  IF active_drivers >= driver_limit THEN
    RAISE EXCEPTION 'Fahrerlimit erreicht. Ihr Abonnement erlaubt maximal % aktive Fahrer (% Fahrzeuge × 2).', driver_limit, car_limit
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_driver_limit ON drivers;
CREATE TRIGGER trg_enforce_driver_limit
  BEFORE INSERT OR UPDATE ON drivers
  FOR EACH ROW EXECUTE FUNCTION enforce_driver_limit();
