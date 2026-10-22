/**
 * The manual resolver reads the structured notes, not only the free-text one.
 *
 * ── The rule this file preserves ──────────────────────────────────────────────
 *
 * CLAUDE.md fixes Phase 3's rejection split and nothing here moves it:
 * `note_constraint` is HARD — no manual exception may bypass it — beside
 * `wrong_weekday`, `driver_overlap`, `vehicle_switch_buffer_violation` and
 * `one_vehicle_per_day`. A driver whose `exclude_from_plan` note (Krank, Urlaub,
 * Nicht verfügbar) overlaps a block cannot take that block, whoever is choosing:
 * the automatic pass, which asks `checkStructuredNote` per candidate, or a person
 * in the "Manuell lösen" dialog, which asks `evaluateManualCandidate` — and
 * `applyManualAssignment` asks it again before it writes anything.
 *
 * ── The defect ────────────────────────────────────────────────────────────────
 *
 * `evaluateManualCandidate` asked `checkNote` only, the regex over the legacy
 * free-text `drivers.notes`, and said why in a comment: structured notes were
 * "not available in manual eval without notes map". The Notizen screen writes
 * `driver_notes`, so the rows that matter — sick, vacation — were never consulted
 * when a person picked the driver. The dialog drew a driver on sick leave green,
 * and the one wall left was the export check, `validateDriverNotesForPlanStep`,
 * which fires when the plan is built for export, not when it is assigned.
 *
 * Its neighbour, the note *window*, has a measured cost: while the window was built
 * at UTC midnight, 11 real rides on staging went to drivers recorded as sick
 * (monatsplanungPhase3.windows.test.ts, item 6). How many this one let through has
 * not been measured.
 *
 * ── What the tests do ─────────────────────────────────────────────────────────
 *
 * The notes arrive as an argument, because the result a manual call is given does
 * not carry them (`Phase3Result.options` keeps three settings and no map), and the
 * argument is required, so a caller that forgets it does not compile.
 *
 * Every probe re-opens a block the automatic pass had given to D1 — the dialog's
 * "Manuell lösen" — and asks whether D1 may take it back, once per window shape the
 * note arithmetic has: a whole day, a time inside a day, and a time across
 * midnight. The windows themselves are `noteExclusionIntervals`' and are tested in
 * the windows file; what is asserted here is that this path reaches them, so a
 * probe that sits on a boundary (a block that ends exactly where the note starts)
 * is a probe that a hand-rolled window would get wrong.
 *
 * Each case that must refuse is paired with the nearest case that must not, so a
 * check that refuses everything fails as surely as one that refuses nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  applyManualAssignment,
  assignBlocksPhase3,
  evaluateManualCandidate,
  unassignBlock,
  type ManualAssignOptions,
  type Phase3Result,
  type StructuredNote,
} from './monatsplanungPhase3';
import type { Phase1VehicleBlock } from './monatsplanungPhase1';
import type { PlanningDriver } from '../components/MonatsplanungDriverPool';
import { block, driver, note } from '../test-utils/phase3Fixtures';

// ── fixtures ────────────────────────────────────────────────────────────────

type NotesMap = Map<string, StructuredNote[]>;
const notesFor = (n: StructuredNote, driverId = 'D1'): NotesMap => new Map([[driverId, [n]]]);
const NO_NOTES: NotesMap = new Map();

const NOTE_CHECK = 'Notiz-Einschränkung';
const STRICT: ManualAssignOptions = { allowDienstzeit: false, allowDaily: false, allowMonthly: false };
const EVERY_EXCEPTION: ManualAssignOptions = { allowDienstzeit: true, allowDaily: true, allowMonthly: true };

/**
 * The dialog's "Manuell lösen": the automatic pass gave the block to D1 — it knew
 * of no note — and the operator takes it back, so D1 is free and the block is open.
 */
function reopened(b: Phase1VehicleBlock, d: PlanningDriver = driver()): Phase3Result {
  const planned = assignBlocksPhase3([b], [d], { oneVehiclePerDriverDay: true });
  expect(planned.assigned.map(a => a.block_id)).toEqual([b.block_id]);
  const open = unassignBlock(planned, [d], b.block_id);
  expect(open.unassigned.map(u => u.block_id)).toEqual([b.block_id]);
  return open;
}

/**
 * A block the automatic pass could not give D1 — because of what it was told about
 * D1 — so it starts out open, the way a refused block reaches the dialog.
 */
function leftOpen(b: Phase1VehicleBlock, d: PlanningDriver, notes: NotesMap): Phase3Result {
  const planned = assignBlocksPhase3([b], [d], { oneVehiclePerDriverDay: true, driverNotesMap: notes });
  expect(planned.unassigned.map(u => u.block_id)).toEqual([b.block_id]);
  return planned;
}

