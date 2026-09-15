import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor } from "../_shared/http.ts";
import { mailActivationCode, type ActivationCodeDelivery } from "../_shared/activation-code-delivery.ts";
import { generateCode, secureRandomUint32 } from "../_shared/otp-core.ts";
import {
  auditedPlatformWrite,
  platformCan,
  recordPlatformAudit,
  type PlatformAuditEntry,
  type PlatformAuditSubject,
} from "../_shared/platform-access.ts";

interface GenerateRequest {
  company_id?: string | null;
  target_email?: string | null;
  duration_type: "1_monat" | "3_monate" | "1_jahr" | "benutzerdefiniert";
  custom_days?: number | null;
  custom_expires_at?: string | null;
}

const AUDIT_ACTION = "activation_code.generate";

async function sha256hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

  // Set once the caller is authorized, until the audited write takes over its
  // rows: a failure in between, a malformed body included, is recorded as an
  // error of the platform action it interrupted.
  let recordFailure: (() => Promise<unknown>) | null = null;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return respond({ success: false, error: "Nicht authentifiziert." }, 401);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // The caller's own JWT: platform_can and platform_audit_record answer for
    // whoever that token belongs to.
    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: authHeader } },
      }
    );

    const { data: { user }, error: userErr } = await supabaseUser.auth.getUser();
    if (userErr || !user) return respond({ success: false, error: "Nicht authentifiziert." }, 401);

    // Best-effort rows, for a refusal or a request that never reaches the write.
    const audit = (entry: Omit<PlatformAuditEntry, "category" | "action">) =>
      recordPlatformAudit(supabaseUser, { category: "write", action: AUDIT_ACTION, ...entry });

    if (!(await platformCan(supabaseUser, "codes.manage"))) {
      await audit({ outcome: "denied" });
      return respond({ success: false, error: "Keine Berechtigung." }, 403);
    }

    recordFailure = () => audit({ outcome: "error" });

    const body: GenerateRequest = await req.json();
    const companyId = body.company_id ? body.company_id : null;

    if (!["1_monat", "3_monate", "1_jahr", "benutzerdefiniert"].includes(body.duration_type)) {
      recordFailure = null;
      await audit({ outcome: "error", companyId, after: { reason: "invalid_duration" } });
      return respond({ success: false, error: "Ungültige Dauer." }, 400);
    }

    // ── Generate 6-digit code ────────────────────────────────────────────────
    // crypto.getRandomValues with rejection sampling, the same generator as the
    // one-time codes: every code equally likely, none predictable.
    const rawCode = generateCode(secureRandomUint32);

    const codeHash = await sha256hex(rawCode);
    const codeLast4 = rawCode.slice(-4);

    // ── Code expires in 2 minutes ────────────────────────────────────────────
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000);

    const insertRow: Record<string, unknown> = {
      code_hash:     codeHash,
      code_last4:    codeLast4,
      duration_type: body.duration_type,
      expires_at:    expiresAt.toISOString(),
      created_by:    user.id,
      status:        "active",
    };

    if (companyId) insertRow.company_id = companyId;
    if (body.target_email?.trim()) insertRow.target_email = body.target_email.trim().toLowerCase();

    if (body.duration_type === "benutzerdefiniert") {
      if (body.custom_days != null) insertRow.custom_days = body.custom_days;
      if (body.custom_expires_at) insertRow.custom_expires_at = body.custom_expires_at;
    }

    // Never the code, any part of it or an address; whether it is bound and
    // whether the mail went out says enough.
    const subject: PlatformAuditSubject = {
      category: "write",
      action: AUDIT_ACTION,
      companyId,
      targetType: "activation_code",
      after: {
        duration_type: body.duration_type,
        expires_at: expiresAt.toISOString(),
        bound_to_company: !!companyId,
        bound_to_email: typeof insertRow.target_email === "string",
      },
    };
    let codeId: string | null = null;
    let delivery: ActivationCodeDelivery | null = null;

    // No code is stored, and none is mailed, unless the attempt row is written.
    recordFailure = null;
    await auditedPlatformWrite(supabaseUser, subject, async () => {
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from("activation_codes")
        .insert(insertRow)
        .select("id")
        .single();

      if (insertErr) throw new Error(insertErr.message);
      codeId = inserted.id;

      // The code exists now. The mail never throws, and a failed one leaves the
      // code as it is: the screen still shows it.
      delivery = await mailActivationCode(supabaseAdmin, {
        code:            rawCode,
        companyId:       typeof insertRow.company_id === "string" ? insertRow.company_id : null,
        targetEmail:     typeof insertRow.target_email === "string" ? insertRow.target_email : null,
        durationType:    body.duration_type,
        customDays:      typeof insertRow.custom_days === "number" ? insertRow.custom_days : null,
        customExpiresAt: typeof insertRow.custom_expires_at === "string" ? insertRow.custom_expires_at : null,
        expiresAt,
      });
    }, {
      details: () => ({
        targetId: codeId,
        after: {
          ...subject.after,
          ...(delivery ? { mail_sent: delivery.mailSent, recipient_count: delivery.recipientCount } : {}),
        },
      }),
    });

    const sent = delivery as ActivationCodeDelivery | null;
    return respond({
      success:         true,
      code:            rawCode,           // plain text — shown once only
      code_id:         codeId,
      expires_at:      expiresAt.toISOString(),
      mail_sent:       sent?.mailSent ?? false,
      recipient_count: sent?.recipientCount ?? 0,
    });
  } catch (err: unknown) {
    if (recordFailure) await recordFailure();
    // Every message meant for the caller is returned explicitly above. Anything
    // that reaches here is a database or runtime error, or an audit row that
    // could not be written (the code was then never stored), and this function
    // holds the service-role key — so it is logged, not returned.
    const requestId = crypto.randomUUID().slice(0, 8);
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(JSON.stringify({ level: "error", fn: "generate-activation-code", requestId, detail }));
    return respond({
      success: false,
      error: "Es ist ein interner Fehler aufgetreten. Bitte versuchen Sie es erneut.",
      request_id: requestId,
    }, 500);
  }
});
