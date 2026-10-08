import { createElement, useState } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { TripRowForAnalysis } from '../../../utils/tripAnalysis/types';

/**
 * The Rückkehrpflicht tab, rendered through the real German dictionary on a
 * small invented month: two vehicles, one order during the previous ride, one
 * at the base, one away from it after a wait, and one ride whose pickup and
 * destination are the same address. No harness renders this tab, so this is
 * the check that it comes up, that every string is a real word, and that it
 * never calls a finding a violation.
 */

vi.mock('../../../contexts/LanguageContext', async () => {
  const { translate, translatePlural } = await import('../../../i18n');
  const value = {
    language: 'de',
    setLanguage: () => {},
    t: (key: never, vars?: never) => translate('de', key, vars),
    tPlural: (keys: never, count: number, vars?: never) => translatePlural('de', keys, count, vars),
  };
  return { useTranslation: () => value };
});

const { ReturnCheckPanel } = await import('./ReturnCheckPanel');
const { EMPTY_BASE_FORM } = await import('../../../utils/returnCheckScreens');
type BaseForm = typeof EMPTY_BASE_FORM;

/** The page's part: it holds the Betriebssitz form, and shows or hides the tab. */
function Host({ shown }: { shown: boolean }) {
  const [form, setForm] = useState<BaseForm>(EMPTY_BASE_FORM);
  if (!shown) return null;
  return createElement(ReturnCheckPanel, {
    tripRows: ROWS,
    blockGapMinutes: 30,
    baseForm: form,
    onBaseForm: (patch: Partial<BaseForm>) => setForm(current => ({ ...current, ...patch })),
  });
}

const SOLINGEN = '51.171300 7.083200';
const DUESSELDORF = '51.227700 6.773500';

function row(id: string, plate: string, start: string, end: string, order: string, position: string, extra: Partial<TripRowForAnalysis> = {}): TripRowForAnalysis {
  return {
    id,
    trip_date: '2026-08-03',
    start_time: start,
    end_time: end,
    original_driver_id: 'd1',
    original_driver_name: 'Fahrer Demo',
    car_identifier: plate,
    route_start: 'Hauptstraße 1, 42651 Solingen, Deutschland',
    route_end: 'Königsallee 1, 40212 Düsseldorf, Deutschland',
    price_amount: '20.00',
    is_canceled: false,
    source_status: 'abgeschlossen',
    source_row_index: 2,
    raw_data_json: {
      'Uhrzeit der Auftragsuebermittlung': `2026-08-03 ${order}:00.000`,
      'Standort des Fahrzeugs bei Auftragsuebermittlung': position,
      'Kilometer': '22.4',
      'Vorreservierte Fahrt': 'Nein',
    },
    start_at: new Date(`2026-08-03T${start}:00`).toISOString(),
    end_at: new Date(`2026-08-03T${end}:00`).toISOString(),
    currency: 'EUR',
    trip_status: 'completed',
    ...extra,
  };
}

const ROWS: TripRowForAnalysis[] = [
  row('a1', 'SG-AB 1', '06:00', '06:30', '05:55', SOLINGEN),
  row('a2', 'SG-AB 1', '06:40', '07:10', '06:20', DUESSELDORF),
  row('a3', 'SG-AB 1', '07:30', '08:00', '07:25', DUESSELDORF),
  row('b1', 'SG-CD 2', '09:00', '09:20', '08:55', SOLINGEN),
  row('b2', 'SG-CD 2', '09:25', '09:40', '09:22', SOLINGEN, {
    route_start: 'Beethovenstraße 12, 42655 Solingen', route_end: 'Beethovenstr. 12, 42655 Solingen',
  }),
];

function collect(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(collect).join(' ');
}

describe('ReturnCheckPanel', () => {
  it('proposes the base, lists what is to review in real words, and never says violation', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Host, { shown: true }));
    });
    await act(async () => { await Promise.resolve(); });
    const screen = collect(renderer.root);

    // a3: ordered at 07:25, 15 minutes after a2 ended, in Düsseldorf.
    expect(screen).toContain('SG-AB 1');
    expect(screen).toContain('07:25');
    expect(screen).toContain('Luftlinie');
    // The same address twice is a finding.
    expect(screen).toMatch(/Beethoven/);
    expect(screen).not.toMatch(/returncheck\.|undefined|NaN/);
    expect(screen).not.toMatch(/Verstoß|Verstoss|illegal|Betrug/i);
  });

  it('keeps the operator’s Betriebssitz when the tab is hidden and shown again', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Host, { shown: true }));
    });
    await act(async () => { await Promise.resolve(); });
    const latitude = () => renderer.root.findAll(node => node.type === 'input')[0];
    await act(async () => { latitude().props.onChange({ target: { value: '51,2000' } }); });
    // Hiding the tab unmounts the panel; the page keeps the form.
    await act(async () => { renderer.update(createElement(Host, { shown: false })); });
    await act(async () => { renderer.update(createElement(Host, { shown: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(latitude().props.value).toBe('51,2000');
  });
});
