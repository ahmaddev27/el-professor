/**
 * The settings RPCs, called (plan 3.E / 3.6c).
 *
 * `platform_settings_get` and `platform_settings_put` answer `{ok, …}` and
 * refuse with a reason rather than raising, so both come back as values. Only a
 * broken argument contract raises, and that arrives here as a Supabase error.
 *
 * A save always carries the version the screen read. The database refuses a
 * stale one and writes nothing; the refusal is shown, never retried with the
 * newer version, which would overwrite somebody else's change unseen.
 */
import { supabase } from './supabase';
import { parseSeller, parseSettingAnswer, type Seller, type SettingKey, type SettingResult } from './platformSettings';

/**
 * The sender printed on an invoice, through `platform_invoice_seller()`
 * (migration 20260920130000). It needs `companies.read` — the capability that
 * reads an invoice — rather than `settings.read`, so billing and support, who
 * download invoices but may not read the settings, get it too. One audited read
 * per call, so the invoice screen asks when it builds a PDF and not on load.
 *
 * Null for any refusal and for a stored document this build cannot read: the
 * caller refuses to build the PDF rather than print an invoice without its
 * sender.
 */
export async function getInvoiceSeller(): Promise<Seller | null> {
  const { data, error } = await supabase.rpc('platform_invoice_seller');
  if (error) throw new Error(error.message);
  if (typeof data !== 'object' || data === null || (data as { ok?: unknown }).ok !== true) return null;
  return parseSeller((data as { value?: unknown }).value);
}

export async function getSetting(key: SettingKey): Promise<SettingResult> {
  const { data, error } = await supabase.rpc('platform_settings_get', { p_key: key });
  if (error) throw new Error(error.message);
  return parseSettingAnswer(data);
}

export async function putSetting(
  key: SettingKey,
  value: unknown,
  expectedVersion: number,
): Promise<SettingResult> {
  const { data, error } = await supabase.rpc('platform_settings_put', {
    p_key: key,
    p_value: value,
    p_expected_version: expectedVersion,
  });
  if (error) throw new Error(error.message);
  return parseSettingAnswer(data);
}
