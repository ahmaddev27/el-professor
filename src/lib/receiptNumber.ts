import { supabase } from './supabase';

/**
 * Where a Belegnummer comes from.
 *
 * It used to be built in the browser — `BEL-<Date.now()>-<4 digits>`, checked
 * against the receipts that tab happened to have loaded. With one writer that
 * is optimistic; with a second one it is wrong, and the partner intake path for
 * the Reidey driver app is exactly a second writer. `20261005100000` put the
 * number behind `public.receipt_number_next()`, which draws it under a partial
 * unique index on our own `BEL-` shape, and both writers call it.
 *
 * **The field stays editable** (owner's decision, 05.10.2026): 94 of the 1006
 * receipts on production carry the number printed on the merchant's receipt,
 * and two merchants may legitimately issue the same one. So the index — and
 * this function — cover only the numbers this system issues.
 *
 * `null` rather than a throw, because a Belegnummer the server could not draw
 * must not stop a person entering a receipt. The caller falls back to the local
 * shape and the index still refuses a genuine collision on write.
 */
export async function nextReceiptNumber(): Promise<string | null> {
  try {
    // No company is passed: `receipt_number_next` resolves it from the session
    // with `get_active_company_id()`, the same helper every tenant policy asks.
    // A company id taken from the browser would be a second authority, and the
    // argument exists only as a cross-check for a caller that holds one.
    const { data, error } = await supabase.rpc('receipt_number_next', { p_company_id: null });
    if (error || typeof data !== 'string' || data === '') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * The shape the server draws, built locally.
 *
 * Only a fallback, and deliberately the same shape so nothing downstream has to
 * learn a second one: the Belege list, the Excel export and the PDF all print
 * whatever string is stored.
 */
export function localReceiptNumber(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  let candidate: string;
  do {
    candidate = `BEL-${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
  } while (used.has(candidate));
  return candidate;
}
