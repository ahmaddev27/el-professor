import { describe, expect, it } from 'vitest';
import type { RouteBatchAnswer } from '../../supabase/functions/_shared/travel-route-core';
import type { GeocodeClient } from '../../src/lib/geocodeClient';
import { NO_SIMULATION_SETTINGS } from '../../src/lib/simulationSettingsClient';
import { writeCachedPool } from '../../src/utils/simulatedRides/addressPool';
import { DEFAULT_CALENDAR_FORM } from '../../src/utils/simulatedRides/calendarForm';
import { haversineKm } from '../../src/utils/simulatedRides/geo';
import type { PoolAddress } from '../../src/utils/simulatedRides/types';
import type { TravelRouter } from '../../src/utils/travelRouting/prefetch';
import {
  DEMO_COMPANY_NAME, OFFLINE_DEPS, SNAPSHOT_VERSION, decideSettings, defaultSeed, memoryStorage, parseArgs, runMonth,
  serializeEvents, type MonthSnapshot, type RunDeps,
} from './round8Month.mts';

const BASE = { lat: 51.12, lon: 7.05 };
const FETCHED_AT = '2026-11-27T18:00:00.000Z';
const POOL: PoolAddress[] = Array.from({ length: 60 }, (_, i) => ({
  label: `Teststraße ${i + 1}, 40210 Demostadt, Deutschland`,
  lat: 51.1 + Math.floor(i / 10) * 0.006,
  lon: 7.02 + (i % 10) * 0.007,
}));

/** The routing services, faked: every address is where the pool says, every route 1.4 × the straight line. */
function liveDeps(): RunDeps & { calls: { geocode: number; route: number } } {
  const calls = { geocode: 0, route: 0 };
  const byText = new Map(POOL.map(a => [a.label, a]));
  const geocoder: GeocodeClient = {
    geocode: async batch => {
      calls.geocode += 1;
      return {
        ok: true, dataUpdated: '2026-10-01',
        results: batch.map(q => {
          const a = byText.get(q.text)!;
          return { id: q.id, kind: 'located' as const, lat: a.lat, lon: a.lon, precision: 'exact' as const, osm: null };
        }),
      };
    },
  };
  const router: TravelRouter = {
    route: async (pairs): Promise<RouteBatchAnswer> => {
      calls.route += 1;
      return {
        ok: true, dataVersion: null,
        results: pairs.map(p => {
          const km = haversineKm(p.from, p.to) * 1.4;
          return { id: p.id, kind: 'route' as const, durationSeconds: (km / 30) * 3600 + 15, distanceMeters: km * 1000, snapMeters: [3, 3] as const };
        }),
      };
    },
  };
  return { fetchFn: OFFLINE_DEPS.fetchFn, geocoder, router, calls };
}

function poolStorage(): Record<string, string> {
  const storage = memoryStorage();
  writeCachedPool({ city: 'Demostadt', center: BASE, addresses: POOL, fetchedAt: FETCHED_AT, requests: 0 }, storage);
  return storage.dump();
}

const facts = (id: string, weekdays: number[]) => ({
  id, status: 'active', employment_type: null, allowed_weekdays: weekdays, planning_enabled: true,
  work_window_start: null, work_window_end: null, is_full_day_available: true,
  planning_min_salary: 600, planning_max_salary: 900, planning_hourly_rate: 15, salary_ratio: 0.4,
  planning_target_salary: null, target_monthly_hours: null, max_monthly_hours: null,
});

