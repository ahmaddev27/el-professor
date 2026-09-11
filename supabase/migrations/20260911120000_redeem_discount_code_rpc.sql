/*
  # Redeem a discount code in one atomic, server-authoritative step

  ## What was wrong

  Three separate problems, all the same shape — the browser decided something
  the server then believed.

  **1. The limit was checked, then never enforced.** `validate-discount-code`
  runs every check properly: active, validity window, plan, billing cycle,
  min/max cars, audience, `used_count < max_redemptions`. It then hands the
  browser a `discount_code_id`. `company-signup` writes that id onto the new
  company **without re-reading the code row, without re-checking the limit, and
  without inserting a redemption**. So the counter that bounds a code is
  consulted at validation time and never at commit time.

  **2. The price came from the client.** `validate-discount-code` computes the
  discount against `current_price`, which the browser sends
  (`SignupPage.tsx:171`, from `calcPricing()`). `apply-discount-code` goes
  further and takes `discount_amount` and `final_price` from the request body
  outright, with the service-role key. A modified client names its own price.

  **3. Two concurrent redemptions both passed.** Even where the count was
  checked, `SELECT used_count` followed by a later `UPDATE` has no lock between
  them, so a `max_redemptions = 1` code could be redeemed twice.

  ## What this does instead

  One SECURITY DEFINER function that takes the **code text** — never an id the
  client chose — recomputes the price from the plan and car count, re-runs every
  check while holding a row lock, records the redemption, and returns the price
  it computed. Callers ignore whatever the body said.

  Modelled on `redeem_activation_code` (20260621024136), which already
  establishes this project's pattern for validate-reserve-record in one
  transaction.

  ## The pricing formula is duplicated here, deliberately

  It mirrors `src/utils/pricing.ts` exactly:

      pricePerCar        basic 20, advanced 40, premium 70   (EUR/car/month)
      fleetDiscountPct   >= 11 cars -> 10 %, >= 6 -> 5 %, else 0
      monthlyAfterFleet  carLimit * pricePerCar * (1 - fleet%)
      yearly             monthlyAfterFleet * 12 * 0.90
      monthly            monthlyAfterFleet

  Duplication is the cost of not trusting the client, and the two must be kept
  in step. Change one, change the other — a mismatch shows up as a price on the
  invoice that differs from the price on the screen.
*/

