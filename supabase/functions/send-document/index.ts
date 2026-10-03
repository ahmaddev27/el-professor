/**
 * Sends a document this product produced to the person it is about.
 *
 * Today that is one kind — the weekly Abrechnung to its driver — and the name is
 * general on purpose: the Gehaltsquittung and the Stundennachweis are the obvious
 * next ones, and each is a `kind` here rather than another function with another
 * line in `FUNCTION_ENV` and another service in the compose file.
 *
 * ## The rule that makes this safe, and it is one line
 *
 * **The recipient's address is never taken from the request.** It is read out of
 * `public.drivers`, by id, scoped to the caller's own company. A body that names
 * an address is ignored; a body that names a driver of another company is refused
 * before anything is rendered. This is the `oauth-account` rule — "every `oauth_*`
 * RPC it calls receives that caller's user id, never one from the body" — applied
 * to the one thing that decides where a person's financial figures land.
 *
 * It is **not** in `PUBLIC_FUNCTIONS`: it needs a session, and the router's check
 * proves only that the caller holds a token this stack signed, which every
 * signed-in customer does. The tenancy check below is the authorization.
 *
 * ## What it does take from the request, and why that is right
 *
 * The figures and the image. Both come from the screen that showed them to the
 * operator, and that is deliberate: the mail and the attached card **must agree**,
 * and they can only agree by coming from one place. Computing the figures here
 * would mean the image (the browser's) and the numbers (this function's) could
 * differ, which is worse than either being wrong alone.
 *
 * What that costs is that a caller could send their own driver a wrong figure.
 * They could also write it on paper. The company's own administrator mailing
 * their own driver is not the threat this guards against; sending one driver's
 * money to another driver's address is, and that is what the lookup closes.
 *
 * ## One driver per call
 *
 * "Send to all" is the browser looping, not a list here. One call per driver
 * means one result per driver — sent, skipped for want of an address, or failed —
 * which is what the confirmation screen reports. A list in one call would have to
 * invent a way to report a partial failure, and partial is the normal case.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor } from "../_shared/http.ts";
import { sendMail } from "../_shared/mail.ts";
import {
  attachmentName,
  renderAbrechnungMail,
  type AbrechnungFigures,
} from "../_shared/abrechnung-mail.ts";

interface SendRequest {
  kind?: string;
  driver_id?: string;
  period_label?: string;
  period_range?: string;
  figures?: Partial<AbrechnungFigures>;
  /** The card as a PNG, base64, without a data: prefix. */
  image_base64?: string;
}

/** 4 MB of base64 is about 3 MB of PNG — far above any card this screen renders. */
const MAX_IMAGE_BASE64 = 4 * 1024 * 1024;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The figures, read strictly: a missing one is a broken request, not a zero. */
function readFigures(input: Partial<AbrechnungFigures> | undefined): AbrechnungFigures | null {
  if (!input) return null;
  const cash = finiteNumber(input.cash);
  const belege = finiteNumber(input.belege);
  const difference = finiteNumber(input.difference);
  const belegeCount = finiteNumber(input.belegeCount);
  if (cash === null || belege === null || difference === null || belegeCount === null) return null;
  // The Tankenquote is the one figure the screen itself may not have.
  const tankenquote = input.tankenquote === null || input.tankenquote === undefined
    ? null
    : finiteNumber(input.tankenquote);
  if (input.tankenquote !== null && input.tankenquote !== undefined && tankenquote === null) {
    return null;
  }
  return { cash, belege, difference, belegeCount: Math.round(belegeCount), tankenquote };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsFor(req) });
  }

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsFor(req), "Content-Type": "application/json" },
    });

  if (req.method !== "POST") return respond({ ok: false, reason: "method_not_allowed" }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return respond({ ok: false, reason: "not_authenticated" }, 401);
  }

  let body: SendRequest;
  try {
    body = await req.json() as SendRequest;
  } catch {
    return respond({ ok: false, reason: "invalid_request" }, 400);
  }

  if (body.kind !== "abrechnung") return respond({ ok: false, reason: "unknown_kind" }, 400);
  if (typeof body.driver_id !== "string" || body.driver_id.trim() === "") {
    return respond({ ok: false, reason: "invalid_request" }, 400);
  }
  const periodLabel = (body.period_label ?? "").trim();
  const periodRange = (body.period_range ?? "").trim();
  if (periodLabel === "" || periodRange === "") {
    return respond({ ok: false, reason: "invalid_request" }, 400);
  }

  const figures = readFigures(body.figures);
  if (!figures) return respond({ ok: false, reason: "invalid_figures" }, 400);

  const image = (body.image_base64 ?? "").replace(/\s+/g, "");
  if (image.length > MAX_IMAGE_BASE64) {
    return respond({ ok: false, reason: "image_too_large" }, 413);
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!url || !serviceKey || !anonKey) {
    return respond({ ok: false, reason: "not_configured" }, 500);
  }

  // The caller, resolved from their own token. Never from the body.
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: userData, error: userError } = await asCaller.auth.getUser();
  if (userError || !userData?.user) {
    return respond({ ok: false, reason: "not_authenticated" }, 401);
  }

  const admin = createClient(url, serviceKey);

  const { data: profile, error: profileError } = await admin
    .from("user_profiles")
    .select("company_id, status")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (profileError) return respond({ ok: false, reason: "profile_unavailable" }, 500);
  // A company-less account is platform staff, and a platform account does not mail
  // a customer's driver on their behalf. The company's own people do that.
  if (!profile?.company_id) return respond({ ok: false, reason: "no_company" }, 403);
  if (profile.status && profile.status !== "active") {
    return respond({ ok: false, reason: "account_not_active" }, 403);
  }

  // ── The one rule: the address comes from the database, scoped to the caller's
  //    company. A driver of another company is not found, and "not found" is the
  //    same answer as "no such driver" — it tells a prober nothing.
  const { data: driver, error: driverError } = await admin
    .from("drivers")
    .select("id, name, email")
    .eq("id", body.driver_id)
    .eq("company_id", profile.company_id)
    .maybeSingle();
  if (driverError) return respond({ ok: false, reason: "driver_unavailable" }, 500);
  if (!driver) return respond({ ok: false, reason: "driver_not_found" }, 404);

  const address = (driver.email ?? "").trim();
  if (address === "") {
    // Not an error: a driver without an address is ordinary, and the screen names
    // them in its confirmation rather than guessing one.
    return respond({ ok: false, reason: "driver_has_no_email", driver_name: driver.name }, 200);
  }

  const { data: company } = await admin
    .from("companies")
    .select("name")
    .eq("id", profile.company_id)
    .maybeSingle();

  const mail = renderAbrechnungMail({
    driverName: driver.name,
    companyName: (company?.name ?? "").trim() || "—",
    periodLabel,
    periodRange,
    figures,
    appUrl: Deno.env.get("APP_URL") ?? "",
  });

  try {
    await sendMail({
      to: address,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      attachments: image
        ? [{
          filename: attachmentName(periodLabel),
          contentType: "image/png",
          content: image,
        }]
        : undefined,
    });
  } catch (error) {
    console.error("send-document: sending failed", error);
    return respond({ ok: false, reason: "send_failed", driver_name: driver.name }, 502);
  }

  return respond({ ok: true, driver_name: driver.name, to: address });
});
