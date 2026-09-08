import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ApplyRequest {
  discount_code_id: string;
  company_id: string;
  user_id: string;
  plan: string;
  billing_cycle: string;
  car_limit: number;
  original_price: number;
  discount_amount: number;
  final_price: number;
  usage_mode: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const body: ApplyRequest = await req.json();
    const { discount_code_id, company_id, user_id, plan, billing_cycle, car_limit, original_price, discount_amount, final_price, usage_mode } = body;

    // For monthly usage_mode: check if company already has this code active (avoid duplicate redemption rows)
    if (usage_mode === "monthly") {
      const { data: existing } = await supabase
        .from("discount_code_redemptions")
        .select("id")
        .eq("discount_code_id", discount_code_id)
        .eq("company_id", company_id)
        .limit(1);

      if (existing && existing.length > 0) {
        // Already recorded — just update the company active_discount columns without inserting a new redemption
        await supabase
          .from("companies")
          .update({
            active_discount_code_id: discount_code_id,
            active_discount_usage_mode: usage_mode,
            active_discount_started_at: new Date().toISOString(),
          })
          .eq("id", company_id);

        return new Response(JSON.stringify({ success: true, already_active: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Insert redemption record
    const { error: redemptionErr } = await supabase
      .from("discount_code_redemptions")
      .insert({
        discount_code_id,
        company_id,
        user_id,
        plan,
        billing_cycle,
        car_limit,
        original_price,
        discount_amount,
        final_price,
        usage_mode,
      });

    if (redemptionErr) throw new Error(redemptionErr.message);

    // Increment used_count on the discount code
    await supabase.rpc("increment_discount_used_count", { code_id: discount_code_id });

    // Update company active discount tracking
    await supabase
      .from("companies")
      .update({
        active_discount_code_id: discount_code_id,
        active_discount_usage_mode: usage_mode,
        active_discount_started_at: new Date().toISOString(),
      })
      .eq("id", company_id);

    return new Response(JSON.stringify({ success: true, already_active: false }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unbekannter Fehler";
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
