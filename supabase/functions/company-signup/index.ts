import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

type Plan = 'basic' | 'advanced' | 'premium';

type BillingCycle = 'monthly' | 'yearly';

interface SignupRequest {
  company_name: string;
  full_name: string;
  email: string;
  password: string;
  plan?: Plan;
  billing_cycle?: BillingCycle;
  subscription_car_limit?: number;
  discount_code_id?: string | null;
  discount_usage_mode?: string | null;
  referral_code?: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const body: SignupRequest = await req.json();

    if (!body.company_name?.trim()) throw new Error("Unternehmensname ist erforderlich");
    if (!body.full_name?.trim()) throw new Error("Name ist erforderlich");
    if (!body.email?.trim()) throw new Error("E-Mail ist erforderlich");
    if (!body.password || body.password.length < 8) throw new Error("Passwort muss mindestens 8 Zeichen haben");

    const plan: Plan = (['basic', 'advanced', 'premium'] as Plan[]).includes(body.plan as Plan)
      ? (body.plan as Plan)
      : 'basic';

    const billingCycle: BillingCycle =
      body.billing_cycle === 'yearly' ? 'yearly' : 'monthly';

    const carLimit = Math.max(1, Math.min(100, Math.floor(Number(body.subscription_car_limit) || 3)));

    // Validate referral code if provided
    let referralId: string | null = null;
    const rawReferralCode = body.referral_code?.trim().toUpperCase() ?? null;

    if (rawReferralCode) {
      const { data: referral } = await supabaseAdmin
        .from("referrals")
        .select("id, is_active")
        .eq("ref_code", rawReferralCode)
        .maybeSingle();

      if (!referral) {
        throw new Error(`Empfehlungscode "${rawReferralCode}" ist ungültig.`);
      }
      if (!referral.is_active) {
        throw new Error(`Empfehlungscode "${rawReferralCode}" ist nicht mehr aktiv.`);
      }
      referralId = referral.id;
    }

    // 1. Create auth user — email_confirm: true marks email as already verified
    //    so the user can sign in immediately without a confirmation link.
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: body.email.trim(),
      password: body.password,
      email_confirm: true,
      user_metadata: { full_name: body.full_name.trim() },
    } as any);

    if (authError) {
      if (authError.message?.toLowerCase().includes("already registered") ||
          authError.message?.toLowerCase().includes("already been registered") ||
          authError.message?.toLowerCase().includes("duplicate")) {
        throw new Error("Diese E-Mail-Adresse ist bereits registriert");
      }
      throw new Error(authError.message);
    }

    if (!authData.user) throw new Error("Benutzer konnte nicht erstellt werden");
    const userId = authData.user.id;

    // 2. Generate a URL-safe slug from the company name
    const slug = body.company_name.trim()
      .toLowerCase()
      .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" }[c] ?? c))
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);

    // Ensure slug is unique by appending a short random suffix if taken
    const { data: existing } = await supabaseAdmin
      .from("companies")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    const finalSlug = existing
      ? `${slug}-${Math.random().toString(36).slice(2, 7)}`
      : slug;

    const now = new Date();
    const trialEnd = new Date(now);
    trialEnd.setDate(trialEnd.getDate() + 14);

    // 3. Create the company — pending approval, trial status
    const companyInsert: Record<string, unknown> = {
      name: body.company_name.trim(),
      slug: finalSlug,
      status: "trial",
      approval_status: "pending",
      plan,
      billing_cycle: billingCycle,
      subscription_car_limit: carLimit,
      trial_start: now.toISOString(),
      trial_end: trialEnd.toISOString(),
      country: "Deutschland",
      subscription_status: "inactive",
    };

    if (body.discount_code_id) {
      companyInsert.active_discount_code_id = body.discount_code_id;
      companyInsert.active_discount_usage_mode = body.discount_usage_mode ?? null;
      companyInsert.active_discount_started_at = now.toISOString();
    }

    if (referralId) {
      companyInsert.referral_id = referralId;
      companyInsert.referral_code_used = rawReferralCode;
      companyInsert.referred_at = now.toISOString();
    }

    const { data: company, error: companyError } = await supabaseAdmin
      .from("companies")
      .insert(companyInsert)
      .select()
      .single();

    if (companyError) throw new Error(`Unternehmen konnte nicht erstellt werden: ${companyError.message}`);

    // 4. Upsert the user profile with admin role + company link
    //    The handle_new_user trigger may have already inserted a minimal row.
    const { error: profileError } = await supabaseAdmin
      .from("user_profiles")
      .upsert({
        user_id: userId,
        email: body.email.trim(),
        full_name: body.full_name.trim(),
        role: "admin",
        company_id: company.id,
        status: "active",
        is_super_admin: false,
      }, { onConflict: "user_id" });

    if (profileError) {
      console.error("Profile upsert error:", profileError.message);
    }

    // 5. Create a default company_settings row so the app has something to read
    await supabaseAdmin
      .from("company_settings")
      .insert({
        company_id: company.id,
        company_name: body.company_name.trim(),
      })
      .select()
      .maybeSingle();

    return new Response(
      JSON.stringify({
        success: true,
        company: {
          id: company.id,
          name: company.name,
          slug: company.slug,
          trial_end: company.trial_end,
          approval_status: company.approval_status,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unbekannter Fehler";
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  }
});
