import type { CompanySimulationSettings } from '../../lib/simulationSettingsClient';
import { shareSettingProblem, type SharePercent, type ShareScope, type ShareSetting } from './monthlyRate';

/**
 * The settings panel's form state and how it becomes a stored setting
 * (FleetBook round 8, S8). Pure, so the refusals are tested without a screen.
 */

export type SettingsDraftMode = 'none' | 'fixed' | 'random';

export interface SettingsDraft {
  mode: SettingsDraftMode;
  percent: SharePercent;
  scope: ShareScope;
  /** As typed: a seed is text until it parses. */
  seed: string;
  returnToBase: boolean;
}

/** The database stores the seed as an integer, so a larger one is refused before it is sent. */
export const MAX_SETTINGS_SEED = 2_147_483_647;

export type SettingsDraftProblem = 'seed_invalid';

/** The form for a stored setting, or the empty form when none is stored (yet). */
export function draftFromSettings(settings: CompanySimulationSettings | null): SettingsDraft {
  const s = settings?.shareSetting ?? null;
  return {
    mode: s && (s.mode === 'fixed' || s.mode === 'random') ? s.mode : 'none',
    percent: s && s.mode === 'fixed' ? s.percent : 32,
    scope: s && s.mode === 'random' ? s.scope : 'month',
    seed: s && s.mode === 'random' && s.seed !== null && s.seed !== undefined ? String(s.seed) : '',
    returnToBase: settings?.returnToBase ?? false,
  };
}

/** The draft as a setting, or why it cannot be one. */
export function settingFromDraft(
  draft: SettingsDraft,
): { ok: true; shareSetting: ShareSetting | null } | { ok: false; problem: SettingsDraftProblem } {
  if (draft.mode === 'none') return { ok: true, shareSetting: null };
  if (draft.mode === 'fixed') return { ok: true, shareSetting: { mode: 'fixed', percent: draft.percent } };
  const text = draft.seed.trim();
  const seed = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(seed) || seed > MAX_SETTINGS_SEED) return { ok: false, problem: 'seed_invalid' };
  const setting: ShareSetting = { mode: 'random', scope: draft.scope, seed };
  return shareSettingProblem(setting) ? { ok: false, problem: 'seed_invalid' } : { ok: true, shareSetting: setting };
}
