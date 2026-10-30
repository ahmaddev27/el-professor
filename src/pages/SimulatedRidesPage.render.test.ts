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
 * ticked.
 */

const world = vi.hoisted(() => ({
  noteError: false,
  routerDown: false,
  injectViolation: false,
  generateCalls: 0,
  delivered: [] as unknown[],
  built: [] as unknown[],
}));

const POOL = Array.from({ length: 70 }, (_, i) => ({
  label: `Teststraße ${i + 1}, 40210 Demostadt, Deutschland`,
  lat: 51.1 + Math.floor(i / 10) * 0.006,
  lon: 7.02 + (i % 10) * 0.007,
}));
const CENTER = { lat: 51.12, lon: 7.05 };

const fake = createFakeSupabase(call => {
  if (call.table === 'driver_notes' && world.noteError) return { data: null, error: { message: 'boom' } };
  const rows: Record<string, unknown[]> = {
    cars: [
      { id: 'car-1', kennzeichen: 'XX-AA 1', tuev_gueltig_bis: '2027-06-30' },
      { id: 'car-2', kennzeichen: 'XX-AA 2', tuev_gueltig_bis: '2027-06-30' },
    ],
    drivers: [1, 2, 3].map(n => ({ id: `drv-${n}`, allowed_weekdays: null, planning_enabled: true })),
    driver_notes: [],
    werkstatt_checks: [],
  };
  return { data: rows[call.table] ?? [], error: null };
});

vi.mock('../lib/supabase', () => ({ supabase: fake.client }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/CompanySettingsContext', () => ({ useCompanySettings: () => ({ settings: { city: 'Demostadt' } }) }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: () => {} }) }));
vi.mock('../hooks/useCompanyScope', () => ({ useCompanyScope: () => ({ can: () => true, readOnly: false }) }));
vi.mock('../hooks/useFahrtenbuch', () => ({ useFahrtenbuch: () => ({ createImport: async () => {} }) }));
vi.mock('../lib/tripAnalysisClient', () => ({
  loadCompanyDrivers: async () => [1, 2, 3].map(n => ({
    id: `drv-${n}`, name: `Fahrer ${n}`, status: 'active', planning_min_salary: null, planning_max_salary: null, planning_hourly_rate: null,
  })),
  loadSettings: async () => null,
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
    geocode: async (batch: { id: string; text: string }[]) => ({
      ok: true,
      dataUpdated: null,
      results: batch.map(q => {
        const a = POOL.find(p => p.label === q.text)!;
        return { id: q.id, kind: 'located', lat: a.lat, lon: a.lon, precision: 'exact', osm: null };
      }),
    }),
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
    world.routerDown = false;
    world.injectViolation = false;
    world.generateCalls = 0;
    world.delivered.length = 0;
    world.built.length = 0;
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

    const download = button(renderer.root, 'Fahrtenbuch-Bericht herunterladen (SIMULIERT)');
    expect(download.props.disabled).toBeFalsy();
    await act(async () => { download.props.onClick(); });
    const operational = button(renderer.root, 'Betriebsbericht herunterladen (intern, SIMULIERT)');
    await act(async () => { operational.props.onClick(); });
    expect(world.delivered).toEqual([
      [{ version: 1, sheets: [] }, 'SIMULIERT_test.xlsx'],
      [{ version: 1, sheets: [] }, 'SIMULIERT_betrieb.xlsx'],
    ]);
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
