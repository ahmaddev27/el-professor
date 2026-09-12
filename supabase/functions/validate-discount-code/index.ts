import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor } from "../_shared/http.ts";

interface ValidateRequest {
  code: string;
  plan: string;
  billing_cycle: string;
  car_limit: number;
  current_price: number; // price after fleet + yearly discounts
  company_id: string;
}

interface ValidateResponse {
  valid: boolean;
  reason_code: string;
  german_message: string;
  discount_amount: number;
  final_price: number;
  discount_code_id: string | null;
  usage_mode: string | null;
  discount_type: string | null;
  discount_value: number | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsFor(req) });
  }

  // Defined here rather than at module scope so it can carry this request's
  // CORS headers — the allow-list depends on the caller's Origin.
  const respond = (data: ValidateResponse): Response =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsFor(req), "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const body: ValidateRequest = await req.json();
    const { code, plan, billing_cycle, car_limit, current_price, company_id } = body;

    if (!code?.trim()) {
      return respond({ valid: false, reason_code: "INVALID", german_message: "Dieser Rabattcode ist ungültig.", discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
    }

    // Fetch the discount code (case-insensitive)
    const { data: dc, error: dcErr } = await supabase
      .from("discount_codes")
      .select("*")
      .ilike("code", code.trim())
      .maybeSingle();

    if (dcErr || !dc) {
      return respond({ valid: false, reason_code: "INVALID", german_message: "Dieser Rabattcode ist ungültig.", discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
    }

    // Active check
    if (!dc.active) {
      return respond({ valid: false, reason_code: "INACTIVE", german_message: "Dieser Rabattcode ist nicht aktiv.", discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
    }

    const now = new Date();

    // valid_from check
    if (dc.valid_from && new Date(dc.valid_from) > now) {
      return respond({ valid: false, reason_code: "NOT_YET_VALID", german_message: "Dieser Rabattcode ist noch nicht gültig.", discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
    }

    // valid_until check
    if (dc.valid_until && new Date(dc.valid_until) < now) {
      return respond({ valid: false, reason_code: "EXPIRED", german_message: "Dieser Rabattcode ist abgelaufen.", discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
    }

    // plan check
    if (dc.applies_to_plan !== "all" && dc.applies_to_plan !== plan) {
      return respond({ valid: false, reason_code: "WRONG_PLAN", german_message: "Dieser Rabattcode ist für diesen Tarif nicht gültig.", discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
    }

    // billing_cycle check
    if (dc.applies_to_billing_cycle !== "all" && dc.applies_to_billing_cycle !== billing_cycle) {
      return respond({ valid: false, reason_code: "WRONG_BILLING_CYCLE", german_message: "Dieser Rabattcode ist für diese Abrechnungsart nicht gültig.", discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
    }

    // min_cars check
    if (dc.min_cars != null && car_limit < dc.min_cars) {
      return respond({ valid: false, reason_code: "TOO_FEW_CARS", german_message: `Dieser Rabattcode gilt erst ab ${dc.min_cars} Fahrzeugen.`, discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
    }

    // max_cars check
    if (dc.max_cars != null && car_limit > dc.max_cars) {
      return respond({ valid: false, reason_code: "TOO_MANY_CARS", german_message: `Dieser Rabattcode ist nur bis ${dc.max_cars} Fahrzeuge gültig.`, discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
    }

    // Audience checks
    if (dc.audience_type === "single") {
      if (dc.assigned_company_id && dc.assigned_company_id !== company_id) {
        return respond({ valid: false, reason_code: "ALREADY_USED", german_message: "Dieser Rabattcode wurde bereits verwendet.", discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
      }
      if (!dc.assigned_company_id) {
        // Check if any company (other than current) has already redeemed it
        const { data: existingRedemptions } = await supabase
          .from("discount_code_redemptions")
          .select("company_id")
          .eq("discount_code_id", dc.id)
          .neq("company_id", company_id)
          .limit(1);

        if (existingRedemptions && existingRedemptions.length > 0) {
          return respond({ valid: false, reason_code: "ALREADY_USED", german_message: "Dieser Rabattcode wurde bereits verwendet.", discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
        }
      }
    }

    if (dc.audience_type === "multiple") {
      if (dc.max_redemptions != null && dc.used_count >= dc.max_redemptions) {
        return respond({ valid: false, reason_code: "LIMIT_REACHED", german_message: "Dieser Rabattcode wurde bereits vollständig eingelöst.", discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
      }
    }

    // once usage: same company cannot redeem same once-code twice
    if (dc.usage_mode === "once") {
      const { data: ownRedemption } = await supabase
        .from("discount_code_redemptions")
        .select("id")
        .eq("discount_code_id", dc.id)
        .eq("company_id", company_id)
        .limit(1);

      if (ownRedemption && ownRedemption.length > 0) {
        return respond({ valid: false, reason_code: "ALREADY_USED", german_message: "Dieser Rabattcode wurde bereits verwendet.", discount_amount: 0, final_price: current_price, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null });
      }
    }

    // Calculate discount amount
    // current_price is price after fleet + yearly discount (the base to apply code to)
    let discountAmount = 0;

    if (dc.discount_type === "percentage") {
      const pct = Math.min(100, Math.max(0, Number(dc.discount_value)));
      discountAmount = current_price * (pct / 100);
    } else {
      // fixed
      if (dc.usage_mode === "monthly") {
        if (billing_cycle === "yearly") {
          discountAmount = Number(dc.discount_value) * 12;
        } else {
          discountAmount = Number(dc.discount_value);
        }
      } else {
        // once
        discountAmount = Number(dc.discount_value);
      }
    }

    const finalPrice = Math.max(0, current_price - discountAmount);
    discountAmount = current_price - finalPrice; // recalculate in case capped at 0

    return respond({
      valid: true,
      reason_code: "OK",
      german_message: "Rabattcode erfolgreich angewendet.",
      discount_amount: discountAmount,
      final_price: finalPrice,
      discount_code_id: dc.id,
      usage_mode: dc.usage_mode,
      discount_type: dc.discount_type,
      discount_value: Number(dc.discount_value),
    });

  } catch (err: unknown) {
    // `_error` used to carry err.message to the browser. This runs with the
    // service-role key, so that message could be a Postgres error naming a
    // column or a constraint. The detail goes to the log instead; request_id is
    // what lets a support report be matched to the log line.
    const requestId = crypto.randomUUID().slice(0, 8);
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(JSON.stringify({ level: "error", fn: "validate-discount-code", requestId, detail }));
    return new Response(
      JSON.stringify({ valid: false, reason_code: "ERROR", german_message: "Ein Fehler ist aufgetreten.", discount_amount: 0, final_price: 0, discount_code_id: null, usage_mode: null, discount_type: null, discount_value: null, request_id: requestId }),
      { status: 500, headers: { ...corsFor(req), "Content-Type": "application/json" } }
    );
  }
});
