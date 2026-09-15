/**
 * POST /functions/v1/company-signup: create a company and its owner's account.
 *
 * Public (see PUBLIC_FUNCTIONS in main/index.ts): nobody has a session yet.
 *
 * The order is what keeps a half-made signup from surviving:
 *
 *   1. validate the input, and check a referral code before anything is created
 *   2. signup_discard_unverified: a signup nobody verified may not squat the
 *      address, so a newer attempt replaces it (codes sent to it die with it)
 *   3. createUser with email_confirm: false. GoTrue refuses a password login for
 *      an unconfirmed address whatever GOTRUE_MAILER_AUTOCONFIRM says (probed
 *      against v2.170.0 on 15.09.2026), so the owner cannot sign in before
 *      entering the code
 *   4. signup_create_company: company, owner profile (pending_invite), settings
 *      and the pending-signup row in one transaction. If it fails or refuses,
 *      the login from step 3 is discarded. A success is never returned without
 *      both a company and a profile
 *   5. send the signup_verify code
 *
 * The signup stands even when the code cannot be sent; the page offers "Neuen
 * Code senden". A discount code is stored with the pending signup and redeemed
 * only when the code is verified (otp-verify), so a limited code is not used up
 * by signups nobody finishes.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { UserError, corsFor, json, errorResponse } from "../_shared/http.ts";
import { issueAndSendOtp, serviceClient } from "../_shared/otp.ts";
import {
  isEmailExistsError,
  logFailure,
  OTP_COOLDOWN_SECONDS,
  parseClientIp,
  parseEmail,
} from "../_shared/otp-core.ts";

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
  /**
   * The code the user typed. The previous fields — discount_code_id and
   * discount_usage_mode — were taken from the browser and written straight
   * onto the company, so a modified client could name any code it liked and
   * no redemption was ever recorded. Both are ignored now.
   */
  discount_code?: string | null;
  referral_code?: string | null;
}

interface CompanySummary {
  id: string;
  name: string;
  slug: string;
  /** Always null since 20260916160000: the trial starts when its code is redeemed. */
  trial_end: string | null;
  approval_status: string;
}

interface VerificationSummary {
  status: 'sent' | 'send_failed' | 'rate_limited';
  cooldown_seconds: number;
  retry_after_seconds: number | null;
}

const FN = "company-signup";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsFor(req) });
  }

  try {
    let body: SignupRequest;
    try {
      body = await req.json();
    } catch {
      throw new UserError("Ungültige Anfrage.");
    }
    if (!body || typeof body !== "object") throw new UserError("Ungültige Anfrage.");

    const companyName = typeof body.company_name === "string" ? body.company_name.trim() : "";
    const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
    if (!companyName) throw new UserError("Unternehmensname ist erforderlich");
    if (!fullName) throw new UserError("Name ist erforderlich");
    if (typeof body.email !== "string" || !body.email.trim()) throw new UserError("E-Mail ist erforderlich");
    const email = parseEmail(body.email);
    if (!email) throw new UserError("Bitte geben Sie eine gültige E-Mail-Adresse ein.");
    if (typeof body.password !== "string" || body.password.length < 8) {
      throw new UserError("Passwort muss mindestens 8 Zeichen haben");
    }

    const plan: Plan = (['basic', 'advanced', 'premium'] as Plan[]).includes(body.plan as Plan)
      ? (body.plan as Plan)
      : 'basic';
    const billingCycle: BillingCycle = body.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
    const carLimit = Math.max(1, Math.min(100, Math.floor(Number(body.subscription_car_limit) || 3)));
    const referralCode = typeof body.referral_code === "string" ? body.referral_code.trim().toUpperCase() : "";
    const discountCode = typeof body.discount_code === "string" ? body.discount_code.trim() : "";

    if (referralCode) await assertReferralUsable(referralCode);

    const admin = serviceClient();
    const { error: discardError } = await admin.rpc("signup_discard_unverified", { p_email: email });
    if (discardError) throw discardError;

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password: body.password,
      email_confirm: false,
      user_metadata: { full_name: fullName },
    });
    if (createError) {
      if (isEmailExistsError(createError) || /duplicate/i.test(createError.message ?? "")) {
        throw new UserError("Diese E-Mail-Adresse ist bereits registriert", 409, "email_taken");
      }
      throw createError;
    }
    if (!created.user) throw new Error("createUser returned no user");
    const userId = created.user.id;

    const company = await createCompany(userId, {
      email, fullName, companyName, plan, billingCycle, carLimit, referralCode, discountCode,
    });

    const verification = await sendVerificationCode(email, userId, parseClientIp(req.headers.get("x-client-ip")));

    return json(req, 200, { success: true, company, verification });
  } catch (err: unknown) {
    return errorResponse(req, err, FN);
  }
});