/** What the dialog asks about its one open block and D1. */
function ask(r: Phase3Result, notes: NotesMap, options: ManualAssignOptions = STRICT) {
  return evaluateManualCandidate(r, r.unassigned[0].block_id, 'D1', options, notes);
}

// ── the three window shapes ─────────────────────────────────────────────────

interface Probe {
  name: string;
  /** [service date, start, end] of the open block. */
  block: [string, string, string];
  refused: boolean;
}

const SHAPES: Array<{ shape: string; note: StructuredNote; probes: Probe[] }> = [
  {
    shape: 'a whole day (Friday 22.05.)',
    note: note(),
    probes: [
      { name: 'refuses a block in the middle of the day', block: ['2026-05-22', '10:00', '12:00'], refused: true },
      // The first hours of a note's first day: the gap a UTC-midnight window left open.
      { name: 'refuses a block in the first hour of the day', block: ['2026-05-22', '00:30', '01:00'], refused: true },
      { name: 'refuses an evening block that runs into the next day', block: ['2026-05-22', '23:00', '01:00'], refused: true },
      { name: 'refuses a block from the day before that runs into the noted morning', block: ['2026-05-21', '23:00', '01:00'], refused: true },
      { name: 'allows the same hours on the day before', block: ['2026-05-21', '10:00', '12:00'], refused: false },
      { name: 'allows the first hour of the day after', block: ['2026-05-23', '00:30', '01:00'], refused: false },
    ],
  },
  {
    shape: 'a time inside a day (08:00–12:00)',
    note: note({ is_full_day: false, start_time: '08:00', end_time: '12:00' }),
    probes: [
      { name: 'refuses a block inside it', block: ['2026-05-22', '09:00', '10:00'], refused: true },
      { name: 'refuses a block that starts before it and overlaps its start', block: ['2026-05-22', '07:30', '08:30'], refused: true },
      { name: 'refuses a block that overlaps its end', block: ['2026-05-22', '11:30', '12:30'], refused: true },
      { name: 'allows a block that ends exactly where it starts', block: ['2026-05-22', '06:00', '08:00'], refused: false },
      { name: 'allows a block that starts exactly where it ends', block: ['2026-05-22', '12:00', '13:00'], refused: false },
      { name: 'allows the afternoon of the same day', block: ['2026-05-22', '14:00', '16:00'], refused: false },
      { name: 'allows the same hours on the next day', block: ['2026-05-23', '09:00', '10:00'], refused: false },
    ],
  },
  {
    shape: 'a time across midnight (22:00–06:00)',
    note: note({ is_full_day: false, start_time: '22:00', end_time: '06:00' }),
    probes: [
      { name: 'refuses a block in the evening part', block: ['2026-05-22', '22:30', '23:30'], refused: true },
      { name: 'refuses a block wholly after midnight, on the next calendar day', block: ['2026-05-23', '01:00', '02:00'], refused: true },
      { name: 'refuses a block that crosses midnight', block: ['2026-05-22', '23:00', '01:00'], refused: true },
      { name: 'allows a block that ends exactly where it starts', block: ['2026-05-22', '20:00', '22:00'], refused: false },
      { name: 'allows a block that starts exactly where it ends', block: ['2026-05-23', '06:00', '08:00'], refused: false },
      { name: 'allows the small hours before it, which belong to no noted evening', block: ['2026-05-22', '01:00', '02:00'], refused: false },
      { name: 'allows the next evening', block: ['2026-05-23', '22:30', '23:30'], refused: false },
    ],
  },
  {
    shape: 'a range of days (20.–24.05., all day)',
    note: note({ start_date: '2026-05-20', end_date: '2026-05-24' }),
    probes: [
      { name: 'refuses the first day', block: ['2026-05-20', '09:00', '10:00'], refused: true },
      { name: 'refuses the last day, which is inclusive', block: ['2026-05-24', '09:00', '10:00'], refused: true },
      { name: 'allows the day before', block: ['2026-05-19', '09:00', '10:00'], refused: false },
      { name: 'allows the day after', block: ['2026-05-25', '09:00', '10:00'], refused: false },
    ],
  },
];

describe.each(SHAPES.map(s => [s.shape, s] as const))('a note covering %s', (_shape, { note: n, probes }) => {
  it.each(probes.map(p => [p.name, p] as const))('%s', (_name, { block: [date, from, to], refused }) => {
    const e = ask(reopened(block('B', date, from, to)), notesFor(n));
    expect(e.blockingChecks.includes(NOTE_CHECK)).toBe(refused);
    expect(e.feasible).toBe(!refused);
  });
});

