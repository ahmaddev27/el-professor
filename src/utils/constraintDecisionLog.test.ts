/**
 * The constraint decision log is only worth having while it describes the plan
 * that was actually made. Its `effect` column is therefore checked against the
 * planner's own `findBlockingNote` over a grid, rather than against a second
 * statement of the rule written in this file.
 *
 * All names are invented: this repository is public.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_NOTE_RULES,
  buildConstraintDecisionLog,
  summariseConstraintLog,
  type ConstraintDecision,
} from './constraintDecisionLog';
import { findBlockingNote } from './driverNoteValidation';
import type { StructuredNote } from './monatsplanungPhase3';

const HOUR = 3_600_000;

type Behavior = StructuredNote['note_planning_behavior'];

/** The pairing `app_private.note_behavior_for` derives; asserted against the migration below. */
const BEHAVIOR_OF: Record<string, Behavior> = {
  general: 'neutral',
  other: 'neutral',
  sick: 'exclude_from_plan',
  vacation: 'exclude_from_plan',
  off: 'exclude_from_plan',
  blitzer: 'must_include_in_plan',
  accident: 'must_include_in_plan',
  kontrolle: 'must_include_in_plan',
  breakdown: 'must_include_in_plan',
  wait: 'must_include_in_plan',
};

let seq = 0;
function note(type: string, over: Partial<StructuredNote> = {}): StructuredNote {
  seq += 1;
  return {
    id: `note-${seq}`,
    driver_id: 'driver-1',
    note_type: type,
    note_text: '',
    note_planning_behavior: BEHAVIOR_OF[type],
    is_full_day: true,
    start_date: '2026-06-10',
    end_date: null,
    note_date: null,
    start_time: null,
    end_time: null,
    ...over,
  };
}

const DRIVER = { id: 'driver-1', name: 'Fahrer 1' };

function logOf(notes: StructuredNote[], asOfDate?: string): ConstraintDecision[] {
  return buildConstraintDecisionLog({
    drivers: [DRIVER],
    driverNotesMap: new Map([[DRIVER.id, notes]]),
    asOfDate,
  });
}

const rowOf = (n: StructuredNote): ConstraintDecision => logOf([n])[0];

// ── 1–4: certainty and effect ───────────────────────────────────────────────

describe('blocking notes', () => {
  it('a blocking note with its own start_date is confirmed and needs no review', () => {
    const row = rowOf(note('sick'));
    expect(row.certainty).toBe('confirmed');
    expect(row.effect).toBe('hard_block');
    expect(row.needsHumanReview).toBe(false);
    expect(row.windowFromNoticeDate).toBe(false);
  });

  // note_date defaults to now(): the moment the notice was typed. Blocking that
  // day is what the planner does, so the log must report it, not hide it.
  it('a blocking note with no start_date falls back to note_date and is flagged for review', () => {
    const row = rowOf(note('vacation', { start_date: null, note_date: '2026-06-12T09:15:00+02:00' }));
    expect({
      certainty: row.certainty,
      effect: row.effect,
      needsHumanReview: row.needsHumanReview,
      windowFromNoticeDate: row.windowFromNoticeDate,
    }).toEqual({
      certainty: 'assumed_from_notice_date',
      effect: 'hard_block',
      needsHumanReview: true,
      windowFromNoticeDate: true,
    });
    expect(row.windowStart).toBe('2026-06-12');
  });

  it('a blocking note whose window yields no interval blocks nothing and is flagged', () => {
    const row = rowOf(note('sick', { start_date: null, note_date: null }));
    expect(row.effect).toBe('none');
    expect(row.needsHumanReview).toBe(true);
  });
});

describe('past-event notes are never a block', () => {
  it.each(['blitzer', 'accident', 'kontrolle', 'breakdown', 'wait'])('%s is human_review', type => {
    const row = rowOf(note(type));
    expect(row.effect).toBe('human_review');
    expect(row.effect).not.toBe('hard_block');
    expect(row.needsHumanReview).toBe(true);
  });
});

describe('neutral notes', () => {
  it.each(['general', 'other'])('%s has no effect', type => {
    const row = rowOf(note(type));
    expect(row.effect).toBe('none');
    expect(row.needsHumanReview).toBe(false);
  });
});

// ── 5: the log agrees with the planner ──────────────────────────────────────

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

interface WindowCase {
  name: string;
  fields: Partial<StructuredNote>;
  /** Written out by hand in local time, so the grid does not lean on the helper under test. */
  intervals: Array<[number, number]>;
}

