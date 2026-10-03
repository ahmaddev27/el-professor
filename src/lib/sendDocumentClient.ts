/**
 * Mailing a document to the person it is about, from the browser.
 *
 * One call per driver, deliberately. "Send to all" is the caller looping over
 * this, not a list sent in one request — so there is one answer per driver, and
 * the screen can report *sent*, *skipped for want of an address* and *failed*
 * side by side. Partial is the normal case for a bulk send, and a single call
 * returning a list would have to invent a way to say so.
 *
 * ## What this module does not decide
 *
 * The recipient. The function reads the driver's address out of the database,
 * scoped to the caller's own company, and ignores anything a body says about it.
 * Nothing here can name an address, which is why nothing here can send one
 * driver's figures to another driver's inbox.
 */
import { supabase } from './supabase';

export interface AbrechnungFiguresPayload {
  cash: number;
  belege: number;
  difference: number;
  belegeCount: number;
  tankenquote: number | null;
}

export interface SendAbrechnungRequest {
  driverId: string;
  /** "Woche 5" / "Woche 5 - August 2026", as the screen labels it. */
  periodLabel: string;
  /** "31.08.2026 – 06.09.2026". Already German, already formatted. */
  periodRange: string;
  figures: AbrechnungFiguresPayload;
  /** The card as a PNG, base64, without a `data:` prefix. Empty sends no file. */
  imageBase64: string;
}

/**
 * Why a send did not happen, as a stable code the screen turns into a sentence.
 *
 * `driver_has_no_email` is **not a failure** — a driver without an address is
 * ordinary, and the owner asked for those drivers to be named rather than passed
 * over in silence. It is separated from the error codes for that reason.
 */
export type SendRefusal =
  | 'driver_has_no_email'
  | 'driver_not_found'
  | 'no_company'
  | 'account_not_active'
  | 'invalid_request'
  | 'invalid_figures'
  | 'image_too_large'
  | 'send_failed'
  | 'not_authenticated'
  | 'not_configured'
  | 'network';

export interface SendResult {
  ok: boolean;
  /** The driver as the function names them, for a message about one row. */
  driverName: string | null;
  reason: SendRefusal | null;
}

/** A PNG blob as the function takes it: base64, no `data:` prefix. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Chunked: `String.fromCharCode(...bytes)` on a few hundred kilobytes exceeds
  // the argument limit and throws, which would read as a failed send.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function sendAbrechnungMail(request: SendAbrechnungRequest): Promise<SendResult> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return { ok: false, driverName: null, reason: 'not_authenticated' };

  try {
    const response = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-document`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          kind: 'abrechnung',
          driver_id: request.driverId,
          period_label: request.periodLabel,
          period_range: request.periodRange,
          figures: request.figures,
          image_base64: request.imageBase64,
        }),
      },
    );

    const body = await response.json().catch(() => null) as
      { ok?: boolean; reason?: string; driver_name?: string } | null;

    if (body?.ok) {
      return { ok: true, driverName: body.driver_name ?? null, reason: null };
    }
    return {
      ok: false,
      driverName: body?.driver_name ?? null,
      // An unrecognised reason reads as a failed send rather than as nothing: a
      // caller must never show "sent" for an answer it could not parse.
      reason: (body?.reason as SendRefusal | undefined) ?? 'send_failed',
    };
  } catch {
    return { ok: false, driverName: null, reason: 'network' };
  }
}
