import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { format } from 'date-fns';

/**
 * The Werkstatt screen's week, and the two defects that made it lie.
 *
 * THE RULE BEING PRESERVED: a business week belongs to the month containing its
 * MONDAY, and a `weekNumber` is that Monday's 1-based ordinal *inside that
 * business month* — 1..5, not an ISO Kalenderwoche. Week 1 of October 2026 is
 * 05.10.–11.10.; week 1 of November 2026 is 02.11.–08.11. So the number alone
 * names no range: the rows read, the week named in the filter band and the week
 * named in the filename must all come from the same (month, weekNumber) pair.
 *
 * What was wrong, and what each case here would have caught:
 *
 *   1. `weeks` was `useState`, written by the effect that watches
 *      `selectedMonth`, while `loadChecks`'s own effect depended on
 *      `[selectedMonth, selectedWeek]`. So the load ran on the same commit as
 *      the month change, with the PREVIOUS month's `weeks` still in state.
 *      - On mount with today in week 1, `weeks` was still `[]`, the reset to 1
 *        changed nothing, the deps never moved: **no query at all**, an empty
 *        list and an empty export (case "mounts").
 *      - On a month change from week 1, it found the OLD month's week 1 and
 *        loaded its rows, and the reset to 1 again changed nothing: the header,
 *        the dropdown, the filter band and the filename said the new month while
 *        the rows were the old month's, with **no error and no toast anywhere**
 *        (case "follows the month").
 *   2. The catch never called `setChecks`, so a failed read left the previous
 *      week's rows on screen and in the export under the new week's name
 *      (case "withholds").
 *
 * And the naming: the filename said `_KW2`. `KW` is *Kalenderwoche*, which this
 * number is not — PR #155 made the same correction to the Belege filename, and
 * the word both the dropdown and that filename use is "Woche".
 */