const WINDOWS: WindowCase[] = [
  { name: 'explicit single day', fields: { start_date: '2026-06-10' }, intervals: [[at(2026, 6, 10), at(2026, 6, 11)]] },
  {
    name: 'fallback to note_date',
    fields: { start_date: null, note_date: '2026-06-12T09:15:00+00:00' },
    intervals: [[at(2026, 6, 12), at(2026, 6, 13)]],
  },
  {
    name: 'timed',
    fields: { is_full_day: false, start_time: '08:00', end_time: '12:00' },
    intervals: [[at(2026, 6, 10, 8), at(2026, 6, 10, 12)]],
  },
  {
    name: 'multi-day',
    fields: { start_date: '2026-06-10', end_date: '2026-06-12' },
    intervals: [[at(2026, 6, 10), at(2026, 6, 11)], [at(2026, 6, 11), at(2026, 6, 12)], [at(2026, 6, 12), at(2026, 6, 13)]],
  },
  {
    name: 'timed across midnight',
    fields: { is_full_day: false, start_time: '22:00', end_time: '06:00' },
    intervals: [[at(2026, 6, 10, 22), at(2026, 6, 11, 6)]],
  },
  {
    name: 'across the spring DST change',
    fields: { start_date: '2026-03-28', end_date: '2026-03-30' },
    intervals: [[at(2026, 3, 28), at(2026, 3, 29)], [at(2026, 3, 29), at(2026, 3, 30)], [at(2026, 3, 30), at(2026, 3, 31)]],
  },
  { name: 'no date at all', fields: { start_date: null, note_date: null }, intervals: [] },
  { name: 'unreadable date', fields: { start_date: 'garbage' }, intervals: [] },
];

function probesFor(intervals: Array<[number, number]>): Array<[string, number, number]> {
  if (intervals.length === 0) return [['anywhere', at(2026, 6, 10, 12), at(2026, 6, 10, 13)]];
  const first = intervals[0];
  const last = intervals[intervals.length - 1];
  return [
    ['inside', first[0] + 10 * 60_000, first[0] + 20 * 60_000],
    ['before', first[0] - 2 * HOUR, first[0] - HOUR],
    ['ends exactly at start', first[0] - HOUR, first[0]],
    ['straddles start', first[0] - HOUR, first[0] + HOUR],
    ['straddles end', last[1] - HOUR, last[1] + HOUR],
    ['starts exactly at end', last[1], last[1] + HOUR],
    ['after', last[1] + HOUR, last[1] + 2 * HOUR],
  ];
}

describe('the log agrees with findBlockingNote', () => {
  const types = ['sick', 'vacation', 'off', 'blitzer', 'accident', 'wait', 'general'];
  let cells = 0;
  let blockingCells = 0;

  for (const type of types) {
    for (const w of WINDOWS) {
      it(`${type} / ${w.name}`, () => {
        const n = note(type, w.fields);
        const row = rowOf(n);
        for (const [label, s, e] of probesFor(w.intervals)) {
          const overlaps = w.intervals.some(([a, b]) => s < b && e > a);
          const logSaysBlocked = row.effect === 'hard_block' && overlaps;
          const plannerBlocks = findBlockingNote('driver-1', s, e, new Map([['driver-1', [n]]])) !== null;
          expect(logSaysBlocked, `${type} / ${w.name} / ${label}`).toBe(plannerBlocks);
          cells += 1;
          if (plannerBlocks) blockingCells += 1;
        }
      });
    }
  }

  // Without this the grid could pass while no cell ever blocked anything.
  it('the grid contains cells where the planner blocks and cells where it does not', () => {
    expect(cells).toBeGreaterThan(200);
    expect(blockingCells).toBeGreaterThan(20);
    expect(blockingCells).toBeLessThan(cells);
  });
});

// ── 6: the legacy token list is held in two places ──────────────────────────

describe('LEGACY_NOTE_RULES', () => {
  it('matches HARD_NOTE_TOKENS in the planner, pattern for pattern and in order', () => {
    const src = readFileSync(fileURLToPath(new URL('./monatsplanungPhase3.ts', import.meta.url)), 'utf8');
    const block = /const HARD_NOTE_TOKENS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src);
    expect(block, 'HARD_NOTE_TOKENS not found in the planner source').not.toBeNull();
    const planner = [...block![1].matchAll(/token:\s*\/((?:\\\/|[^/])+)\/([a-z]*)/g)];
    expect(planner).toHaveLength(10);
    expect(LEGACY_NOTE_RULES.map(r => r.pattern.source)).toEqual(planner.map(m => new RegExp(m[1], m[2]).source));
    expect(LEGACY_NOTE_RULES.map(r => r.pattern.flags)).toEqual(planner.map(m => m[2]));
  });

  it('turns a matching drivers.notes text into a reviewed hard_block row', () => {
    const rows = buildConstraintDecisionLog({
      drivers: [{ id: 'driver-1', name: 'Fahrer 1', notes: 'Bitte KEINE  Nachtschicht, nicht Freitag' }],
      driverNotesMap: new Map(),
    });
    expect(rows.map(r => r.event)).toEqual(['no_night_shift', 'not_friday']);
    expect(rows.every(r => r.effect === 'hard_block' && r.needsHumanReview)).toBe(true);
  });

  it('keeps the note-type pairing used here in step with the database', () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../../supabase/migrations/20261005140000_partner_submissions.sql', import.meta.url)),
      'utf8',
    );
    const pairs = [...sql.matchAll(/WHEN '(\w+)'\s+THEN '(\w+)'/g)].map(m => [m[1], m[2]]);
    expect(Object.fromEntries(pairs)).toEqual(BEHAVIOR_OF);
  });
});

