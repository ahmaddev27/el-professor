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
import { parseSettingAnswer, type SettingKey, type SettingResult } from './platformSettings';

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
