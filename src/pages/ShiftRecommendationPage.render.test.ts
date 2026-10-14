import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shift recommendation and the planning-type chooser, rendered.
 *
 * No harness renders this screen, so this is the check that it comes up at all
 * and that a whole walk — imports, rides, profile, plan, result — produces a
 * screen of real words: every string goes through the real German dictionary,
 * so a key missing from it renders as the key and fails here.
 */

const world = vi.hoisted(() => ({
  loadImports: vi.fn(),
  loadTripRows: vi.fn(),
  loadSettings: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../lib/tripAnalysisClient', () => ({
  loadImports: world.loadImports,
  loadTripRows: world.loadTripRows,
  loadSettings: world.loadSettings,
}));
vi.mock('../contexts/LanguageContext', async () => {
  const { translate, translatePlural } = await import('../i18n');
  // One object, as the real provider memoises it: a fresh `t` per render would re-run every effect keyed on it.
  const value = {
    language: 'de',
    setLanguage: () => {},
    t: (key: never, vars?: never) => translate('de', key, vars),
    tPlural: (keys: never, count: number, vars?: never) => translatePlural('de', keys, count, vars),
  };
  return { useTranslation: () => value };
});

const { default: ShiftRecommendationPage } = await import('./ShiftRecommendationPage');
const { default: MonthlyPlanEntryPage } = await import('./MonthlyPlanEntryPage');

/** August 2026: two vehicles out every morning 07–10, three rides each. */
function augustRows() {
  const rows: Record<string, unknown>[] = [];
  for (let day = 1; day <= 31; day += 1) {
    const date = `2026-08-${String(day).padStart(2, '0')}`;
    for (const vehicle of ['SG-AB 1', 'SG-AB 2']) {
      for (const [from, to] of [['07:05', '07:50'], ['08:05', '08:50'], ['09:05', '09:50']]) {
        rows.push({
          id: `${vehicle}-${date}-${from}`,
          trip_date: date,
          start_time: from,
          end_time: to,
          original_driver_id: null,
          original_driver_name: 'Fahrer',
          car_identifier: vehicle,
          route_start: null,
          route_end: null,
          price_amount: '28.40',
          cash_amount: day % 2 === 0 ? '28.40' : '0.00',
          online_amount: day % 2 === 0 ? '0.00' : '28.40',
          tip_amount: '1.00',
          is_canceled: false,
          source_status: 'abgeschlossen',
          source_row_index: rows.length + 2,
          raw_data_json: null,
          start_at: new Date(`${date}T${from}:00`).toISOString(),
          end_at: new Date(`${date}T${to}:00`).toISOString(),
          currency: 'EUR',
          trip_status: 'completed',
        });
      }
    }
  }
  return rows;
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll(node => node.type === 'button').filter(node => collect(node).includes(label));
  if (found.length === 0) throw new Error(`no button "${label}"`);
  return found[0];
}

function collect(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(collect).join('');
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('ShiftRecommendationPage', () => {
  beforeEach(() => {
    world.loadImports.mockResolvedValue([
      { id: 'imp-aug', month: 8, year: 2026, file_name: 'august.xlsx', imported_at: '2026-09-02T10:00:00Z', row_count: 186, status: 'completed' },
    ]);
    world.loadTripRows.mockResolvedValue(augustRows());
    world.loadSettings.mockResolvedValue(null);
  });

  it('walks from the imports to a recommendation in real words, and writes nothing', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(ShiftRecommendationPage));
    });
    await settle();
    expect(collect(renderer.root)).toContain('August 2026');

    await act(async () => { button(renderer.root, 'Weiter').props.onClick(); });
    await settle();
    expect(world.loadTripRows).toHaveBeenCalledWith('company-1', 'imp-aug');
    expect(collect(renderer.root)).toContain('SG-AB 1');
    // The reference period is measured from the rows: months, payment split, tips, cancellations.
    const settings = collect(renderer.root);
    expect(settings).toContain('Referenzzeitraum');
    expect(settings).toContain('August 2026: 186 Zeilen');
    expect(settings).toContain('Betriebliche Vorgaben');
    expect(settings).toContain('Ziel-Umsatz für den Monat');

    await act(async () => { button(renderer.root, 'Empfehlung berechnen').props.onClick(); });
    await settle();

    const screen = collect(renderer.root);
    expect(screen).toContain('Empfohlene Schichten');
    // Planned towards a target, so the screen says whether it got there.
    // The history is one step: either both vehicles drive their window or neither does. The
    // plan under the target is empty, says so in euros, and offers the step above rather than
    // padding itself.
    expect(screen).toContain('Ziel nicht genau getroffen');
    expect(screen).toContain('Die nächste Stufe');
    expect(screen).toContain('Blöcke (Schichten)0');

    await act(async () => { button(renderer.root, 'Diesen Plan zeigen').props.onClick(); });
    await settle();
    const stepUp = collect(renderer.root);
    expect(stepUp).toContain('Ziel überschritten (nächsthöhere Stufe)');
    expect(stepUp).toContain('Die Stufe darunter');
    expect(stepUp).toMatch(/07:00 – 10:00/);
    expect(screen).toContain('Betriebstag');
    // Every string came out of the dictionary: no raw key, no undefined, no NaN.
    expect(screen + stepUp).not.toMatch(/shiftrec\.|mplanType\.|undefined|NaN/);
  });

  it('says the imports could not be read rather than offering no month', async () => {
    world.loadImports.mockRejectedValue(new Error('offline'));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(ShiftRecommendationPage));
    });
    await settle();
    expect(collect(renderer.root)).toContain('Importe nicht gelesen');
  });
});

describe('MonthlyPlanEntryPage', () => {
  it('opens on the two planning types', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(MemoryRouter, { initialEntries: ['/monatsplan'] }, createElement(MonthlyPlanEntryPage)));
    });
    const screen = collect(renderer.root);
    expect(screen).toContain('Standardplan verwenden');
    expect(screen).toContain('Schichtempfehlung erstellen');
    expect(screen).not.toMatch(/mplanType\./);
  });
});