function snapshot(over: Partial<MonthSnapshot> = {}): MonthSnapshot {
  return {
    version: SNAPSHOT_VERSION, fetchedAt: FETCHED_AT,
    company: { id: 'company-demo', name: DEMO_COMPANY_NAME },
    year: 2026, month: 9, seed: defaultSeed(2026, 9), city: 'Demostadt', form: DEFAULT_CALENDAR_FORM,
    cars: [{ id: 'car-1', plate: 'W-DE 1', tuev: '2027-06-30' }, { id: 'car-2', plate: 'W-DE 2', tuev: '2027-06-30' }],
    carIds: ['car-1', 'car-2'],
    drivers: [{ id: 'd-1', name: 'Anna Test' }, { id: 'd-2', name: 'Bert Test' }],
    base: { ok: true, base: BASE, source: 'saved_point', label: 'Betriebssitz (gespeicherter Punkt)' },
    events: serializeEvents({
      notes: new Map(), facts: new Map([['d-1', facts('d-1', [1, 2, 3, 4, 5])], ['d-2', facts('d-2', [])]]),
      checks: [], unavailability: [], uber: null, realTrips: { rows: [], drivers: [] }, simulation: NO_SIMULATION_SETTINGS,
    }),
    settingsSource: 'company_settings', allowEstimate: false, storage: poolStorage(),
    ...over,
  };
}

const payloads = (o: Awaited<ReturnType<typeof runMonth>>): string => {
  if (!o.ok) throw new Error(`run failed at ${o.stage}: ${o.reason}`);
  return JSON.stringify(o.workbooks);
};

describe('runMonth: the screen\'s calendar month from a snapshot', () => {
  it('a fetch fills the routing cache, and a replay of it gives byte-identical workbooks without one network call', async () => {
    const deps = liveDeps();
    const first = await runMonth(snapshot(), deps);
    if (!first.ok) throw new Error(`${first.stage}: ${first.reason}`);
    expect(deps.calls.geocode).toBeGreaterThan(0);
    expect(deps.calls.route).toBeGreaterThan(0);
    expect(first.sourcing).toEqual({ estimate: false, routingFailure: null, poolFromCache: true });
    expect(first.workbooks.map(w => w.fileName)).toHaveLength(3);
    expect(first.verification.routing).toBe('measured');

    // Through JSON, as the snapshot file goes, and with clients that refuse every call.
    const kept = JSON.parse(JSON.stringify(snapshot({ storage: first.storage }))) as MonthSnapshot;
    const replay = await runMonth(kept, OFFLINE_DEPS);
    expect(payloads(replay)).toBe(payloads(first));
  });

  it('a replay whose cache lacks the routes stops; it never fetches and never falls back to the estimate', async () => {
    const out = await runMonth(snapshot(), OFFLINE_DEPS);
    expect(out).toMatchObject({ ok: false, stage: 'routing' });
    if (!out.ok) expect(out.reason).toMatch(/not in the snapshot/);
  });

  it('a replay without the address pool stops at the pool', async () => {
    const out = await runMonth(snapshot({ storage: {} }), OFFLINE_DEPS);
    expect(out).toMatchObject({ ok: false, stage: 'pool' });
    if (!out.ok) expect(out.reason).toMatch(/address pool is not in the snapshot/);
  });

  it('no base is CONFIGURATION_REQUIRED and nothing is generated', async () => {
    const out = await runMonth(snapshot({ base: { ok: false, reason: 'no_base_configured', detail: null } }), OFFLINE_DEPS);
    expect(out).toMatchObject({ ok: false, stage: 'base' });
    if (!out.ok) expect(out.reason).toMatch(/^CONFIGURATION_REQUIRED: no_base_configured/);
  });

  it('routing that cannot answer is refused unless the estimate was asked for, and then it is labelled as one', async () => {
    const down: RunDeps = { ...OFFLINE_DEPS, geocoder: { geocode: async () => ({ ok: false, reason: 'function_unreachable' }) } };
    expect(await runMonth(snapshot(), down)).toMatchObject({ ok: false, stage: 'routing' });
    const estimated = await runMonth(snapshot({ allowEstimate: true }), down);
    if (!estimated.ok) throw new Error(`${estimated.stage}: ${estimated.reason}`);
    expect(estimated.sourcing.estimate).toBe(true);
    expect(estimated.sourcing.routingFailure).not.toBeNull();
    expect(estimated.verification.routing).toBe('estimate');
  });

  it('a month on typed-in settings says so on the closing\'s sheet 7', async () => {
    const deps = liveDeps();
    const out = await runMonth(snapshot({
      settingsSource: 'script_arguments',
      events: { ...snapshot().events, simulation: { shareSetting: { mode: 'fixed', percent: 31 }, returnToBase: false, stored: false, updatedAt: null } },
    }), deps);
    if (!out.ok) throw new Error(`${out.stage}: ${out.reason}`);
    const closing = JSON.stringify(out.workbooks[2].payload);
    expect(closing).toContain('Skriptargumente (--share-percent');
    expect(closing).toContain('fest 31 %');
  });
});

