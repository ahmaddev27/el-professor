import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../test-utils/fakeSupabase';

/**
 * The calendar mode of "Fahrten simulieren", rendered (external audit round 4).
 *
 * Everything the screen reaches is a fake: the database (notes, cars, drivers,
 * workshop checks), the address pool, the geocoder and the router. The pipeline
 * between them is the real one, so what is asserted is what the operator sees:
 * 28 days for February 2026, the rate before generating, a month with a broken
 * rule offering no download, and an estimate that exists only after the box is
 * ticked. Round 8: every shift starts at the company's base, the saved point
 * or the company address found at house level, and with neither nothing is
 * generated; the pool's centre is never the base.
 */

const world = vi.hoisted(() => ({
  noteError: false,
  /** Round 8 S6: the month's real (imported) trips, and whether reading them fails. */
  realTrips: [] as unknown[],
  tripsError: false,
  routerDown: false,
  injectViolation: false,
  generateCalls: 0,
  /** What the screen handed the generator as its base. */
  bases: [] as { base: { lat: number; lon: number }; source: unknown; label: unknown }[],
  savedBase: true,
  address: { city: 'Demostadt' } as Record<string, string>,
  /** How the geocoder answers the company address: one house, only a street, or no answer. */
  addressAnswer: 'located' as 'located' | 'too_coarse' | 'down',
  addressQueries: [] as string[],
  delivered: [] as unknown[],
  built: [] as unknown[],
  /** Round 8 S8: the company's stored simulation settings row, none, or a failed read. */
  simulationRow: null as Record<string, unknown> | null,
  simulationError: false,
  isAdmin: true,
  /** What the screen handed the generator as the share setting and the return to base. */
  generatorSettings: [] as { shareSetting: unknown; returnToBase: unknown }[],
}));

const POOL = Array.from({ length: 70 }, (_, i) => ({
  label: `Teststraße ${i + 1}, 40210 Demostadt, Deutschland`,
  lat: 51.1 + Math.floor(i / 10) * 0.006,
  lon: 7.02 + (i % 10) * 0.007,
}));
const CENTER = { lat: 51.12, lon: 7.05 };
// Deliberately not the pool's centre, so a fallback to it cannot pass for the base.
const SAVED_BASE = { lat: 51.1036, lon: 7.0287 };
const ADDRESS_POINT = { lat: 51.1418, lon: 7.0811 };
const FULL_ADDRESS = { street: 'Musterweg', house_number: '7', postal_code: '40210', city: 'Demostadt' };

const fake = createFakeSupabase(call => {
  if (call.table === 'driver_notes' && world.noteError) return { data: null, error: { message: 'boom' } };
  if (call.table === 'fahrtenbuch_trips' && world.tripsError) return { data: null, error: { message: 'boom' } };
  if (call.table === 'company_simulation_settings' && world.simulationError) return { data: null, error: { message: 'boom' } };
  const rows: Record<string, unknown[]> = {
    cars: [
      { id: 'car-1', kennzeichen: 'XX-AA 1', tuev_gueltig_bis: '2027-06-30' },
      { id: 'car-2', kennzeichen: 'XX-AA 2', tuev_gueltig_bis: '2027-06-30' },
    ],
    // Round 8: the month is planned from each driver's hours range.
    drivers: [1, 2, 3].map(n => ({
      id: `drv-${n}`, status: 'active', allowed_weekdays: null, planning_enabled: true,
      planning_min_salary: 600, planning_max_salary: 1200, planning_hourly_rate: 13,
    })),
    driver_notes: [],
    werkstatt_checks: [],
    fahrtenbuch_trips: world.realTrips,
    company_simulation_settings: world.simulationRow ? [world.simulationRow] : [],
  };
  return { data: rows[call.table] ?? [], error: null };
});

