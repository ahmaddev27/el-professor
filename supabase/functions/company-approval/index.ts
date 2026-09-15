/**
 * POST /functions/v1/company-approval: a platform admin approves a company,
 * and the company's admins receive the approval mail with their trial code.
 *
 * Requires a session (not in PUBLIC_FUNCTIONS). The caller is authorized as a
 * platform admin the way generate-activation-code does it: a token GoTrue
 * accepts, and `user_profiles.is_super_admin`.
 *
 *   { "action": "approve", "company_id": "<uuid>" }
 *     company_approve sets the approval fields and, for a trial signup whose
 *     trial has not started and that holds no active subscription, creates the
 *     trial code in the same transaction. The mail follows.
 *     → { success, approved, already_approved, code_created, mail_sent, mail_error? }
 *
 *   { "action": "resend_trial_code", "company_id": "<uuid>" }
 *     For an approved company with an unused trial code: company_resend_trial_code
 *     revokes it and creates a new one, and the mail goes out again.
 *     → { success, code_created, mail_sent, mail_error? }
 *
 * The code is drawn here with crypto.getRandomValues and exists only in memory
 * until the mail is built. The database sees its hash; no response and no log
 * line carries the code or an address.
 *
 * An approval stands even when the mail cannot be sent: the answer says so,
 * and resend_trial_code sends a fresh code.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { UserError, corsFor, errorResponse, json } from "../_shared/http.ts";
import { generateActivationCode } from "../_shared/activation-code.ts";
import { buildApprovalMail } from "../_shared/approval-mail.ts";
import { sendMail } from "../_shared/mail.ts";
import { serviceClient, verifyAuthenticatedCaller } from "../_shared/otp.ts";
import { logFailure } from "../_shared/otp-core.ts";

const FN = "company-approval";

/** Draws of a fresh code before giving up; a six-digit collision is one in a million per existing code. */
const MAX_CODE_DRAWS = 3;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RPC_FOR_ACTION = {
  approve: "company_approve",
  resend_trial_code: "company_resend_trial_code",
} as const;

type Action = keyof typeof RPC_FOR_ACTION;

interface Issued {
  ok: true;
  alreadyApproved: boolean;
  codeCreated: boolean;
  companyName: string | null;
  trialDays: number;
  recipients: string[];
}

type DbResult = Issued | { ok: false; reason: string };

type MailOutcome = { sent: true } | { sent: false; error: "no_recipient" | "send_failed" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsFor(req) });
  }

  try {
    if (req.method !== "POST") throw new UserError("Methode nicht erlaubt.", 405);

    const actorId = await requirePlatformAdmin(req);
    const { action, companyId } = await readRequest(req);
    const requestId = crypto.randomUUID().slice(0, 8);

    const { result, code } = await runWithFreshCode(action, companyId, actorId);
    if (!result.ok) throw refusal(result.reason);

    if (action === "approve" && result.alreadyApproved) {
      return json(req, 200, {
        success: true, approved: true, already_approved: true, code_created: false, mail_sent: false,
      });
    }

    const mail = await sendApprovalMail(result, result.codeCreated ? code : null, { action, requestId });
    const delivery = mail.sent ? { mail_sent: true } : { mail_sent: false, mail_error: mail.error };

    if (action === "approve") {
      return json(req, 200, {
        success: true, approved: true, already_approved: false, code_created: result.codeCreated, ...delivery,
      });
    }
    return json(req, 200, { success: true, code_created: result.codeCreated, ...delivery });
  } catch (err: unknown) {
    return errorResponse(req, err, FN);
  }
});

/** The caller's user id, or a 401/403. */
async function requirePlatformAdmin(req: Request): Promise<string> {
  const caller = await verifyAuthenticatedCaller(req);
  if (!caller) throw new UserError("Nicht authentifiziert.", 401);

  const { data, error } = await serviceClient()
    .from("user_profiles")
    .select("is_super_admin")
    .eq("user_id", caller.userId)
    .maybeSingle();
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  if (data?.is_super_admin !== true) throw new UserError("Keine Berechtigung.", 403);
  return caller.userId;
}

