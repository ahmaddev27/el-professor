import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanScenario } from '../test-utils/stundennachweisPlanScenarios';

/**
 * What a driver note does to a plan the Stundennachweis page generates.
 *
 * THE RULE BEING PRESERVED, and the one being changed. Preserved: a plan whose
 * input has no note, or only mandatory notes, is exactly what the generators
 * produced before notes learned their behaviour - every minute, every premium
 * bucket, every shift split. Changed: a note used to put "its time plus and
 * minus an hour" on the day in `note_date`, whatever it said, and to leave the
 * rest of its range to be planned as ordinary working days. Now
 *
 *   exclude_from_plan   -> no shift on any day it covers, and not a candidate
 *   must_include_in_plan-> today's window, unchanged
 *   neutral             -> the note puts nothing in; the plan is the plan
 *                          there would be without it
 *
 * and a mandatory note that falls on an absence day is named as a conflict
 * rather than resolved quietly (`monthlyPlan/availability.ts` does the same).
 *
 * The expected lines for the unchanged half are in
 * `test-utils/stundennachweisPlan.golden.json`. They were written by running
 * the generators as they stood before this change, not by reading them.
 * Characterization, not specification: the same file records, for example, the
 * generator missing its salary target by several percent when there are no
 * notes at all, which is why nothing below asserts the target is reached.
 */