function referralRefusal(reason: unknown, code: string): UserError | null {
  if (reason === "referral_invalid") {
    return new UserError(`Empfehlungscode "${code}" ist ungültig.`, 400, "referral_invalid");
  }
  if (reason === "referral_inactive") {
    return new UserError(`Empfehlungscode "${code}" ist nicht mehr aktiv.`, 400, "referral_inactive");
  }
  return null;
}

/** Refuses an unknown or inactive referral code before any account exists. */
async function assertReferralUsable(code: string): Promise<void> {
  if (code.length > 64) throw referralRefusal("referral_invalid", code.slice(0, 64))!;
  const { data, error } = await serviceClient()
    .from("referrals")
    .select("id, is_active")
    .eq("ref_code", code)
    .maybeSingle();
  if (error) throw error;
  const refusal = referralRefusal(!data ? "referral_invalid" : data.is_active ? null : "referral_inactive", code);
  if (refusal) throw refusal;
}

async function createCompany(
  userId: string,
  input: {
    email: string; fullName: string; companyName: string; plan: Plan; billingCycle: BillingCycle;
    carLimit: number; referralCode: string; discountCode: string;
  },
): Promise<CompanySummary> {
  let result: { ok?: unknown; reason?: unknown; company?: CompanySummary } | null;
  try {
    const { data, error } = await serviceClient().rpc("signup_create_company", {
      p_user_id: userId,
      p_email: input.email,
      p_full_name: input.fullName,
      p_company_name: input.companyName,
      p_plan: input.plan,
      p_billing_cycle: input.billingCycle,
      p_car_limit: input.carLimit,
      p_referral_code: input.referralCode || null,
      p_discount_code: input.discountCode || null,
    });
    if (error) throw error;
    result = data;
  } catch (err) {
    await discardSignup(userId);
    throw err;
  }

  const company = result?.company;
  if (result?.ok === true && company) {
    return {
      id: company.id,
      name: company.name,
      slug: company.slug,
      trial_end: company.trial_end,
      approval_status: company.approval_status,
    };
  }
  await discardSignup(userId);
  // The referral can have been deactivated between the pre-check and the
  // transaction; the database's answer is the one that counts.
  throw referralRefusal(result?.reason, input.referralCode) ??
    new Error("signup_create_company returned a result outside the contract");
}

/**
 * Undoes a signup that could not be completed, so no login survives without a
 * company and a profile. signup_discard removes all three in one transaction;
 * if it cannot, the login is deleted directly.
 */
async function discardSignup(userId: string): Promise<void> {
  const admin = serviceClient();
  try {
    const { data, error } = await admin.rpc("signup_discard", { p_user_id: userId });
    if (error) throw error;
    if (data === true) return;
    logFailure(FN, "compensate_signup_discard", { user_id: userId }, new Error("signup_discard refused"));
  } catch (err) {
    logFailure(FN, "compensate_signup_discard", { user_id: userId }, err);
  }
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) logFailure(FN, "compensate_delete_user", { user_id: userId }, error);
}

/** Sends the first code. Never throws: the signup already stands. */
async function sendVerificationCode(email: string, userId: string, clientIp: string | null): Promise<VerificationSummary> {
  try {
    const outcome = await issueAndSendOtp({ purpose: "signup_verify", email, clientIp });
    if (outcome.status === "sent") {
      return { status: "sent", cooldown_seconds: OTP_COOLDOWN_SECONDS, retry_after_seconds: null };
    }
    if (outcome.status === "rate_limited") {
      return {
        status: "rate_limited",
        cooldown_seconds: OTP_COOLDOWN_SECONDS,
        retry_after_seconds: outcome.retryAfterSeconds ?? OTP_COOLDOWN_SECONDS,
      };
    }
  } catch (err) {
    logFailure(FN, "issue_signup_code", { purpose: "signup_verify", user_id: userId }, err);
  }
  return { status: "send_failed", cooldown_seconds: OTP_COOLDOWN_SECONDS, retry_after_seconds: null };
}