vi.mock('../lib/supabase', () => ({ supabase: fake.client }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/CompanySettingsContext', () => ({ useCompanySettings: () => ({ settings: world.address }) }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: () => {} }) }));
vi.mock('../hooks/useCompanyScope', () => ({ useCompanyScope: () => ({ can: () => true, readOnly: false, kind: 'own' }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ isAdmin: world.isAdmin }) }));
vi.mock('../hooks/useFahrtenbuch', () => ({ useFahrtenbuch: () => ({ createImport: async () => {} }) }));
vi.mock('../lib/tripAnalysisClient', () => ({
  loadCompanyDrivers: async () => [1, 2, 3].map(n => ({
    id: `drv-${n}`, name: `Fahrer ${n}`, status: 'active', planning_min_salary: null, planning_max_salary: null, planning_hourly_rate: null,
  })),
  loadSettings: async () => (world.savedBase ? { base_latitude: SAVED_BASE.lat, base_longitude: SAVED_BASE.lon } : null),
}));
vi.mock('../contexts/LanguageContext', async () => {
  const { translate, translatePlural } = await import('../i18n');
  const value = {
    language: 'de',
    setLanguage: () => {},
    t: (key: never, vars?: never) => translate('de', key, vars),
    tPlural: (keys: never, count: number, vars?: never) => translatePlural('de', keys, count, vars),
  };
  return { useTranslation: () => value };
});
vi.mock('../utils/simulatedRides/addressPool', async importActual => ({
  ...(await importActual<typeof import('../utils/simulatedRides/addressPool')>()),
  buildAddressPool: async () => ({ city: 'Demostadt', center: CENTER, addresses: POOL, fetchedAt: '2026-10-29T08:00:00Z', requests: 3 }),
}));
vi.mock('../lib/geocodeClient', () => ({
  createGeocodeClient: () => ({
    geocode: async (batch: { id: string; text: string }[]) => {
      const base = batch.find(q => q.id === 'company-base');
      if (base) {
        world.addressQueries.push(base.text);
        if (world.addressAnswer === 'down') return { ok: false, reason: 'function_unreachable' };
        if (world.addressAnswer === 'too_coarse') return { ok: true, dataUpdated: null, results: [{ id: base.id, kind: 'unlocated', reason: 'too_coarse' }] };
        return { ok: true, dataUpdated: null, results: [{ id: base.id, kind: 'located', ...ADDRESS_POINT, precision: 'exact', osm: null }] };
      }
      return {
        ok: true,
        dataUpdated: null,
        results: batch.map(q => {
          const a = POOL.find(p => p.label === q.text)!;
          return { id: q.id, kind: 'located', lat: a.lat, lon: a.lon, precision: 'exact', osm: null };
        }),
      };
    },
  }),
}));
vi.mock('../lib/travelRouteClient', async () => {
  const { haversineKm } = await import('../utils/simulatedRides/geo');
  return {
    createTravelRouteClient: () => ({
      route: async (pairs: { id: string; from: { lat: number; lon: number }; to: { lat: number; lon: number } }[]) => ({
        ok: true,
        dataVersion: null,
        results: pairs.map(p => {
          if (world.routerDown) return { id: p.id, kind: 'unavailable', reason: 'no_route' };
          const km = haversineKm(p.from, p.to) * 1.4;
          return { id: p.id, kind: 'route', durationSeconds: (km / 30) * 3600 + 15, distanceMeters: km * 1000, snapMeters: [3, 3] };
        }),
      }),
    }),
  };
});
// The real pipeline, minus the 300 ms the gateways need between calls.
vi.mock('../lib/simulationRouting', async importActual => {
  const actual = await importActual<typeof import('../lib/simulationRouting')>();
  return { ...actual, prepareRouting: (a: Parameters<typeof actual.prepareRouting>[0]) => actual.prepareRouting({ ...a, deps: { ...a.deps, pauseMs: 0 } }) };
});
vi.mock('../utils/simulatedRides/fullMonth', async importActual => {
  const actual = await importActual<typeof import('../utils/simulatedRides/fullMonth')>();
  return {
    ...actual,
    generateFullMonth: (input: Parameters<typeof actual.generateFullMonth>[0]) => {
      world.generateCalls += 1;
      world.bases.push({ base: input.base, source: input.baseSource, label: input.baseLabel });
      world.generatorSettings.push({ shareSetting: input.shareSetting, returnToBase: input.returnToBase });
      const out = actual.generateFullMonth(input);
      if (out.ok && world.injectViolation) out.result.violations = ['Teststreit: eine Regel gebrochen'];
      return out;
    },
  };
});
vi.mock('../utils/simulatedRides/monthWorkbook', async importActual => ({
  ...(await importActual<typeof import('../utils/simulatedRides/monthWorkbook')>()),
  buildMonthReport: (result: unknown) => { world.built.push(result); return { fileName: 'SIMULIERT_test.xlsx', payload: { version: 1, sheets: [] } }; },
}));
vi.mock('../utils/simulatedRides/operationalReport', async importActual => ({
  ...(await importActual<typeof import('../utils/simulatedRides/operationalReport')>()),
  buildOperationalReport: (result: unknown) => { world.built.push(result); return { fileName: 'SIMULIERT_betrieb.xlsx', payload: { version: 1, sheets: [] } }; },
}));
vi.mock('../utils/simulatedRides/monthClosing', async importActual => ({
  ...(await importActual<typeof import('../utils/simulatedRides/monthClosing')>()),
  buildMonthClosing: (result: unknown) => { world.built.push(result); return { fileName: 'SIMULIERT_abschluss.xlsx', payload: { version: 1, sheets: [] } }; },
}));
vi.mock('../utils/serviceWorkbookDownload', () => ({
  deliverWorkbookPayload: (payload: unknown, name: string) => { world.delivered.push([payload, name]); },
}));

const { default: SimulatedRidesPage } = await import('./SimulatedRidesPage');

const collect = (node: ReactTestInstance | string): string => (typeof node === 'string' ? node : node.children.map(collect).join(''));

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll(node => node.type === 'button' && collect(node).includes(label));
  if (found.length === 0) throw new Error(`no button "${label}"`);
  return found[0];
}