describe('decideSettings: the company\'s stored settings always decide', () => {
  const stored = { kind: 'table' as const, settings: NO_SIMULATION_SETTINGS };

  it('where the table exists, a typed rate is refused rather than preferred, even when the company stored none', () => {
    expect(decideSettings(stored, { sharePercent: 31, returnToBase: false })).toMatchObject({ ok: false });
    expect(decideSettings(stored, { sharePercent: null, returnToBase: true })).toMatchObject({ ok: false });
    expect(decideSettings(stored, { sharePercent: null, returnToBase: false })).toEqual({ ok: true, simulation: NO_SIMULATION_SETTINGS, source: 'company_settings' });
  });

  it('where it does not exist yet, the arguments stand in and are named as the source', () => {
    expect(decideSettings({ kind: 'table_missing' }, { sharePercent: 32, returnToBase: true })).toEqual({
      ok: true, source: 'script_arguments',
      simulation: { shareSetting: { mode: 'fixed', percent: 32 }, returnToBase: true, stored: false, updatedAt: null },
    });
    expect(decideSettings({ kind: 'table_missing' }, { sharePercent: null, returnToBase: false })).toMatchObject({
      ok: true, source: 'script_arguments', simulation: { shareSetting: null },
    });
  });

  it('a rate outside 30 to 33 is refused', () => {
    for (const p of [29, 34, 0]) expect(decideSettings({ kind: 'table_missing' }, { sharePercent: p, returnToBase: false })).toMatchObject({ ok: false });
  });
});

describe('parseArgs', () => {
  it('a fetch names its month; a replay names its snapshot; never both', () => {
    expect(parseArgs(['--fetch', '--month', '2026-10'])).toMatchObject({ ok: true, args: { mode: 'fetch', year: 2026, month: 10, render: true } });
    expect(parseArgs(['--from-inputs', 'x.json'])).toMatchObject({ ok: true, args: { mode: 'replay', inputs: 'x.json', render: false } });
    expect(parseArgs(['--fetch', '--month', '2026-10', '--from-inputs', 'x.json']).ok).toBe(false);
    expect(parseArgs([]).ok).toBe(false);
    expect(parseArgs(['--fetch', '--month', '2026-13']).ok).toBe(false);
  });

  it('the settings and the estimate are fixed when the inputs are fetched, not on a replay', () => {
    expect(parseArgs(['--from-inputs', 'x.json', '--share-percent', '31']).ok).toBe(false);
    expect(parseArgs(['--from-inputs', 'x.json', '--allow-estimate']).ok).toBe(false);
    expect(parseArgs(['--fetch', '--month', '2026-09', '--share-percent', '31', '--return-to-base'])).toMatchObject({
      ok: true, args: { sharePercent: 31, returnToBase: true },
    });
  });

  it('a seed is a whole number', () => {
    expect(parseArgs(['--from-inputs', 'x.json', '--seed', '1.5']).ok).toBe(false);
    expect(parseArgs(['--from-inputs', 'x.json', '--seed', '42'])).toMatchObject({ ok: true, args: { seed: 42 } });
  });
});
