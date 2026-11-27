import type { supabase } from './supabase';
import type { ShareSetting, SharePercent, ShareScope } from '../utils/simulatedRides/monthlyRate';

/**
 * The company's simulation settings (FleetBook round 8, `20261127200000`):
 * the share rate of section 5 and whether a shift ends at the Betriebssitz.
 *
 * One row per company. Reading it is every role's (the simulator needs it);
 * writing it is an administrator's, which RLS decides. The share's meaning is
 * not stored and not settable here: it is the company's share (D1, owner
 * 27.11.2026), fixed in `reconciliation.ts`.
 *
 * The client is the caller's (the screen passes `supabase`), so a test needs
 * no browser to import this file.
 */

export const SIMULATION_SETTINGS_COLUMNS =
  'id, company_id, share_mode, share_percent, share_scope, seed, return_to_base, updated_at';

export interface SimulationSettingsRow {
  id: string;
  company_id: string;
  share_mode: string | null;
  share_percent: number | null;
  share_scope: string | null;
  seed: number | null;
  return_to_base: boolean | null;
  updated_at: string | null;
}

export interface CompanySimulationSettings {
  /**
   * The share setting, or null when the company has none. A stored row that
   * does not read as a setting is passed on as it reads, so the month reports
   * `share_setting_invalid` rather than quietly treating it as "not set".
   */
  shareSetting: ShareSetting | null;
  /** Off unless the company turned it on (D8): the spec forbids a universal return. */
  returnToBase: boolean;
  /** Whether a row exists at all. */
  stored: boolean;
  updatedAt: string | null;
}

export const NO_SIMULATION_SETTINGS: CompanySimulationSettings = Object.freeze({
  shareSetting: null,
  returnToBase: false,
  stored: false,
  updatedAt: null,
});

/** The row as the generator reads it. Pure. */
export function settingsFromRow(row: SimulationSettingsRow | null): CompanySimulationSettings {
  if (!row) return NO_SIMULATION_SETTINGS;
  return {
    shareSetting: shareSettingFromRow(row),
    returnToBase: row.return_to_base === true,
    stored: true,
    updatedAt: row.updated_at ?? null,
  };
}

function shareSettingFromRow(row: SimulationSettingsRow): ShareSetting | null {
  if (row.share_mode === null || row.share_mode === undefined) return null;
  // The values are passed on raw, never coerced: Number(null) is 0, which
  // would turn a draw with no seed into a valid seed-0 draw instead of an
  // invalid setting.
  if (row.share_mode === 'fixed') return { mode: 'fixed', percent: row.share_percent as SharePercent };
  if (row.share_mode === 'random') {
    return { mode: 'random', scope: row.share_scope as ShareScope, seed: row.seed as number };
  }
  // A mode this build does not know: handed on so shareSettingProblem names it.
  return { mode: row.share_mode } as unknown as ShareSetting;
}

/** What a save sends: every settings column, so the row always matches the form. */
export interface SimulationSettingsPayload {
  company_id: string;
  share_mode: 'fixed' | 'random' | null;
  share_percent: number | null;
  share_scope: ShareScope | null;
  seed: number | null;
  return_to_base: boolean;
}

export function payloadFromSettings(
  companyId: string,
  values: { shareSetting: ShareSetting | null; returnToBase: boolean },
): SimulationSettingsPayload {
  const s = values.shareSetting;
  return {
    company_id: companyId,
    share_mode: s ? s.mode : null,
    share_percent: s && s.mode === 'fixed' ? s.percent : null,
    share_scope: s && s.mode === 'random' ? s.scope : null,
    seed: s && s.mode === 'random' ? s.seed : null,
    return_to_base: values.returnToBase,
  };
}

export type SimulationSettingsClient = Pick<typeof supabase, 'from'>;

/** The company's row, or "none stored". A failed read throws: a month must not run on a setting it did not hear. */
export async function loadSimulationSettings(
  companyId: string,
  client: SimulationSettingsClient,
): Promise<CompanySimulationSettings> {
  const { data, error } = await client
    .from('company_simulation_settings')
    .select(SIMULATION_SETTINGS_COLUMNS)
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) throw new Error(`company_simulation_settings: ${error.message}`);
  return settingsFromRow((data ?? null) as SimulationSettingsRow | null);
}

/**
 * Stores the settings (administrators only; RLS refuses anyone else with an
 * error, never a silent zero rows, because an upsert's INSERT is checked).
 * Answers the row the database stored, so the screen shows what is saved.
 */
export async function saveSimulationSettings(
  companyId: string,
  values: { shareSetting: ShareSetting | null; returnToBase: boolean },
  client: SimulationSettingsClient,
): Promise<CompanySimulationSettings> {
  const { data, error } = await client
    .from('company_simulation_settings')
    .upsert(payloadFromSettings(companyId, values), { onConflict: 'company_id' })
    .select(SIMULATION_SETTINGS_COLUMNS)
    .single();
  if (error) throw new Error(`company_simulation_settings: ${error.message}`);
  if (!data) throw new Error('company_simulation_settings: the save returned no row');
  return settingsFromRow(data as SimulationSettingsRow);
}