-- ─── Price, computed server-side ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.compute_plan_price(
  p_plan          text,
  p_car_limit     integer,
  p_billing_cycle text
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE WHEN p_billing_cycle = 'yearly' THEN monthly * 12 * 0.90 ELSE monthly END
  FROM (
    SELECT greatest(coalesce(p_car_limit, 1), 1)
         * CASE p_plan WHEN 'basic' THEN 20 WHEN 'advanced' THEN 40 WHEN 'premium' THEN 70 ELSE 20 END
         * (1 - CASE WHEN coalesce(p_car_limit, 1) >= 11 THEN 0.10
                     WHEN coalesce(p_car_limit, 1) >= 6  THEN 0.05
                     ELSE 0 END) AS monthly
  ) AS q;
$$;

COMMENT ON FUNCTION public.compute_plan_price(text, integer, text) IS
  'Server-side mirror of calcPricing() in src/utils/pricing.ts. Keep the two in step.';

-- ─── Redeem ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.redeem_discount_code(
  p_code          text,
  p_company_id    uuid,
  p_plan          text,
  p_billing_cycle text,
  p_car_limit     integer
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  dc              discount_codes%ROWTYPE;
  v_clean         text;
  v_base_price    numeric;
  v_discount      numeric := 0;
  v_final         numeric;
  v_other_company uuid;
  v_caller        uuid := auth.uid();
BEGIN
  IF p_company_id IS NULL THEN
    RETURN json_build_object('success', false, 'reason_code', 'INVALID',
      'german_message', 'Kein Unternehmenskonto angegeben.');
  END IF;

  v_clean := upper(trim(coalesce(p_code, '')));
  IF v_clean = '' THEN
    RETURN json_build_object('success', false, 'reason_code', 'INVALID',
      'german_message', 'Dieser Rabattcode ist ungültig.');
  END IF;

  -- FOR UPDATE is the point of this function. Without the lock, two requests
  -- read the same used_count, both find room under max_redemptions, and both
  -- commit.
  SELECT * INTO dc
    FROM discount_codes
   WHERE upper(code) = v_clean
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'reason_code', 'INVALID',
      'german_message', 'Dieser Rabattcode ist ungültig.');
  END IF;

  IF NOT dc.active THEN
    RETURN json_build_object('success', false, 'reason_code', 'INACTIVE',
      'german_message', 'Dieser Rabattcode ist nicht aktiv.');
  END IF;

  IF dc.valid_from IS NOT NULL AND now() < dc.valid_from THEN
    RETURN json_build_object('success', false, 'reason_code', 'NOT_YET_VALID',
      'german_message', 'Dieser Rabattcode ist noch nicht gültig.');
  END IF;

  IF dc.valid_until IS NOT NULL AND now() > dc.valid_until THEN
    RETURN json_build_object('success', false, 'reason_code', 'EXPIRED',
      'german_message', 'Dieser Rabattcode ist abgelaufen.');
  END IF;

  IF dc.applies_to_plan <> 'all' AND dc.applies_to_plan <> p_plan THEN
    RETURN json_build_object('success', false, 'reason_code', 'WRONG_PLAN',
      'german_message', 'Dieser Rabattcode ist für diesen Tarif nicht gültig.');
  END IF;

  IF dc.applies_to_billing_cycle <> 'all' AND dc.applies_to_billing_cycle <> p_billing_cycle THEN
    RETURN json_build_object('success', false, 'reason_code', 'WRONG_BILLING_CYCLE',
      'german_message', 'Dieser Rabattcode ist für diese Abrechnungsart nicht gültig.');
  END IF;

  IF dc.min_cars IS NOT NULL AND p_car_limit < dc.min_cars THEN
    RETURN json_build_object('success', false, 'reason_code', 'TOO_FEW_CARS',
      'german_message', format('Dieser Rabattcode gilt erst ab %s Fahrzeugen.', dc.min_cars));
  END IF;

  IF dc.max_cars IS NOT NULL AND p_car_limit > dc.max_cars THEN
    RETURN json_build_object('success', false, 'reason_code', 'TOO_MANY_CARS',
      'german_message', format('Dieser Rabattcode ist nur bis %s Fahrzeuge gültig.', dc.max_cars));
  END IF;

  -- audience 'single': one company only, ever
  IF dc.audience_type = 'single' THEN
    IF dc.assigned_company_id IS NOT NULL AND dc.assigned_company_id <> p_company_id THEN
      RETURN json_build_object('success', false, 'reason_code', 'ALREADY_USED',
        'german_message', 'Dieser Rabattcode wurde bereits verwendet.');
    END IF;

    SELECT company_id INTO v_other_company
      FROM discount_code_redemptions
     WHERE discount_code_id = dc.id AND company_id <> p_company_id
     LIMIT 1;

    IF v_other_company IS NOT NULL THEN
      RETURN json_build_object('success', false, 'reason_code', 'ALREADY_USED',
        'german_message', 'Dieser Rabattcode wurde bereits verwendet.');
    END IF;
  END IF;

  IF dc.audience_type = 'multiple'
     AND dc.max_redemptions IS NOT NULL
     AND dc.used_count >= dc.max_redemptions THEN
    RETURN json_build_object('success', false, 'reason_code', 'LIMIT_REACHED',
      'german_message', 'Dieser Rabattcode wurde bereits vollständig eingelöst.');
  END IF;

  -- 'once': the same company may not redeem the same code twice
  IF dc.usage_mode = 'once'
     AND EXISTS (SELECT 1 FROM discount_code_redemptions
                  WHERE discount_code_id = dc.id AND company_id = p_company_id) THEN
    RETURN json_build_object('success', false, 'reason_code', 'ALREADY_USED',
      'german_message', 'Dieser Rabattcode wurde bereits verwendet.');
  END IF;

  -- The base price is computed here, never accepted from the caller.
  v_base_price := compute_plan_price(p_plan, p_car_limit, p_billing_cycle);

  IF dc.discount_type = 'percentage' THEN
    v_discount := v_base_price * (least(100, greatest(0, dc.discount_value)) / 100.0);
  ELSIF dc.usage_mode = 'monthly' AND p_billing_cycle = 'yearly' THEN
    -- a monthly fixed amount applies to each of the twelve billed months
    v_discount := dc.discount_value * 12;
  ELSE
    v_discount := dc.discount_value;
  END IF;

  v_final    := greatest(0, v_base_price - v_discount);
  v_discount := v_base_price - v_final;   -- re-derive, in case it capped at zero

  INSERT INTO discount_code_redemptions
    (discount_code_id, company_id, user_id, plan, billing_cycle, car_limit,
     original_price, discount_amount, final_price, usage_mode)
  VALUES
    (dc.id, p_company_id, v_caller, p_plan, p_billing_cycle, p_car_limit,
     v_base_price, v_discount, v_final, dc.usage_mode);

  UPDATE discount_codes
     SET used_count          = used_count + 1,
         assigned_company_id = CASE WHEN audience_type = 'single'
                                    THEN coalesce(assigned_company_id, p_company_id)
                                    ELSE assigned_company_id END,
         updated_at          = now()
   WHERE id = dc.id;

  UPDATE companies
     SET active_discount_code_id   = dc.id,
         active_discount_usage_mode = dc.usage_mode
   WHERE id = p_company_id;

  RETURN json_build_object(
    'success',          true,
    'discount_code_id', dc.id,
    'usage_mode',       dc.usage_mode,
    'discount_type',    dc.discount_type,
    'discount_value',   dc.discount_value,
    'original_price',   v_base_price,
    'discount_amount',  v_discount,
    'final_price',      v_final,
    'german_message',   'Rabattcode erfolgreich eingelöst.'
  );
END;
$$;

COMMENT ON FUNCTION public.redeem_discount_code(text, uuid, text, text, integer) IS
  'Validates, locks, records and prices a discount redemption in one transaction. Takes the code text, never an id from the client, and computes the price itself.';

-- Only the service role calls this: signup happens before the user has a
-- session, and an authenticated caller must not be able to redeem against an
-- arbitrary company_id.
REVOKE ALL ON FUNCTION public.redeem_discount_code(text, uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redeem_discount_code(text, uuid, text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_discount_code(text, uuid, text, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.compute_plan_price(text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_plan_price(text, integer, text) TO authenticated, service_role;
