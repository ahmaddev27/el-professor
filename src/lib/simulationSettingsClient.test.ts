import { describe, expect, it } from 'vitest';
import {
  NO_SIMULATION_SETTINGS,
  loadSimulationSettings,
  payloadFromSettings,
  saveSimulationSettings,
  settingsFromRow,
  type SimulationSettingsClient,
  type SimulationSettingsRow,
} from './simulationSettingsClient';
import { draftFromSettings, settingFromDraft } from '../utils/simulatedRides/settingsDraft';
import { shareSettingProblem } from '../utils/simulatedRides/monthlyRate';

/**
 * The company's simulation settings (FleetBook round 8, S8). The database
 * decides who may write (tests/rls/simulation-settings.sql); these pin how a
 * row becomes the generator's input and back, including the rows that must
 * NOT read as a valid setting.
 */

const row = (patch: Partial<SimulationSettingsRow>): SimulationSettingsRow => ({
  id: 'set-1', company_id: 'company-1', share_mode: null, share_percent: null, share_scope: null, seed: null,
  return_to_base: false, updated_at: '2026-11-27T10:00:00Z', ...patch,
});

/** A recording client: one table, one answer, every call kept. */
function client(answer: { data: unknown; error: { message: string } | null }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'upsert']) {
    chain[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return chain; };
  }
  for (const m of ['maybeSingle', 'single']) {
    chain[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return Promise.resolve(answer); };
  }
  const from = (table: string) => { calls.push({ method: 'from', args: [table] }); return chain; };
  return { calls, client: { from } as unknown as SimulationSettingsClient };
}

describe('settingsFromRow', () => {
  it('no row is "nothing stored": no share, no return to the base', () => {
    expect(settingsFromRow(null)).toEqual({ shareSetting: null, returnToBase: false, stored: false, updatedAt: null });
    expect(settingsFromRow(null)).toBe(NO_SIMULATION_SETTINGS);
  });

  it('a row with no mode is stored but sets no share (the report says "not configured")', () => {
    const s = settingsFromRow(row({ return_to_base: true }));
    expect(s).toMatchObject({ shareSetting: null, returnToBase: true, stored: true });
  });

  it('a fixed rate and a seeded draw read as the generator\'s setting', () => {
    expect(settingsFromRow(row({ share_mode: 'fixed', share_percent: 33 })).shareSetting).toEqual({ mode: 'fixed', percent: 33 });
    expect(settingsFromRow(row({ share_mode: 'random', share_scope: 'month', seed: 0 })).shareSetting)
      .toEqual({ mode: 'random', scope: 'month', seed: 0 });
  });

  it('a row the database should never hold is handed on as it reads, so the month calls it invalid, never "not set"', () => {
    const percent = settingsFromRow(row({ share_mode: 'fixed', share_percent: 34 })).shareSetting;
    expect(percent).not.toBeNull();
    expect(shareSettingProblem(percent!)).toBe('percent_not_allowed');
    const scope = settingsFromRow(row({ share_mode: 'random', share_scope: null, seed: 7 })).shareSetting;
    expect(shareSettingProblem(scope!)).toBe('scope_missing');
    const seed = settingsFromRow(row({ share_mode: 'random', share_scope: 'day', seed: null })).shareSetting;
    expect(shareSettingProblem(seed!)).toBe('seed_not_integer');
    const mode = settingsFromRow(row({ share_mode: 'booked' })).shareSetting;
    expect(mode).not.toBeNull();
    expect(shareSettingProblem(mode!)).toBe('mode_unknown');
  });

  it('return_to_base is on only when the row says true', () => {
    expect(settingsFromRow(row({ return_to_base: null })).returnToBase).toBe(false);
    expect(settingsFromRow(row({ return_to_base: true })).returnToBase).toBe(true);
  });
});

describe('payloadFromSettings', () => {
  it('sends every settings column, nulling the ones the mode does not use', () => {
    expect(payloadFromSettings('company-1', { shareSetting: { mode: 'fixed', percent: 30 }, returnToBase: false })).toEqual({
      company_id: 'company-1', share_mode: 'fixed', share_percent: 30, share_scope: null, seed: null, return_to_base: false,
    });
    expect(payloadFromSettings('company-1', { shareSetting: { mode: 'random', scope: 'day', seed: 9 }, returnToBase: true })).toEqual({
      company_id: 'company-1', share_mode: 'random', share_percent: null, share_scope: 'day', seed: 9, return_to_base: true,
    });
    expect(payloadFromSettings('company-1', { shareSetting: null, returnToBase: true })).toEqual({
      company_id: 'company-1', share_mode: null, share_percent: null, share_scope: null, seed: null, return_to_base: true,
    });
  });

  it('never sends a column that names the share\'s meaning or a driver (D1)', () => {
    const keys = Object.keys(payloadFromSettings('company-1', { shareSetting: { mode: 'fixed', percent: 31 }, returnToBase: false }));
    expect(keys.sort()).toEqual(['company_id', 'return_to_base', 'seed', 'share_mode', 'share_percent', 'share_scope']);
  });

  it('round-trips through the row shape', () => {
    for (const shareSetting of [null, { mode: 'fixed', percent: 32 } as const, { mode: 'random', scope: 'month', seed: 12 } as const]) {
      const payload = payloadFromSettings('company-1', { shareSetting, returnToBase: true });
      expect(settingsFromRow(row(payload)).shareSetting).toEqual(shareSetting);
    }
  });
});