// ── 7: identity ─────────────────────────────────────────────────────────────

describe('identity is matched on the UUID only', () => {
  it('a note keyed to an id outside the pool is unresolved and does nothing', () => {
    const rows = buildConstraintDecisionLog({
      drivers: [DRIVER],
      driverNotesMap: new Map([['driver-unknown', [note('sick', { driver_id: 'driver-unknown' })]]]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subjectId: 'driver-unknown',
      identityMatch: 'unresolved_id',
      effect: 'none',
      needsHumanReview: true,
    });
  });

  it("two drivers with the same name do not borrow each other's notes", () => {
    const rows = buildConstraintDecisionLog({
      drivers: [{ id: 'driver-a', name: 'Fahrer 1' }, { id: 'driver-b', name: 'Fahrer 1' }],
      driverNotesMap: new Map([['driver-a', [note('sick', { driver_id: 'driver-a' })]]]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].subjectId).toBe('driver-a');
    expect(rows.filter(r => r.subjectId === 'driver-b')).toHaveLength(0);
  });
});

// ── 8: vehicles ─────────────────────────────────────────────────────────────

describe('vehicles', () => {
  const car = (tuev?: string | null) => ({ id: 'car-1', plate: 'XX-TEST 1', tuev_gueltig_bis: tuev });
  const tuevRow = (tuev: string | null | undefined, asOf?: string) =>
    buildConstraintDecisionLog({ drivers: [], driverNotesMap: new Map(), vehicles: [car(tuev)], asOfDate: asOf })[0];

  it('an expired TÜV is a hard block', () => {
    expect(tuevRow('2026-05-31', '2026-06-01').effect).toBe('hard_block');
  });
  it('a TÜV valid on the as-of day (inclusive) has no effect', () => {
    expect(tuevRow('2026-06-01', '2026-06-01').effect).toBe('none');
    expect(tuevRow('2027-01-01', '2026-06-01').effect).toBe('none');
  });
  it('a missing TÜV date is human_review, never assumed valid', () => {
    const row = tuevRow(null, '2026-06-01');
    expect(row.effect).toBe('human_review');
    expect(row.needsHumanReview).toBe(true);
  });

  const checkRow = (status: string) =>
    buildConstraintDecisionLog({
      drivers: [],
      driverNotesMap: new Map(),
      vehicles: [car('2027-01-01')],
      werkstattChecks: [{ car_id: 'car-1', check_date: '2026-06-02', status }],
      asOfDate: '2026-06-01',
    }).find(r => r.source === 'vehicle_werkstatt_check')!;

  it('a negative workshop check is human_review and never a block', () => {
    const row = checkRow('negative');
    expect(row.effect).toBe('human_review');
    expect(row.effect).not.toBe('hard_block');
  });
  it('a positive workshop check has no effect', () => {
    expect(checkRow('positive').effect).toBe('none');
  });
});

// ── 9: no clock ─────────────────────────────────────────────────────────────

describe('asOfDate is a parameter, not the clock', () => {
  const run = (asOf: string) =>
    buildConstraintDecisionLog({
      drivers: [],
      driverNotesMap: new Map(),
      vehicles: [{ id: 'car-1', plate: 'XX-TEST 1', tuev_gueltig_bis: '2026-06-15' }],
      asOfDate: asOf,
    });

  it('the same input gives the same log', () => {
    expect(run('2026-06-01')).toEqual(run('2026-06-01'));
  });
  it('a different as-of date gives a different verdict', () => {
    expect(run('2026-06-01')[0].effect).toBe('none');
    expect(run('2026-07-01')[0].effect).toBe('hard_block');
  });
});

// ── 10: summary ─────────────────────────────────────────────────────────────

describe('summariseConstraintLog', () => {
  it('counts what the rows say', () => {
    const rows = buildConstraintDecisionLog({
      drivers: [DRIVER],
      driverNotesMap: new Map([
        [DRIVER.id, [note('sick'), note('vacation', { start_date: null, note_date: '2026-06-12T09:00:00Z' }), note('blitzer'), note('general')]],
        ['driver-unknown', [note('sick', { driver_id: 'driver-unknown' })]],
      ]),
      vehicles: [{ id: 'car-1', plate: 'XX-TEST 1', tuev_gueltig_bis: '2026-01-01' }],
      asOfDate: '2026-06-01',
    });
    expect(summariseConstraintLog(rows)).toEqual({
      rows: 6,
      hardBlocks: 3,
      humanReview: 1,
      none: 2,
      fromNoticeDate: 1,
      unresolvedIdentity: 1,
    });
  });
});
