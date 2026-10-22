/**
 * Inputs for the Stundennachweis plan generators, and the one way to read a
 * plan back as text, shared by the golden test and by anything that wants to
 * compare two versions of the generators on the same month.
 *
 * A plan is compared as lines, one per day, not as a hash: when a day moves,
 * the failure names the day and shows both lines. Every field the generators
 * write is in the line (`DayRow` has no other), so "the same line" is "the same
 * row, byte for byte".
 */
import type { DayRow, Note, TotalsTarget, WorkWindowConstraints } from '../pages/StundennachweisPage';

export interface PageGenerators {
  generatePlan: (params: {
    year: number; month: number; targetSalary: number; hourlyRate: number; notes: Note[];
    seed: number; grundlohnRatio: number; bundesland?: string | null; workWindow?: WorkWindowConstraints | null;
  }) => DayRow[];
  generatePlanFromTotals: (
    year: number, month: number, targets: TotalsTarget, notes: Note[], seed: number,
    bundesland?: string | null, workWindow?: WorkWindowConstraints | null,
  ) => DayRow[];
}

/** One day as text: date, weekday flags, the 13 cells, the note marker. */
export function rowLine(r: DayRow): string {
  const d = r.date;
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const flags = `${r.isSat ? 'a' : ''}${r.isSun ? 'u' : ''}${r.isHol ? 'h' : ''}`;
  return [
    key, flags, r.von1, r.bis1, r.von2, r.bis2, r.von3, r.bis3,
    r.grundlohn, r.nachtarbeit, r.nachtarbeit04, r.samstag, r.sonntag, r.feiertag, r.weihnachten,
    r.noteHighlight ? 'N' : '',
  ].join('|');
}

export const planLines = (rows: DayRow[]): string[] => rows.map(rowLine);

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * A note as PostgREST returns it: `note_date` is a `timestamptz`, so it arrives
 * as UTC with an offset, whatever the wall clock was in Berlin. Built from
 * local parts so a scenario reads like the operator's calendar.
 */
export function noteAt(
  id: string,
  at: { y: number; m: number; d: number; hh?: number; mm?: number },
  over: Partial<Note> = {},
): Note {
  const stamp = new Date(at.y, at.m - 1, at.d, at.hh ?? 0, at.mm ?? 0).toISOString().replace('.000Z', '+00:00');
  return {
    id,
    driver_id: 'driver-1',
    note_date: stamp,
    note_text: 'Notiz',
    start_date: null,
    end_date: null,
    is_full_day: false,
    start_time: null,
    end_time: null,
    note_planning_behavior: 'neutral',
    ...over,
  };
}

/** A whole-day range note: sick, vacation. `note_date` is the first day at local midnight. */
export function absenceRange(
  id: string,
  from: { y: number; m: number; d: number },
  to: { y: number; m: number; d: number },
  over: Partial<Note> = {},
): Note {
  return noteAt(id, from, {
    note_text: 'Krankmeldung',
    note_planning_behavior: 'exclude_from_plan',
    start_date: iso(from.y, from.m, from.d),
    end_date: iso(to.y, to.m, to.d),
    ...over,
  });
}

/** A point event the plan must contain: blitzer, accident, kontrolle. */
export function mandatoryAt(
  id: string,
  at: { y: number; m: number; d: number; hh: number; mm: number },
  over: Partial<Note> = {},
): Note {
  return noteAt(id, at, {
    note_text: 'Blitzer',
    note_planning_behavior: 'must_include_in_plan',
    start_date: iso(at.y, at.m, at.d),
    end_date: iso(at.y, at.m, at.d),
    ...over,
  });
}

/** A free-text remark. */
export function remarkAt(
  id: string,
  at: { y: number; m: number; d: number; hh?: number; mm?: number },
  over: Partial<Note> = {},
): Note {
  return noteAt(id, at, {
    note_text: 'Uniform abgeholt',
    note_planning_behavior: 'neutral',
    start_date: iso(at.y, at.m, at.d),
    end_date: iso(at.y, at.m, at.d),
    ...over,
  });
}

/** The work windows a driver profile gives Step 2. */
export const WINDOWS = {
  weekdays: { windowStartMins: 6 * 60, windowEndMins: 20 * 60, allowedWeekdays: [1, 2, 3, 4, 5] } as WorkWindowConstraints,
  everyDay: { windowStartMins: 0, windowEndMins: 23 * 60 + 59, allowedWeekdays: [0, 1, 2, 3, 4, 5, 6] } as WorkWindowConstraints,
  none: null,
} as const;

export interface SalaryScenario {
  kind: 'salary';
  name: string;
  year: number; month: number;
  targetSalary: number; hourlyRate: number; grundlohnRatio: number;
  seed: number; bundesland: string | null;
  workWindow: WorkWindowConstraints | null;
  notes: Note[];
}

export interface TotalsScenario {
  kind: 'totals';
  name: string;
  year: number; month: number;
  targets: TotalsTarget;
  seed: number; bundesland: string | null;
  workWindow: WorkWindowConstraints | null;
  notes: Note[];
}

export type PlanScenario = SalaryScenario | TotalsScenario;

export const TOTALS_TARGET: TotalsTarget = {
  grundlohn: 143 * 60, nachtarbeit: 10 * 60, nacht04: 6 * 60, sonntag: 12 * 60, feiertag: 8 * 60,
};