const world = vi.hoisted(() => ({
  /** Every range actually asked of the database, in order. */
  ranges: [] as { table: string; from?: string; to?: string }[],
  answer: vi.fn(async (): Promise<{ data: Record<string, unknown>[] | null; error: unknown }> => ({ data: [], error: null })),
  exportTableToExcel: vi.fn(),
  showToast: vi.fn(),
  /**
   * One `t`, not a new one per render — a `t` with a fresh identity each render
   * makes every effect that closes over it fire again. It returns its key so an
   * assertion can name the sentence the screen shows.
   */
  translation: {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

vi.mock('../lib/supabase', () => {
  interface Chain {
    select: (columns?: string) => Chain;
    delete: () => Chain;
    eq: (column: string, value: unknown) => Chain;
    gte: (column: string, value: string) => Chain;
    lte: (column: string, value: string) => Chain;
    order: (column: string, options?: { ascending: boolean })
      => Promise<{ data: Record<string, unknown>[] | null; error: unknown }>;
  }
  return {
    supabase: {
      from: (table: string): Chain => {
        const asked: { table: string; from?: string; to?: string } = { table };
        const chain: Chain = {
          select: () => chain,
          delete: () => chain,
          eq: () => chain,
          gte: (_column, value) => { asked.from = value; return chain; },
          lte: (_column, value) => { asked.to = value; return chain; },
          // Recorded where the request is issued, so a load that resolves no
          // week records nothing.
          order: () => { world.ranges.push(asked); return world.answer(); },
        };
        return chain;
      },
    },
  };
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' }, profile: null }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: world.showToast }) }));
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
// xlsx never has to load, and the call is what the export assertions read.
vi.mock('../utils/excelExport', () => ({ exportTableToExcel: world.exportTableToExcel }));

const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, { window: eventTarget(), document: { ...eventTarget(), visibilityState: 'visible' } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: WerkstattPage, resolveWerkstattWeek } = await import('./WerkstattPage');

/** A row of the shape the screen renders, with a plate an assertion can look for. */
const check = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'w1',
  car_id: 'c1',
  week_number: 2,
  year: 2026,
  check_date: '2026-10-13',
  status: 'positive',
  notes: 'Alles in Ordnung',
  repair_notes: null,
  oil_status: 'OK',
  km_stand: 128400,
  car: { kennzeichen: 'HH-AB-1234' },
  ...over,
});

/** Every string the rendered tree prints, flattened. */
function text(tree: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(tree.toJSON());
  return out.join(' | ');
}

/** Lets the effects, their loads and a rejected load's catch all run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function mountOn(today: Date): Promise<ReactTestRenderer> {
  vi.setSystemTime(today);
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(WerkstattPage)); });
  await settle();
  return tree;
}

/** The only button carrying a `title`: the Excel export. */
const exportButton = (tree: ReactTestRenderer) =>
  tree.root.findAll(node => node.type === 'button' && typeof node.props.title === 'string')[0];

const monthButton = (tree: ReactTestRenderer, arrow: string) =>
  tree.root.findAll(node => node.type === 'button' && node.props.children === arrow)[0];

beforeEach(() => {
  // Only Date: the loads settle on microtasks, and faking the timers React's
  // scheduler uses would stall `act`.
  vi.useFakeTimers({ toFake: ['Date'] });
  world.ranges.length = 0;
  world.answer.mockReset().mockResolvedValue({ data: [], error: null });
  world.exportTableToExcel.mockReset();
  world.showToast.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveWerkstattWeek', () => {
  it('gives one week number two different ranges in two different months', () => {
    const october = resolveWerkstattWeek(new Date(2026, 9, 5), 1);
    const november = resolveWerkstattWeek(new Date(2026, 10, 5), 1);

    expect(format(october!.firstDay, 'yyyy-MM-dd')).toBe('2026-10-05');
    expect(format(october!.lastDay, 'yyyy-MM-dd')).toBe('2026-10-11');
    expect(format(november!.firstDay, 'yyyy-MM-dd')).toBe('2026-11-02');
    expect(format(november!.lastDay, 'yyyy-MM-dd')).toBe('2026-11-08');
    // Which is the whole point: the number carries no range of its own, so the
    // month it is resolved against can never be a second, lagging value.
    expect(october!.firstDay.getTime()).not.toBe(november!.firstDay.getTime());
  });

  it('numbers the Mondays of the business month, and answers null past the last', () => {
    // October 2026 has four Mondays: the 5th, 12th, 19th and 26th.
    expect(resolveWerkstattWeek(new Date(2026, 9, 5), 4)).not.toBeNull();
    expect(resolveWerkstattWeek(new Date(2026, 9, 5), 5)).toBeNull();
    expect(resolveWerkstattWeek(new Date(2026, 9, 5), 0)).toBeNull();
    // November 2026 has five, the last of them the 30th.
    const fifth = resolveWerkstattWeek(new Date(2026, 10, 5), 5);
    expect(format(fifth!.firstDay, 'yyyy-MM-dd')).toBe('2026-11-30');
  });

  it('follows the business month, not the calendar month, of its anchor', () => {
    // 01.10.2026 is a Thursday whose Monday is 28.09.2026, so its business month
    // is September — whose four Mondays are the 7th, 14th, 21st and 28th.
    const first = resolveWerkstattWeek(new Date(2026, 9, 1), 1);
    expect(format(first!.firstDay, 'yyyy-MM-dd')).toBe('2026-09-07');
    const fourth = resolveWerkstattWeek(new Date(2026, 9, 1), 4);
    expect(format(fourth!.firstDay, 'yyyy-MM-dd')).toBe('2026-09-28');
    expect(format(fourth!.lastDay, 'yyyy-MM-dd')).toBe('2026-10-04');
  });
});

describe('WerkstattPage: the week it loads', () => {
  it('mounts asking for today’s week exactly once, even when that is week 1', async () => {
    // Monday 05.10.2026 is week 1 of October — the case that never self-healed,
    // because the correction to week 1 changed nothing and so re-ran nothing.
    await mountOn(new Date(2026, 9, 5, 12, 0, 0));

    expect(world.ranges).toHaveLength(1);
    expect(world.ranges[0].from).toBe('2026-10-05');
    expect(world.ranges[0].to).toBe('2026-10-11');
  });

  it('follows the month it is showing, from week 1 to week 1', async () => {
    const tree = await mountOn(new Date(2026, 9, 5, 12, 0, 0));

    await act(async () => { monthButton(tree, '→').props.onClick(); });
    await settle();

    // November's week 1, not October's. This is the silent failure: nothing
    // threw, so the screen simply showed the previous month's rows.
    const last = world.ranges[world.ranges.length - 1];
    expect(last.from).toBe('2026-11-02');
    expect(last.to).toBe('2026-11-08');
    expect(world.showToast).not.toHaveBeenCalled();
  });

  /**
   * A guard, not a regression proof: the old `weeks` state was also settled by
   * the time a test could read it, so this passes on both. It is here so that
   * deriving `weeks` at render cannot quietly empty the dropdown.
   */
  it('offers the weeks of the month it is showing', async () => {
    const tree = await mountOn(new Date(2026, 9, 5, 12, 0, 0));
    const options = tree.root.findAll(node => node.type === 'option');

    expect(options).toHaveLength(4);
    expect(String(options[0].props.children)).toContain('Woche 1');
  });
});

describe('WerkstattPage: a read that failed', () => {
  /** Mounts on week 2 of October with one row, then selects week 3, which fails. */
  async function failOnWeekThree(): Promise<ReactTestRenderer> {
    world.answer.mockResolvedValueOnce({ data: [check()], error: null });
    const tree = await mountOn(new Date(2026, 9, 12, 12, 0, 0));
    expect(text(tree)).toContain('HH-AB-1234');

    world.answer.mockRejectedValueOnce(new Error('Verbindung unterbrochen'));
    await act(async () => { tree.root.findAll(n => n.type === 'select')[0].props.onChange({ target: { value: '3' } }); });
    await settle();
    return tree;
  }

  it('drops the previous week’s rows rather than showing them under the new week', async () => {
    const shown = text(await failOnWeekThree());

    expect(shown).not.toContain('HH-AB-1234');
    expect(shown).toContain('werkstatt.loadFailed');
    expect(shown).toContain('Verbindung unterbrochen');
    // "No checks yet" would be a claim about a week that was never read.
    expect(shown).not.toContain('werkstatt.none');
    // Nor is creating "the first check" offered for a week whose contents are
    // unknown.
    expect(shown).not.toContain('werkstatt.firstCheck');
  });

  it('withholds the export while the read is unaccounted for', async () => {
    const tree = await failOnWeekThree();
    const button = exportButton(tree);

    expect(button.props.disabled).toBe(true);
    // Calling the handler directly is what a browser would not do for a disabled
    // button — which is the point: it proves `handleExport`'s own early return,
    // the second wall, and not just the attribute.
    await act(async () => { button.props.onClick(); });
    expect(world.exportTableToExcel).not.toHaveBeenCalled();
  });
});

describe('WerkstattPage: the export', () => {
  it('names the week the way the screen does, and never as a Kalenderwoche', async () => {
    world.answer.mockResolvedValue({ data: [check()], error: null });
    const tree = await mountOn(new Date(2026, 9, 12, 12, 0, 0));

    await act(async () => { exportButton(tree).props.onClick(); });

    expect(world.exportTableToExcel).toHaveBeenCalledTimes(1);
    const options = world.exportTableToExcel.mock.calls[0][0] as {
      filename: string;
      filterSummary: string[];
      rows: Record<string, unknown>[];
    };
    expect(options.filename).toBe('werkstatt_2026-10_Woche2');
    expect(options.filename).not.toMatch(/KW/);
    // The band names the same week, resolved from the same pair as the rows.
    expect(options.filterSummary.join(' | ')).toContain('Woche 2 (12.10 - 18.10)');
    expect(options.filterSummary.join(' | ')).not.toContain('werkstatt.calendarWeek');
    expect(options.rows).toHaveLength(1);
  });
});