describe('the days the clocks change', () => {
  // A day is 25 hours on 25.10.2026 and 23 on 29.03.2026. A window made by adding
  // 24 hours to local midnight ends an hour early on the first and an hour late on
  // the second — the first is the direction in which a hard constraint fails open.
  it('refuses the last half hour of a 25-hour day', () => {
    const n = note({ start_date: '2026-10-25', end_date: '2026-10-25' });
    expect(ask(reopened(block('B', '2026-10-25', '23:30', '23:50')), notesFor(n)).blockingChecks).toContain(NOTE_CHECK);
  });

  it('allows the first hour after a 23-hour day', () => {
    const n = note({ start_date: '2026-03-29', end_date: '2026-03-29' });
    expect(ask(reopened(block('B', '2026-03-30', '00:30', '00:50')), notesFor(n)).blockingChecks).not.toContain(NOTE_CHECK);
  });
});

// ── which notes count ───────────────────────────────────────────────────────

describe('which notes count', () => {
  const midday = () => reopened(block('B', '2026-05-22', '10:00', '12:00'));

  it.each(['neutral', 'must_include_in_plan'] as const)('ignores a %s note over the block', behavior => {
    const e = ask(midday(), notesFor(note({ note_planning_behavior: behavior })));
    expect(e.blockingChecks).not.toContain(NOTE_CHECK);
    expect(e.feasible).toBe(true);
  });

  it('ignores another driver\'s note', () => {
    const e = ask(midday(), notesFor(note({ driver_id: 'D2' }), 'D2'));
    expect(e.blockingChecks).not.toContain(NOTE_CHECK);
    expect(e.feasible).toBe(true);
  });

  it('has nothing to refuse on when no notes are known', () => {
    // The state after a failed driver_notes read. The screen's apply gate is what
    // refuses a plan in that state; this pins that the engine does not invent a note.
    const e = ask(midday(), NO_NOTES);
    expect(e.feasible).toBe(true);
    expect(e.blockingChecks).toEqual([]);
  });

  it('still refuses on the legacy free-text note', () => {
    // 22.05.2026 is a Friday. The structured check was added beside this one.
    const open = leftOpen(block('B', '2026-05-22', '10:00', '12:00'), driver({ notes: 'nicht Freitag' }), NO_NOTES);
    const e = ask(open, NO_NOTES);
    expect(e.blockingChecks).toEqual([NOTE_CHECK]);
    expect(e.feasible).toBe(false);
  });

  it('names the refusal once when both kinds of note apply', () => {
    const notes = notesFor(note());
    const open = leftOpen(block('B', '2026-05-22', '10:00', '12:00'), driver({ notes: 'nicht Freitag' }), notes);
    const e = ask(open, notes);
    expect(e.blockingChecks.filter(c => c === NOTE_CHECK)).toHaveLength(1);
    expect(e.reason).toBe(NOTE_CHECK);
  });
});

// ── the refusal is hard ─────────────────────────────────────────────────────

describe('the refusal is hard', () => {
  it('refuses the driver the automatic pass refused for the same note', () => {
    const notes = notesFor(note());
    const planned = leftOpen(block('B', '2026-05-22', '10:00', '12:00'), driver(), notes);
    // The automatic pass leaves the block open and says why…
    expect(planned.unassigned[0].rejected.map(x => x.reason)).toContain('note_constraint');
    // …the dialog must say the same, and used to say "possible" (the control).
    expect(ask(planned, notes)).toMatchObject({ feasible: false, blockingChecks: [NOTE_CHECK] });
    expect(ask(planned, NO_NOTES)).toMatchObject({ feasible: true, blockingChecks: [] });
  });

  it('is not undone by any exception the dialog can grant', () => {
    const e = ask(reopened(block('B', '2026-05-22', '10:00', '12:00')), notesFor(note()), EVERY_EXCEPTION);
    expect(e.feasible).toBe(false);
    expect(e.blockingChecks).toContain(NOTE_CHECK);
  });
});

describe('applyManualAssignment asks the same question before it writes', () => {
  it('refuses, and returns the plan it was given unchanged', () => {
    const open = reopened(block('B', '2026-05-22', '10:00', '12:00'));
    const r = applyManualAssignment(open, [driver()], 'B', 'D1', EVERY_EXCEPTION, notesFor(note()));
    expect(r.ok).toBe(false);
    expect(r.blockingChecks).toContain(NOTE_CHECK);
    expect(r.result).toBe(open);
    expect(r.result.assigned).toEqual([]);
    expect(r.result.unassigned.map(u => u.block_id)).toEqual(['B']);
  });

  it('assigns when the note does not reach the block (the control)', () => {
    const open = reopened(block('B', '2026-05-22', '10:00', '12:00'));
    const r = applyManualAssignment(open, [driver()], 'B', 'D1', STRICT, notesFor(note({ start_date: '2026-05-23', end_date: '2026-05-23' })));
    expect(r.ok).toBe(true);
    expect(r.result.assigned.map(a => [a.block_id, a.driver_id])).toEqual([['B', 'D1']]);
    expect(r.result.unassigned).toEqual([]);
  });
});