function checkbox(root: ReactTestInstance, label: string): ReactTestInstance {
  const labelNode = root.findAll(node => node.type === 'label' && collect(node).includes(label))[0];
  if (!labelNode) throw new Error(`no checkbox "${label}"`);
  return labelNode.findAll(node => node.type === 'input')[0];
}

async function settle(until: () => boolean, rounds = 400) {
  for (let i = 0; i < rounds && !until(); i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}

async function mount(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(SimulatedRidesPage)); });
  await settle(() => !button(renderer.root, 'Fahrten erzeugen').props.disabled, 100);
  return renderer;
}

async function chooseFebruary(renderer: ReactTestRenderer) {
  const month = renderer.root.findAll(node => node.type === 'input' && node.props.type === 'month')[0];
  await act(async () => { month.props.onChange({ target: { value: '2026-02' } }); });
}

describe('SimulatedRidesPage, calendar mode', () => {
  beforeEach(() => {
    world.noteError = false;
    world.realTrips = [];
    world.tripsError = false;
    world.routerDown = false;
    world.injectViolation = false;
    world.generateCalls = 0;
    world.bases.length = 0;
    world.savedBase = true;
    world.address = { city: 'Demostadt' };
    world.addressAnswer = 'located';
    world.addressQueries.length = 0;
    world.delivered.length = 0;
    world.built.length = 0;
    world.simulationRow = null;
    world.simulationError = false;
    world.isAdmin = true;
    world.generatorSettings.length = 0;
  });

  it('shows the share rate before generating, then 28 days for February 2026 and a downloadable report', async () => {
    const renderer = await mount();
    await chooseFebruary(renderer);
    expect(collect(renderer.root)).toMatch(/Der Startwert zieht für diesen Monat \d\d,\d\d %/);
    expect(collect(renderer.root)).toContain('weder Steuer noch Provision');

    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('Erzeugter Kalendermonat'));
    const text = collect(renderer.root);
    expect(text).toContain('Erzeugter Kalendermonat');
    expect(text).toContain('Tage im Monat28');
    expect(text).toContain('Fahrzeiten aus Routenberechnung');
    expect(text).toContain('falls als Abzug behandelt');
    expect(text).not.toContain('Schätzung, keine Routenprüfung');

    // Generation and verification are two answers: a routed, clean month is generated, and says what its verdict is.
    expect(text).toContain('Erzeugung: erfolgreich, keine Regel verletzt');
    expect(text).toMatch(/VALIDATED_FOR_EXPORT|VERIFICATION_INCOMPLETE/);
    expect(text).toContain('Abgelehnt (intern)');
    expect(text).toContain('Leerfahrten');
    // The money against Uber is its own answer (D10). With no Uber row for the
    // month it is INCOMPLETE and says why; it never reads as reconciled.
    expect(text).toContain('Finanzabgleich mit Uber - INCOMPLETE');
    expect(text).toContain('Uber meldet für den Monat keine Zahlen');
    expect(text).toContain('Anteil (berechnet, nicht gebucht)');
    // No stored setting (S8): no rate is made up, the report says so, and the
    // return to the base stays off.
    expect(text).toContain('Kein Anteilssatz festgelegt');
    expect(world.generatorSettings).toEqual([{ shareSetting: null, returnToBase: false }]);

    const download = button(renderer.root, 'Fahrtenbuch-Bericht herunterladen (SIMULIERT)');
    expect(download.props.disabled).toBeFalsy();
    await act(async () => { download.props.onClick(); });
    const operational = button(renderer.root, 'Betriebsbericht herunterladen (intern, SIMULIERT)');
    await act(async () => { operational.props.onClick(); });
    const closing = button(renderer.root, 'Monatsabschluss herunterladen (SIMULIERT, mit echten Fahrten)');
    await act(async () => { closing.props.onClick(); });
    expect(world.delivered).toEqual([
      [{ version: 1, sheets: [] }, 'SIMULIERT_test.xlsx'],
      [{ version: 1, sheets: [] }, 'SIMULIERT_betrieb.xlsx'],
      [{ version: 1, sheets: [] }, 'SIMULIERT_abschluss.xlsx'],
    ]);
    // All three are built from the month on screen, never from a second run.
    expect(new Set(world.built).size).toBe(1);
    // The saved point is the base, and the geocoder was never asked for the address.
    expect(world.bases).toEqual([{ base: SAVED_BASE, source: 'saved_point', label: 'Betriebssitz (gespeicherter Punkt)' }]);
    expect(world.addressQueries).toEqual([]);
  });

  it('with no saved point, the company address found at house level is the base, labelled as derived', async () => {
    world.savedBase = false;
    world.address = { ...FULL_ADDRESS };
    const renderer = await mount();
    await chooseFebruary(renderer);
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('Erzeugter Kalendermonat'));
    expect(world.addressQueries).toEqual(['Musterweg 7, 40210 Demostadt']);
    expect(world.bases).toEqual([{
      base: ADDRESS_POINT, source: 'company_address',
      label: 'Musterweg 7, 40210 Demostadt (Betriebssitz aus der Firmenadresse abgeleitet)',
    }]);
  });

  it('negative: no saved point and an incomplete address generate nothing, and the pool centre is not used instead', async () => {
    world.savedBase = false;
    const renderer = await mount();
    await chooseFebruary(renderer);
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('Es wurde nichts erzeugt'));
    expect(collect(renderer.root)).toContain('Firmenadresse in den Einstellungen ist unvollständig');
    expect(world.generateCalls).toBe(0);
    expect(world.addressQueries).toEqual([]);
  });

  it('negative: an address the geocoder finds only as a street is never the base', async () => {
    world.savedBase = false;
    world.address = { ...FULL_ADDRESS };
    world.addressAnswer = 'too_coarse';
    const renderer = await mount();
    await chooseFebruary(renderer);
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('Es wurde nichts erzeugt'));
    expect(collect(renderer.root)).toContain('nicht auf Hausnummer genau gefunden');
    expect(world.generateCalls).toBe(0);
  });

  it('negative: with the geocoder unreachable, no month is generated without a base', async () => {
    world.savedBase = false;
    world.address = { ...FULL_ADDRESS };
    world.addressAnswer = 'down';
    const renderer = await mount();
    await chooseFebruary(renderer);
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('Ohne Betriebssitz wird kein Monat erzeugt'));
    expect(collect(renderer.root)).toContain('Geocoder nicht geantwortet');
    expect(world.generateCalls).toBe(0);
  });

  it('a month that broke a rule is shown as an error and offers no download', async () => {
    world.injectViolation = true;
    const renderer = await mount();
    await chooseFebruary(renderer);
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('Erzeugter Kalendermonat'));
    expect(collect(renderer.root)).toContain('verletzt 1 Regel(n)');
    expect(button(renderer.root, 'Fahrtenbuch-Bericht herunterladen (SIMULIERT)').props.disabled).toBe(true);
    expect(button(renderer.root, 'Betriebsbericht herunterladen (intern, SIMULIERT)').props.disabled).toBe(true);
    expect(button(renderer.root, 'Monatsabschluss herunterladen (SIMULIERT, mit echten Fahrten)').props.disabled).toBe(true);
    expect(collect(renderer.root)).toContain('NOT_VALIDATED');
  });

  it('with the router unable to answer, nothing is generated and the estimate needs its own box', async () => {
    world.routerDown = true;
    const renderer = await mount();
    await chooseFebruary(renderer);
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('Es wurde nichts erzeugt'));
    expect(collect(renderer.root)).toContain('Es wurde nichts erzeugt');
    expect(collect(renderer.root)).not.toContain('Erzeugter Kalendermonat');
    expect(world.generateCalls).toBe(0);

    const optIn = checkbox(renderer.root, 'Ohne Routenberechnung erzeugen (Schätzung, keine Routenprüfung)');
    await act(async () => { optIn.props.onChange({ target: { checked: true } }); });
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('Erzeugter Kalendermonat'));
    expect(world.generateCalls).toBe(1);
    const estimated = collect(renderer.root);
    expect(estimated).toContain('Schätzung, keine Routenprüfung');
    // An estimated month is never validated, and shows no route counters that would read as "0 problems".
    expect(estimated).toContain('VERIFICATION_INCOMPLETE');
    expect(estimated).not.toContain('VALIDATED_FOR_EXPORT:');
    expect(estimated).toContain('Null Warnungen bedeutet hier nichts');
    expect(estimated).not.toContain('Routenkonflikte');
  });

  it('a note that cannot be read stops the run: a missing note is not "no note"', async () => {
    world.noteError = true;
    const renderer = await mount();
    await chooseFebruary(renderer);
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('konnten nicht gelesen werden'));
    expect(collect(renderer.root)).toContain('konnten nicht gelesen werden');
    expect(world.generateCalls).toBe(0);
  });

  it('a real trip of the month is reported as kept, and its driver-day is not simulated over', async () => {
    // Tuesday 10 February 2026, 09:00–09:30 Berlin time, driven by drv-1 in a real import.
    world.realTrips = [{
      id: 'real-1', import_id: 'imp-1', trip_date: '2026-02-10', start_at: '2026-02-10T08:00:00Z', end_at: '2026-02-10T08:30:00Z',
      start_time: '09:00:00', end_time: '09:30:00', original_driver_id: 'drv-1', original_driver_name: 'Fahrer Eins', car_identifier: 'XX-AA 1',
      route_start: 'Teststraße 1', route_end: 'Teststraße 2', price_amount: '12.40', tip_amount: '0.00', cash_amount: '0.00',
      online_amount: '12.40', action_amount: '0.00', is_canceled: false, trip_status: 'completed', declined_fee_cents: null,
      source_row_key: 'k-1', is_simulated: false,
    }];
    const renderer = await mount();
    await chooseFebruary(renderer);
    const before = fake.calls.length;
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('Erzeugter Kalendermonat'));
    expect(collect(renderer.root)).toContain('Echte Fahrten unverändert, ihre Fahrertage nicht simuliert: 1 echte Fahrten (IMPORTIERT) unveraendert, 1 Fahrertage nicht simuliert');
    // Read only, real rows only, around the month; the reader drops a simulated row that still arrives.
    const trips = fake.calls.slice(before).filter(c => c.table === 'fahrtenbuch_trips');
    expect(trips.map(c => c.op)).toEqual(['select']);
    expect(trips[0].filters).toEqual(expect.arrayContaining(['eq:is_simulated', 'gte:trip_date', 'lte:trip_date']));
    expect(world.generateCalls).toBe(1);
  });

  it('real trips that cannot be read stop the run: an unread Fahrtenbuch is not an empty one', async () => {
    world.tripsError = true;
    const renderer = await mount();
    await chooseFebruary(renderer);
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('konnten nicht gelesen werden'));
    expect(collect(renderer.root)).toContain('die echten Fahrten des Monats oder die Simulationseinstellungen des Unternehmens konnten nicht gelesen werden');
    expect(world.generateCalls).toBe(0);
  });

  it('the company\'s stored settings reach the generator: its rate, and the return to the base', async () => {
    world.simulationRow = {
      id: 'set-1', company_id: 'company-1', share_mode: 'random', share_percent: null, share_scope: 'day', seed: 4242,
      return_to_base: true, updated_at: '2026-11-27T10:00:00Z',
    };
    const renderer = await mount();
    await settle(() => collect(renderer.root).includes('Jeder Betriebstag zieht seinen eigenen Satz'));
    await chooseFebruary(renderer);
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('Erzeugter Kalendermonat'));
    expect(world.generatorSettings).toEqual([{ shareSetting: { mode: 'random', scope: 'day', seed: 4242 }, returnToBase: true }]);
    const text = collect(renderer.root);
    expect(text).not.toContain('Kein Anteilssatz festgelegt');
    // The settings are read for the run, scoped to the company, and never written by it.
    const reads = fake.calls.filter(c => c.table === 'company_simulation_settings');
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every(c => c.op === 'select' && c.filters.includes('eq:company_id'))).toBe(true);
  });

  it('settings that cannot be read stop the run: an unread setting is not "not configured"', async () => {
    world.simulationError = true;
    const renderer = await mount();
    await settle(() => collect(renderer.root).includes('Die Simulationseinstellungen konnten nicht geladen werden'));
    await chooseFebruary(renderer);
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    await settle(() => collect(renderer.root).includes('konnten nicht gelesen werden'));
    expect(collect(renderer.root)).toContain('Simulationseinstellungen des Unternehmens konnten nicht gelesen werden');
    expect(world.generateCalls).toBe(0);
  });

  it('a non-administrator sees the settings and is offered no Save', async () => {
    world.isAdmin = false;
    world.simulationRow = {
      id: 'set-1', company_id: 'company-1', share_mode: 'fixed', share_percent: 31, share_scope: null, seed: null,
      return_to_base: false, updated_at: null,
    };
    const renderer = await mount();
    await settle(() => collect(renderer.root).includes('Jeder Tag: 31 %'));
    const text = collect(renderer.root);
    expect(text).toContain('Nur ein Administrator kann diese Einstellungen ändern.');
    expect(renderer.root.findAll(node => node.type === 'button' && collect(node).includes('Einstellungen speichern'))).toEqual([]);
    const mode = renderer.root.findAll(node => node.type === 'select' && node.props.id === 'simsettings-mode')[0];
    expect(mode.props.disabled).toBe(true);
  });

  it('a fee that is not whole cents is refused before anything is read', async () => {
    const renderer = await mount();
    const fee = renderer.root.findAll(node => node.type === 'input' && node.props.value === '6,00')[0];
    await act(async () => { fee.props.onChange({ target: { value: '6,005' } }); });
    const before = fake.calls.length;
    await act(async () => { button(renderer.root, 'Fahrten erzeugen').props.onClick(); });
    expect(collect(renderer.root)).toContain('ganzen Cent');
    expect(fake.calls.length).toBe(before);
    expect(world.generateCalls).toBe(0);
  });
});