export const salaryScenario = (
  name: string, year: number, month: number, seed: number, workWindow: WorkWindowConstraints | null,
  notes: Note[] = [], over: Partial<SalaryScenario> = {},
): SalaryScenario => ({
  kind: 'salary', name, year, month, targetSalary: 2000, hourlyRate: 14, grundlohnRatio: 0.85,
  seed, bundesland: 'NW', workWindow, notes, ...over,
});

export const totalsScenario = (
  name: string, year: number, month: number, seed: number, workWindow: WorkWindowConstraints | null,
  notes: Note[] = [],
): TotalsScenario => ({
  kind: 'totals', name, year, month, targets: TOTALS_TARGET, seed, bundesland: 'NW', workWindow, notes,
});

/** Mandatory notes only: three in March, two of them on one day. */
export const MARCH_MANDATORY: Note[] = [
  mandatoryAt('m1', { y: 2026, m: 3, d: 12, hh: 14, mm: 20 }),
  mandatoryAt('m2', { y: 2026, m: 3, d: 18, hh: 20, mm: 5 }, { note_text: 'Unfall' }),
  mandatoryAt('m3', { y: 2026, m: 3, d: 18, hh: 21, mm: 30 }, { note_text: 'Kontrolle' }),
];

/** The cap cases: a note after 23:00 and one just after midnight. */
export const EDGE_MANDATORY: Note[] = [
  mandatoryAt('e1', { y: 2026, m: 3, d: 9, hh: 23, mm: 10 }),
  mandatoryAt('e2', { y: 2026, m: 3, d: 24, hh: 0, mm: 20 }),
];

/**
 * Plans whose input has no note that removes or reshapes a day: no note at all,
 * or mandatory notes only. The generators must produce exactly what they
 * produced before notes learned their behaviour; the expected lines in
 * `stundennachweisPlan.golden.json` were written by the unmodified generators.
 */
export const UNCHANGED_SCENARIOS: PlanScenario[] = [
  // Salary mode, no notes: every month shape the calendar has, four seeds.
  salaryScenario('salary 2026-03 weekdays seed 0', 2026, 3, 0, WINDOWS.weekdays),
  salaryScenario('salary 2026-03 weekdays seed 1', 2026, 3, 1, WINDOWS.weekdays),
  salaryScenario('salary 2026-03 weekdays seed 2', 2026, 3, 2, WINDOWS.weekdays),
  salaryScenario('salary 2026-03 weekdays seed 3', 2026, 3, 3, WINDOWS.weekdays),
  salaryScenario('salary 2026-03 every day seed 0', 2026, 3, 0, WINDOWS.everyDay),
  salaryScenario('salary 2026-03 no window seed 0', 2026, 3, 0, WINDOWS.none),
  salaryScenario('salary 2026-03 high target', 2026, 3, 0, WINDOWS.weekdays, [], { targetSalary: 5000 }),
  salaryScenario('salary 2026-03 low target', 2026, 3, 0, WINDOWS.weekdays, [], { targetSalary: 300 }),
  salaryScenario('salary 2026-02 (28 days)', 2026, 2, 0, WINDOWS.weekdays),
  salaryScenario('salary 2026-05 (holidays)', 2026, 5, 0, WINDOWS.everyDay),
  salaryScenario('salary 2026-10 (25-hour day)', 2026, 10, 0, WINDOWS.everyDay),
  salaryScenario('salary 2026-12 (Christmas)', 2026, 12, 0, WINDOWS.everyDay),
  // Totals mode, no notes.
  totalsScenario('totals 2026-03 weekdays seed 0', 2026, 3, 0, WINDOWS.weekdays),
  totalsScenario('totals 2026-03 weekdays seed 1', 2026, 3, 1, WINDOWS.weekdays),
  totalsScenario('totals 2026-03 every day seed 0', 2026, 3, 0, WINDOWS.everyDay),
  totalsScenario('totals 2026-05 every day seed 0', 2026, 5, 0, WINDOWS.everyDay),
  // Mandatory notes only: today's window must stay, byte for byte.
  salaryScenario('salary 2026-03 mandatory seed 0', 2026, 3, 0, WINDOWS.weekdays, MARCH_MANDATORY),
  salaryScenario('salary 2026-03 mandatory seed 1', 2026, 3, 1, WINDOWS.weekdays, MARCH_MANDATORY),
  salaryScenario('salary 2026-03 mandatory edge', 2026, 3, 0, WINDOWS.weekdays, EDGE_MANDATORY),
  totalsScenario('totals 2026-03 mandatory seed 0', 2026, 3, 0, WINDOWS.weekdays, MARCH_MANDATORY),
  totalsScenario('totals 2026-03 mandatory edge', 2026, 3, 0, WINDOWS.weekdays, EDGE_MANDATORY),
];

/** Runs one scenario through the generator it names. */
export function runScenario(page: PageGenerators, s: PlanScenario): DayRow[] {
  return s.kind === 'salary'
    ? page.generatePlan({
        year: s.year, month: s.month, targetSalary: s.targetSalary, hourlyRate: s.hourlyRate,
        notes: s.notes, seed: s.seed, grundlohnRatio: s.grundlohnRatio, bundesland: s.bundesland,
        workWindow: s.workWindow,
      })
    : page.generatePlanFromTotals(s.year, s.month, s.targets, s.notes, s.seed, s.bundesland, s.workWindow);
}
