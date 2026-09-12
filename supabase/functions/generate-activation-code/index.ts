import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor } from "../_shared/http.ts";

interface GenerateRequest {
  company_id?: string | null;
  target_email?: string | null;
  duration_type: "1_monat" | "3_monate" | "1_jahr" | "benutzerdefiniert";
  custom_days?: number | null;
  custom_expires_at?: string | null;
}

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

  try {
    // ── Auth: only super admins may generate codes ───────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return respond({ success: false, error: "Nicht authentifiziert." }, 401);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Verify caller is super admin
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

    const { data: profile } = await supabaseAdmin
      .from("user_profiles")
      .select("is_super_admin")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!profile?.is_super_admin) {
      return respond({ success: false, error: "Keine Berechtigung." }, 403);
    }

    const body: GenerateRequest = await req.json();

    if (!["1_monat", "3_monate", "1_jahr", "benutzerdefiniert"].includes(body.duration_type)) {
      return respond({ success: false, error: "Ungültige Dauer." }, 400);
    }

    // ── Generate 6-digit code ────────────────────────────────────────────────
    const rawCode = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0");

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

    if (body.company_id) insertRow.company_id = body.company_id;
    if (body.target_email?.trim()) insertRow.target_email = body.target_email.trim().toLowerCase();

    if (body.duration_type === "benutzerdefiniert") {
      if (body.custom_days != null) insertRow.custom_days = body.custom_days;
      if (body.custom_expires_at) insertRow.custom_expires_at = body.custom_expires_at;
    }

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from("activation_codes")
      .insert(insertRow)
      .select("id")
      .single();

    if (insertErr) throw new Error(insertErr.message);

    return respond({
      success:    true,
      code:       rawCode,           // plain text — shown once only
      code_id:    inserted.id,
      expires_at: expiresAt.toISOString(),
    });
  } catch (err: unknown) {
    // Every message meant for the caller is returned explicitly above. Anything
    // that reaches here is a database or runtime error, and this function holds
    // the service-role key — so it is logged, not returned.
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
