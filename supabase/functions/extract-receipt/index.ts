// Read a Beleg with an AI agent, for a caller who is allowed to.
//
// ─── Why this was rewritten ──────────────────────────────────────────────────
//
// This function was deployed and deliberately left without its API key, because
// as written it spent `ANTHROPIC_API_KEY` on any request carrying a token this
// stack signed — and the anon key is such a token and ships in the browser
// bundle. `deploy/docker-compose.yml` says so in as many words. It was called
// by nothing, so the exposure was bounded by that alone.
//
// The Reidey driver flow calls it: the driver photographs a Beleg, the agent
// reads it, and the driver confirms the reading before anything is stored. So
// the gap is closed first. Five things were wrong and only one was the session:
//
//   1. no authorization at all        → `receipt_ocr_allow()` (20261005110000)
//   2. Access-Control-Allow-Origin: * → `corsFor(req)`, the same helper as the
//                                        other functions
//   3. `req.json()` with no cap       → a declared-length check and a streaming
//                                        read that stops at the cap
//   4. `err.message` returned raw     → a fixed reason; the detail goes to the
//                                        log, which is where it belongs
//   5. no rate limit, and Kong has    → an hourly per-account budget, counted in
//      none on /functions/v1            the database like `otp_issue`'s
//
// ─── The authority ───────────────────────────────────────────────────────────
//
// **The caller's rights are asked of the database, never of the request.** One
// RPC answers whether this session may have a receipt read: a real subject (the
// anon key has none), a company `get_active_company_id()` admits, the
// `receipts` role gate, and the budget. It records every call, refused or not,
// so a refusal is visible rather than silent. The same shape as every other
// gate here — a return value, not an exception, so the row survives.
//
// It is NOT in `PUBLIC_FUNCTIONS`: the router's JWT check stays in front, and
// this is the authorization behind it.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.39.0";
import { corsFor } from "../_shared/http.ts";
import {
  MAX_IMAGE_BASE64,
  extractionPrompt,
  parseExtraction,
  requestProblem,
} from "../_shared/receipt-ocr-core.ts";

// Vision, fast and cheap — a Beleg is a short document and this runs once per
// photograph, per driver. Overridable so the model can move without a deploy of
// this file; the default is what ships.
const MODEL = Deno.env.get("RECEIPT_OCR_MODEL") ?? "claude-haiku-4-5-20251001";

/** The body ceiling, with room for the JSON envelope around the base64. */
const MAX_BODY_BYTES = MAX_IMAGE_BASE64 + 4096;

/**
 * Read the body, refusing anything over the cap without buffering it.
 *
 * `req.json()` would hold the whole image in the worker before any check could
 * run — the convention this follows is `_shared/otp-core.ts`'s `readBodyText`,
 * which checks the declared length, then cancels the reader the moment the
 * stream passes the cap.
 */
async function readBody(req: Request, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0 || n > maxBytes) return null;
  }
  if (!req.body) return null;

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    return null;
  }
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

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!url || !anonKey || !apiKey) {
    // Including the API key: with none configured this endpoint does nothing,
    // and saying so is better than failing later inside the SDK.
    return respond({ ok: false, reason: "not_configured" }, 500);
  }

  const raw = await readBody(req, MAX_BODY_BYTES);
  if (raw === null) return respond({ ok: false, reason: "image_too_large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return respond({ ok: false, reason: "invalid_request" }, 400);
  }

  const problem = requestProblem(body);
  if (problem !== null) {
    return respond({ ok: false, reason: problem }, problem === "image_too_large" ? 413 : 400);
  }
  const { imageBase64, mediaType } = body as { imageBase64: string; mediaType: string };

  // ── The gate. Asked of the database, as the caller, before a cent is spent ──
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: gate, error: gateError } = await asCaller.rpc("receipt_ocr_allow");
  if (gateError) {
    console.error("receipt_ocr.gate_unavailable", { message: gateError.message });
    return respond({ ok: false, reason: "gate_unavailable" }, 500);
  }
  const verdict = gate as { ok?: boolean; reason?: string } | null;
  if (!verdict?.ok) {
    const reason = verdict?.reason === "rate_limited" ? "rate_limited" : "not_authorized";
    return respond({ ok: false, reason }, reason === "rate_limited" ? 429 : 403);
  }

  // ── The read ───────────────────────────────────────────────────────────────
  let rawText: string;
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageBase64.replace(/\s+/g, "") },
          },
          { type: "text", text: extractionPrompt() },
        ],
      }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      console.error("receipt_ocr.no_text_block", { model: MODEL });
      return respond({ ok: false, reason: "read_failed" }, 502);
    }
    rawText = textBlock.text;
  } catch (err) {
    // The detail goes to the log, never to the caller: an SDK or upstream error
    // names hosts, models and sometimes a request body.
    console.error("receipt_ocr.upstream_failed", {
      model: MODEL,
      message: err instanceof Error ? err.message : String(err),
    });
    return respond({ ok: false, reason: "read_failed" }, 502);
  }

  const extracted = parseExtraction(rawText);
  if (extracted === null) {
    // Not an error the caller can act on differently, but distinguishable in
    // the log from an upstream failure.
    console.error("receipt_ocr.unparsable_answer", { model: MODEL });
    return respond({ ok: false, reason: "read_failed" }, 502);
  }

  // Every field is optional: the agent omits what it could not read, and the
  // driver's preview shows that as an empty field rather than a guess.
  return respond({ ok: true, data: extracted }, 200);
});