describe('loadSimulationSettings and saveSimulationSettings', () => {
  it('reads the company\'s one row, scoped by company', async () => {
    const fake = client({ data: row({ share_mode: 'fixed', share_percent: 32 }), error: null });
    const s = await loadSimulationSettings('company-1', fake.client);
    expect(s.shareSetting).toEqual({ mode: 'fixed', percent: 32 });
    expect(fake.calls.map(c => c.method)).toEqual(['from', 'select', 'eq', 'maybeSingle']);
    expect(fake.calls[0].args).toEqual(['company_simulation_settings']);
    expect(fake.calls[2].args).toEqual(['company_id', 'company-1']);
  });

  it('no row is "nothing stored", not an error', async () => {
    const fake = client({ data: null, error: null });
    expect(await loadSimulationSettings('company-1', fake.client)).toBe(NO_SIMULATION_SETTINGS);
  });

  it('a failed read throws: a month must not run on a setting it did not hear', async () => {
    const fake = client({ data: null, error: { message: 'permission denied' } });
    await expect(loadSimulationSettings('company-1', fake.client)).rejects.toThrow('permission denied');
  });

  it('a save upserts on the company and answers the stored row', async () => {
    const fake = client({ data: row({ share_mode: 'random', share_scope: 'day', seed: 5, return_to_base: true }), error: null });
    const saved = await saveSimulationSettings('company-1', { shareSetting: { mode: 'random', scope: 'day', seed: 5 }, returnToBase: true }, fake.client);
    expect(saved).toMatchObject({ shareSetting: { mode: 'random', scope: 'day', seed: 5 }, returnToBase: true, stored: true });
    const upsert = fake.calls.find(c => c.method === 'upsert')!;
    expect(upsert.args[1]).toEqual({ onConflict: 'company_id' });
    expect(fake.calls.at(-1)!.method).toBe('single');
  });

  it('a refused save throws with the database\'s reason, never reports success', async () => {
    const fake = client({ data: null, error: { message: 'new row violates row-level security policy' } });
    await expect(saveSimulationSettings('company-1', { shareSetting: null, returnToBase: false }, fake.client))
      .rejects.toThrow('row-level security');
  });

  it('a save that returns no row throws', async () => {
    const fake = client({ data: null, error: null });
    await expect(saveSimulationSettings('company-1', { shareSetting: null, returnToBase: false }, fake.client))
      .rejects.toThrow('no row');
  });
});

describe('the panel\'s draft', () => {
  const draft = (patch: Partial<Parameters<typeof settingFromDraft>[0]>) => ({
    mode: 'none' as const, percent: 32 as const, scope: 'month' as const, seed: '', returnToBase: false, ...patch,
  });

  it('none, a fixed rate and a seeded draw become the setting', () => {
    expect(settingFromDraft(draft({}))).toEqual({ ok: true, shareSetting: null });
    expect(settingFromDraft(draft({ mode: 'fixed', percent: 30 }))).toEqual({ ok: true, shareSetting: { mode: 'fixed', percent: 30 } });
    expect(settingFromDraft(draft({ mode: 'random', scope: 'day', seed: ' 77 ' })))
      .toEqual({ ok: true, shareSetting: { mode: 'random', scope: 'day', seed: 77 } });
  });

  it('a seed that is empty, negative, fractional, text or above the integer column is refused before it is sent', () => {
    for (const seed of ['', '-1', '1.5', 'abc', '1e3', '2147483648']) {
      expect(settingFromDraft(draft({ mode: 'random', seed }))).toEqual({ ok: false, problem: 'seed_invalid' });
    }
    expect(settingFromDraft(draft({ mode: 'random', seed: '2147483647' }))).toMatchObject({ ok: true });
  });

  it('the form opens on what is stored, and an invalid stored draw opens with an empty seed rather than "0"', () => {
    expect(draftFromSettings(null)).toEqual({ mode: 'none', percent: 32, scope: 'month', seed: '', returnToBase: false });
    expect(draftFromSettings(settingsFromRow(row({ share_mode: 'fixed', share_percent: 30, return_to_base: true }))))
      .toEqual({ mode: 'fixed', percent: 30, scope: 'month', seed: '', returnToBase: true });
    expect(draftFromSettings(settingsFromRow(row({ share_mode: 'random', share_scope: 'day', seed: 0 }))))
      .toMatchObject({ mode: 'random', scope: 'day', seed: '0' });
    expect(draftFromSettings(settingsFromRow(row({ share_mode: 'random', share_scope: 'day', seed: null }))).seed).toBe('');
  });
});