vi.mock('../lib/supabase', () => ({ supabase: {} }));
// The PDF and Excel writers are not under test and jsPDF needs a real window.
vi.mock('../utils/stundennachweisPdfExport', () => ({ exportStundennachweisAsPdf: () => {} }));
vi.mock('../utils/fahreruebersichtExport', () => ({ exportFahreruebersichtToExcel: () => {} }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('../hooks/useCompanyScope', () => ({ useCompanyScope: () => ({ can: () => true }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/CompanySettingsContext', () => ({ useCompanySettings: () => ({ settings: null }) }));
// One translator, returning its key and variables, so an assertion can read the sentence.
vi.mock('../contexts/LanguageContext', () => {
  const translation = {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  };
  return { useTranslation: () => translation };
});

const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, { window: eventTarget(), document: { ...eventTarget(), visibilityState: 'visible' } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const page = await import('./StundennachweisPage');
const noteDays = await import('../utils/stundennachweisNoteDays');
const scenarios = await import('../test-utils/stundennachweisPlanScenarios');
const {
  UNCHANGED_SCENARIOS, WINDOWS, absenceRange, mandatoryAt, planLines, remarkAt, runScenario,
  salaryScenario, totalsScenario, rowLine, TOTALS_TARGET,
} = scenarios;
type DayRow = Awaited<ReturnType<typeof page.generatePlan>>[number];
type Note = Parameters<typeof page.applyMustIncludeNotesToRows>[1][number];

const golden: Record<string, string[]> = JSON.parse(
  readFileSync(new URL('../test-utils/stundennachweisPlan.golden.json', import.meta.url), 'utf8'),
);

beforeAll(() => {
  // generatePlanFromTotals reports every target it misses; that is existing and expected here.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

/** The real pipeline of the page: the generator, then the Pflichtnotiz pass naming the absence days. */
function plan(s: PlanScenario): DayRow[] {
  return page.applyMustIncludeNotesToRows(
    runScenario(page, s), s.notes, noteDays.absenceDays(s.notes, s.year, s.month),
  );
}

const march = (notes: Note[], seed = 0) => salaryScenario('march', 2026, 3, seed, WINDOWS.weekdays, notes);
const marchTotals = (notes: Note[], seed = 0) => totalsScenario('march totals', 2026, 3, seed, WINDOWS.everyDay, notes);
const day = (rows: DayRow[], d: number) => rows.find(r => r.dayIndex === d)!;
const hasShift = (r: DayRow) => !!(r.von1 || r.bis1 || r.von2 || r.bis2 || r.von3 || r.bis3);
const isBlank = (r: DayRow) => !hasShift(r) && r.grundlohn === '' && r.nachtarbeit === '' && r.nachtarbeit04 === ''
  && r.samstag === '' && r.sonntag === '' && r.feiertag === '' && r.weihnachten === '';

const SICK = absenceRange('sick', { y: 2026, m: 3, d: 10 }, { y: 2026, m: 3, d: 12 });
const BLITZER_11 = mandatoryAt('blitzer', { y: 2026, m: 3, d: 11, hh: 14, mm: 20 });
const REMARK_11 = remarkAt('remark', { y: 2026, m: 3, d: 11, hh: 14, mm: 20 });

describe('a plan with no note, or only mandatory notes, is what the generators always produced', () => {
  it('has a golden line for every scenario, and no stray one', () => {
    expect(Object.keys(golden).sort()).toEqual(UNCHANGED_SCENARIOS.map(s => s.name).sort());
  });

  it.each(UNCHANGED_SCENARIOS.map(s => [s.name, s] as const))('%s: every row, byte for byte', (name, s) => {
    expect(planLines(plan(s))).toEqual(golden[name]);
  });
});

describe('exclude_from_plan: the day has no shift at all', () => {
  it('empties every day of the range, in salary mode, for every seed', () => {
    for (const seed of [0, 1, 2, 3]) {
      const rows = plan(march([SICK], seed));
      for (const d of [10, 11, 12]) {
        expect(isBlank(day(rows, d)), `seed ${seed}, day ${d}: ${rowLine(day(rows, d))}`).toBe(true);
      }
    }
  });

  it('does not put the note\'s own timestamp on the day it was written (the 00:00-01:00 shift)', () => {
    const rows = plan(march([SICK]));
    expect(day(rows, 10).von1).toBe('');
    expect(day(rows, 10).nachtarbeit04).toBe('');
  });

  it('keeps the allocator off those days: nothing outside the range is flagged, and they were not spent on', () => {
    const rows = plan(march([SICK]));
    expect(rows.filter(r => r.noteHighlight).map(r => r.dayIndex)).toEqual([10, 11, 12]);
    // Weekdays outside the range are still used: the plan is not simply empty.
    expect(rows.filter(r => r.grundlohn).length).toBeGreaterThan(10);
  });

  it('marks each emptied day as a note row, so the PDF prints [N] beside it', () => {
    const rows = plan(march([SICK]));
    for (const d of [10, 11, 12]) expect(day(rows, d).noteHighlight).toBe(true);
  });

  it('empties every day of the range in totals mode too', () => {
    const rows = plan(marchTotals([SICK]));
    for (const d of [10, 11, 12]) expect(isBlank(day(rows, d))).toBe(true);
    expect(rows.filter(r => r.noteHighlight).map(r => r.dayIndex)).toEqual([10, 11, 12]);
  });

  it('totals mode still lands its Grundlohn target on the days that are left', () => {
    const rows = plan(marchTotals([SICK]));
    expect(page.calcTotals(rows).grundlohn).toBe(TOTALS_TARGET.grundlohn);
  });

  it('a range that begins in the previous month empties the first days of this one', () => {
    const note = absenceRange('feb', { y: 2026, m: 2, d: 27 }, { y: 2026, m: 3, d: 3 });
    const rows = plan(march([note]));
    for (const d of [1, 2, 3]) expect(isBlank(day(rows, d))).toBe(true);
    expect(rows.filter(r => r.noteHighlight).map(r => r.dayIndex)).toEqual([1, 2, 3]);
  });

  it('a range that runs past the end of the month empties its last days', () => {
    const note = absenceRange('apr', { y: 2026, m: 3, d: 30 }, { y: 2026, m: 4, d: 2 });
    const rows = plan(march([note]));
    for (const d of [30, 31]) expect(isBlank(day(rows, d))).toBe(true);
  });

  it('is exact across the 23-hour day (29.03.2026)', () => {
    const rows = plan(march([absenceRange('dst', { y: 2026, m: 3, d: 28 }, { y: 2026, m: 3, d: 30 })]));
    expect(rows.filter(r => r.noteHighlight).map(r => r.dayIndex)).toEqual([28, 29, 30]);
    for (const d of [28, 29, 30]) expect(isBlank(day(rows, d))).toBe(true);
  });

  it('is exact across the 25-hour day (25.10.2026)', () => {
    const s = salaryScenario('oct', 2026, 10, 0, WINDOWS.everyDay,
      [absenceRange('dst', { y: 2026, m: 10, d: 24 }, { y: 2026, m: 10, d: 26 })]);
    const rows = plan(s);
    expect(rows.filter(r => r.noteHighlight).map(r => r.dayIndex)).toEqual([24, 25, 26]);
    for (const d of [24, 25, 26]) expect(isBlank(day(rows, d))).toBe(true);
  });

  it('a whole month of absence plans nothing and does not throw', () => {
    const rows = plan(march([absenceRange('all', { y: 2026, m: 3, d: 1 }, { y: 2026, m: 3, d: 31 })]));
    expect(rows.every(isBlank)).toBe(true);
    expect(page.calcTotals(rows).grundlohn).toBe(0);
  });

  it('a note with no stored behaviour is read from its text, as everywhere else', () => {
    const byText = absenceRange('text', { y: 2026, m: 3, d: 10 }, { y: 2026, m: 3, d: 12 }, {
      note_planning_behavior: null, note_text: 'Fahrer krank gemeldet',
    });
    const rows = plan(march([byText]));
    for (const d of [10, 11, 12]) expect(isBlank(day(rows, d))).toBe(true);
  });

  it('a note somebody left neutral stays neutral, even when it says "krank"', () => {
    const left = absenceRange('left', { y: 2026, m: 3, d: 10 }, { y: 2026, m: 3, d: 12 }, {
      note_planning_behavior: 'neutral', note_text: 'krank',
    });
    expect(planLines(plan(march([left])))).toEqual(planLines(plan(march([]))));
  });

  it('a range wholly in another month changes nothing', () => {
    const elsewhere = absenceRange('apr', { y: 2026, m: 4, d: 10 }, { y: 2026, m: 4, d: 12 });
    expect(planLines(plan(march([elsewhere])))).toEqual(planLines(plan(march([]))));
  });

  // DECISION, pinned: a partial-day note blocks its day (see stundennachweisNoteDays.ts).
  it('a note that covers only part of a day blocks the whole day', () => {
    const timed = absenceRange('timed', { y: 2026, m: 3, d: 11 }, { y: 2026, m: 3, d: 11 }, {
      note_text: 'Termin', start_time: '08:00', end_time: '12:00',
    });
    expect(isBlank(day(plan(march([timed])), 11))).toBe(true);
  });
});

describe('must_include_in_plan: today\'s window stays', () => {
  it('puts the note\'s time plus and minus an hour on its day, and flags the row', () => {
    const rows = plan(march([BLITZER_11]));
    expect(day(rows, 11).von1).toBe('13:20');
    expect(day(rows, 11).bis1).toBe('15:20');
    expect(day(rows, 11).noteHighlight).toBe(true);
  });

  it('does the same in totals mode', () => {
    const rows = plan(marchTotals([BLITZER_11]));
    expect(day(rows, 11).von1).toBe('13:20');
    expect(day(rows, 11).bis1).toBe('15:20');
    expect(day(rows, 11).noteHighlight).toBe(true);
  });

  it('two mandatory notes on one day still make two shifts', () => {
    const rows = plan(march([
      mandatoryAt('a', { y: 2026, m: 3, d: 18, hh: 20, mm: 5 }),
      mandatoryAt('b', { y: 2026, m: 3, d: 18, hh: 21, mm: 30 }),
    ]));
    const r = day(rows, 18);
    expect(r.von1).toBe('19:05');
    expect(r.von2).not.toBe('');
  });

  it('a mandatory note next to an absence, not inside it, keeps its window', () => {
    const rows = plan(march([SICK, mandatoryAt('after', { y: 2026, m: 3, d: 13, hh: 9, mm: 0 })]));
    expect(day(rows, 13).von1).toBe('08:00');
    expect(isBlank(day(rows, 12))).toBe(true);
  });
});

describe('neutral: the note puts nothing into the plan', () => {
  it('a remark changes nothing: the plan is the plan without it, row for row', () => {
    expect(planLines(plan(march([REMARK_11])))).toEqual(planLines(plan(march([]))));
    expect(planLines(plan(marchTotals([REMARK_11])))).toEqual(planLines(plan(marchTotals([]))));
  });

  it('a remark does not flag its day, so the day is an ordinary one', () => {
    const rows = plan(march([REMARK_11]));
    expect(rows.some(r => r.noteHighlight)).toBe(false);
  });

  it('a remark beside a mandatory note on the same day does not take its place or its shift', () => {
    const earlier = remarkAt('early', { y: 2026, m: 3, d: 11, hh: 9, mm: 0 });
    expect(planLines(plan(march([earlier, BLITZER_11]))))
      .toEqual(planLines(plan(march([BLITZER_11]))));
  });

  it('a remark inside an absence is not a conflict and changes nothing', () => {
    const rows = plan(march([SICK, REMARK_11]));
    expect(planLines(rows)).toEqual(planLines(plan(march([SICK]))));
  });
});

describe('a mandatory note on an absence day is a named conflict, not a quiet choice', () => {
  const notes = [SICK, BLITZER_11];

  it('the exclusion stays in force: that day has no shift', () => {
    const rows = plan(march(notes));
    expect(isBlank(day(rows, 11))).toBe(true);
    expect(day(rows, 11).noteHighlight).toBe(true);
  });

  it('the whole plan is the plan the absence alone would give', () => {
    expect(planLines(plan(march(notes)))).toEqual(planLines(plan(march([SICK]))));
    expect(planLines(plan(marchTotals(notes)))).toEqual(planLines(plan(marchTotals([SICK]))));
  });

  it('names the pair for the screen', () => {
    const conflicts = noteDays.findNoteConflicts(notes, 2026, 3);
    expect(conflicts.map(c => [c.day, c.mandatory.id, c.absences.map(a => a.id)])).toEqual([[11, 'blitzer', ['sick']]]);
  });

  it('opening a saved sheet is untouched: with no days named, the window is still inserted', () => {
    const blank = plan(march([SICK]));
    const reopened = page.applyMustIncludeNotesToRows(blank, notes);
    expect(day(reopened, 11).von1).toBe('13:50');
    expect(day(reopened, 11).bis1).toBe('14:50');
  });
});

describe('the page names the absence days where it generates, and nowhere else', () => {
  const source = readFileSync(new URL('./StundennachweisPage.tsx', import.meta.url), 'utf8');
  const callLines = source.split('\n').filter(l => l.includes('applyMustIncludeNotesToRows(') && !l.includes('export function'));

  it('has the five call sites it had', () => {
    expect(callLines).toHaveLength(5);
  });

  it('passes the days at the four that generate a plan', () => {
    expect(callLines.filter(l => l.includes('absenceDays('))).toHaveLength(4);
  });

  it('does not pass them when a saved sheet is opened', () => {
    const rest = callLines.filter(l => !l.includes('absenceDays('));
    expect(rest).toHaveLength(1);
    expect(rest[0]).toContain('prev');
  });

  it('selects the two columns the exclusion window reads, in both reads', () => {
    const lists = [...source.matchAll(/'(id, driver_id, note_date[^']*)'/g)].map(m => m[1]);
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      expect(list).toContain('start_time');
      expect(list).toContain('end_time');
    }
  });
});

describe('a blank day says why', () => {
  const text = (tree: ReactTestRenderer): string => {
    const out: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
    };
    walk(tree.toJSON());
    return out.join(' | ');
  };

  const sheet = (rows: DayRow[], absent?: ReadonlySet<number>): ReactTestRenderer => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(createElement(page.Timesheet, {
        driver: { id: 'd1', name: 'Test Fahrer' }, month: 3, year: 2026, rows,
        onRowChange: () => {}, totals: page.calcTotals(rows), targetSalary: 2000, hourlyRate: 14,
        calcSalary: 0, highlightDay: null, absentDays: absent,
      }));
    });
    return tree;
  };
  const labels = (tree: ReactTestRenderer) => text(tree).split('stn.badge.absence').length - 1;

  it('labels each blank absence day on the sheet', () => {
    const rows = plan(march([SICK]));
    expect(labels(sheet(rows, noteDays.absenceDays([SICK], 2026, 3)))).toBe(3);
  });

  it('shows no label when no day is an absence day', () => {
    expect(labels(sheet(plan(march([SICK]))))).toBe(0);
  });

  it('drops the label from a day somebody has since filled in', () => {
    const rows = plan(march([SICK])).map(r => (r.dayIndex === 11 ? { ...r, grundlohn: '04:00' } : r));
    expect(labels(sheet(rows, noteDays.absenceDays([SICK], 2026, 3)))).toBe(2);
  });

  it('says in words that two notes contradict each other, and which', () => {
    const conflicts = noteDays.findNoteConflicts([SICK, BLITZER_11], 2026, 3);
    let tree!: ReactTestRenderer;
    act(() => { tree = create(createElement(page.NoteConflictNotice, { conflicts })); });
    const printed = text(tree);
    expect(printed).toContain('stn.noteConflict.title');
    expect(printed).toContain('stn.noteConflict.item');
    expect(printed).toContain('"date":"11.03.2026"');
    expect(printed).toContain('"mandatory":"Blitzer"');
    expect(printed).toContain('"absence":"Krankmeldung"');
  });

  it('says nothing when the notes agree', () => {
    let tree!: ReactTestRenderer;
    act(() => { tree = create(createElement(page.NoteConflictNotice, { conflicts: [] })); });
    expect(tree.toJSON()).toBeNull();
  });
});