async function readRequest(req: Request): Promise<{ action: Action; companyId: string }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new UserError("Ungültige Anfrage.");
  }
  const { action, company_id: companyId } = (body ?? {}) as { action?: unknown; company_id?: unknown };
  if (typeof action !== "string" || !Object.hasOwn(RPC_FOR_ACTION, action)) {
    throw new UserError("Ungültige Aktion.");
  }
  if (typeof companyId !== "string" || !UUID_PATTERN.test(companyId)) {
    throw new UserError("Ungültige Unternehmens-ID.");
  }
  return { action: action as Action, companyId: companyId.toLowerCase() };
}

/**
 * Calls the RPC with a newly drawn code, drawing again when its hash already
 * exists. The code is used only if the RPC reports that it created one.
 */
async function runWithFreshCode(
  action: Action,
  companyId: string,
  actorId: string,
): Promise<{ result: DbResult; code: string }> {
  for (let draw = 0; draw < MAX_CODE_DRAWS; draw++) {
    const generated = await generateActivationCode();
    const { data, error } = await serviceClient().rpc(RPC_FOR_ACTION[action], {
      p_company_id: companyId,
      p_actor_user_id: actorId,
      p_code_hash: generated.codeHash,
      p_code_last4: generated.codeLast4,
    });
    if (error) throw new Error(`${RPC_FOR_ACTION[action]} failed: ${error.code ?? ""} ${error.message}`);
    const result = asDbResult(data);
    if (!result.ok && result.reason === "code_collision") continue;
    return { result, code: generated.code };
  }
  throw new Error(`${RPC_FOR_ACTION[action]}: no unused code after ${MAX_CODE_DRAWS} draws`);
}

function asDbResult(data: unknown): DbResult {
  const value = (data ?? {}) as Record<string, unknown>;
  if (value.ok === false && typeof value.reason === "string") return { ok: false, reason: value.reason };

  const recipients = value.recipients;
  if (
    value.ok !== true
    || typeof value.code_created !== "boolean"
    || typeof value.trial_days !== "number"
    || !Array.isArray(recipients)
    || !recipients.every((entry) => typeof entry === "string")
  ) {
    throw new Error("company approval RPC returned a result outside the contract");
  }
  return {
    ok: true,
    alreadyApproved: value.already_approved === true,
    codeCreated: value.code_created,
    companyName: typeof value.company_name === "string" ? value.company_name : null,
    trialDays: value.trial_days,
    recipients: recipients as string[],
  };
}

function refusal(reason: string): UserError {
  switch (reason) {
    case "forbidden":
      return new UserError("Keine Berechtigung.", 403, "forbidden");
    case "not_found":
      return new UserError("Unternehmen nicht gefunden.", 404, "not_found");
    case "not_approved":
      return new UserError("Das Unternehmen ist nicht freigeschaltet.", 409, "not_approved");
    case "no_open_trial_code":
      return new UserError("Für dieses Unternehmen gibt es keinen offenen Testcode.", 409, "no_open_trial_code");
    default:
      throw new Error("company approval RPC refused with a reason outside the contract");
  }
}

/** Mails every recipient. Never throws; failures are logged without an address or the code. */
async function sendApprovalMail(
  result: Issued,
  code: string | null,
  context: { action: Action; requestId: string },
): Promise<MailOutcome> {
  const logContext = { request_id: context.requestId, purpose: context.action };
  if (result.recipients.length === 0) return { sent: false, error: "no_recipient" };

  let mail: ReturnType<typeof buildApprovalMail>;
  try {
    const appUrl = Deno.env.get("APP_URL");
    if (!appUrl) throw new Error("environment variable APP_URL is not set");
    mail = buildApprovalMail({ appUrl, companyName: result.companyName, code, trialDays: result.trialDays });
  } catch (err) {
    logFailure(FN, "build_mail", logContext, err);
    return { sent: false, error: "send_failed" };
  }

  let failures = 0;
  for (const to of result.recipients) {
    try {
      await sendMail({ to, ...mail });
    } catch (err) {
      failures++;
      logFailure(FN, "send_mail", logContext, err);
    }
  }
  return failures === 0 ? { sent: true } : { sent: false, error: "send_failed" };
}
