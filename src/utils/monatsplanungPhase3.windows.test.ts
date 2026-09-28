/**
 * Phase 3's two time windows: a driver's Dienstzeit, and an `exclude_from_plan`
 * note's range. Both were built on a base that did not match the instants they
 * were compared against.
 *
 * ── The rule this file preserves ──────────────────────────────────────────────
 *
 * CLAUDE.md fixes Phase 3's rejection split, and nothing here moves it. HARD:
 * `wrong_weekday`, `driver_overlap`, `vehicle_switch_buffer_violation`,
 * `one_vehicle_per_day`, `note_constraint`. BYPASSABLE by a manual exception:
 * `outside_working_time_window`, `daily_max_exceeded`, `monthly_max_exceeded`.
 * Item 5 widens a bypassable refusal; item 6 corrects when a hard one fires. The
 * tests at the end assert the split itself, so a later change cannot quietly move
 * a reason from one list to the other.
 *
 * ── Item 5: an overnight Dienstzeit had only its evening half ─────────────────
 *
 * `blockTimeOfDayMinutes` measures a block from its *start* day's midnight. A
 * window whose end is not after its start — 20:00–06:00 — is two stretches of
 * every day, 20:00→24:00 and 00:00→06:00, and the check tested only the first:
 * `bStart >= wStart && bEnd <= 24*60 + wEnd`. A night driver's ordinary
 * 01:00–03:00 has `bStart` 60 against `wStart` 1200, so every block lying wholly
 * after midnight was refused inside the driver's own window. Measured on staging
 * 28.09.2026: 10 drivers carry an overnight window and 7 of them reach this check
 * (the other 3 are `is_full_day_available`, which returns before it).
 *
 * The rule lived in two places, `checkWindow` and `evaluateManualCandidate`, so
 * the preview and the manual dialog could disagree about one block. It is now one
 * function, `blockFitsWorkWindow`, and both tests below go through a different
 * caller to prove both sites moved.
 *
 * ── Item 6: the note window was built at UTC midnight ────────────────────────
 *
 * Block instants are local — Phase 1 builds `actual_start_ms` with
 * `new Date(y, m, d, h, min)` — but both copies of the note window started at
 * `Date.UTC(...)` and stepped by 86 400 000 ms. In Europe/Berlin that opened the
 * window one hour late in winter and two in summer, so the hard `note_constraint`
 * failed OPEN over the first hours of a note's first day.
 *
 * Measured on staging 28.09.2026 against the 9 live `exclude_from_plan` notes (all
 * full-day; none carries both times): 53 rides fell inside the window as it was
 * built, 64 inside the correct one, and all 11 in the gap were 00:00–02:00 local
 * on the first day of a note's range — rides handed to a driver recorded as sick
 * or on holiday. 0 rides sat in the mirror-image gap at the end of a range, so the
 * fix takes nothing away from anyone today; the `02:30 on the day after` test
 * below pins that direction anyway, because the mechanism is real even where the
 * data is empty.
 *
 * ── How the negative controls work ────────────────────────────────────────────
 *
 * `legacyBlockFitsWindow` and `legacyNoteIntervals` are the old rules, copied
 * verbatim in behaviour. Each pair of assertions says what the old rule answered
 * AND that production now answers differently at that exact probe. Revert either
 * fix and production starts agreeing with the legacy copy, which is what fails.
 * Every other probe asserts the two still agree, so the change stays surgical.
 */
import { describe, it, expect } from 'vitest';
import { assignBlocksPhase3, evaluateManualCandidate, type StructuredNote } from './monatsplanungPhase3';
import { findBlockingNote, noteExclusionIntervals } from './driverNoteValidation';
import type { Phase1VehicleBlock } from './monatsplanungPhase1';
import type { PlanningDriver } from '../components/MonatsplanungDriverPool';

// ── fixtures ────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const isoLocal = (dt: Date) =>
  `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;

/**
 * A one-trip block, built the way Phase 1 builds one: `block_*_datetime` is the
 * local wall clock and `actual_*_ms` the same moment as an instant. An end at or
 * before the start runs into the next day.
 */
function block(
  id: string,
  date: string,
  startHHMM: string,
  endHHMM: string,
  vehicle = 'V1',
): Phase1VehicleBlock {
  const [y, mo, d] = date.split('-').map(Number);
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  const start = new Date(y, mo - 1, d, sh, sm);
  let end = new Date(y, mo - 1, d, eh, em);
  if (end.getTime() <= start.getTime()) end = new Date(y, mo - 1, d + 1, eh, em);
  return {
    block_id: id,
    vehicle_id: vehicle,
    vehicle_identifier: `${vehicle}-AB-123`,
    service_date: date,
    block_start_datetime: isoLocal(start),
    block_end_datetime: isoLocal(end),
    duration_minutes: Math.round((end.getTime() - start.getTime()) / 60_000),
    trip_ids: [`${id}-t1`],
    trip_count: 1,
    first_trip_id: `${id}-t1`,
    last_trip_id: `${id}-t1`,
    first_excel_row: 1,
    last_excel_row: 1,
    trip_rows: [{ trip_id: `${id}-t1`, excel_row: 1, start_datetime: isoLocal(start), end_datetime: isoLocal(end) }],
    split_reason: 'gap_gt_60',
    internal_gaps: [],
    longest_internal_gap_minutes: 0,
    merge_status: 'none',
    actual_start_ms: start.getTime(),
    actual_end_ms: end.getTime(),
  };
}

/** A night driver: Dienstzeit 20:00–06:00, not full-day-available. */
function driver(over: Partial<PlanningDriver> = {}): PlanningDriver {
  return {
    id: 'D1',
    name: 'Nacht Fahrer',
    driver_usage_type: 'regular',
    planning_enabled: true,
    status: 'active',
    work_window_start: '20:00',
    work_window_end: '06:00',
    allowed_weekdays: null,
    max_daily_hours: 10,
    target_monthly_hours: 160,
    max_monthly_hours: 300,
    planning_target_salary: null,
    planning_min_salary: null,
    planning_max_salary: null,
    planning_hourly_rate: null,
    notes: null,
    is_full_day_available: false,
    employment_type: 'employee',
    ...over,
  };
}

/** A full-day exclude_from_plan note on 22.05.2026 — the shape all 9 live ones have. */
function note(over: Partial<StructuredNote> = {}): StructuredNote {
  return {
    id: 'N1',
    driver_id: 'D1',
    note_type: 'sick',
    note_text: '',
    note_planning_behavior: 'exclude_from_plan',
    is_full_day: true,
    start_date: '2026-05-22',
    end_date: '2026-05-22',
    note_date: null,
    start_time: null,
    end_time: null,
    ...over,
  };
}

const notesFor = (n: StructuredNote) => new Map<string, StructuredNote[]>([['D1', [n]]]);

/** A driver with no Dienstzeit at all, so only the note can refuse a block. */
const anyTimeDriver = driver({
  is_full_day_available: true,
  work_window_start: null,
  work_window_end: null,
});

/** Local ms for a wall clock, which is what every instant here is. */
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();

/** Which blocks did the engine record as sitting outside their driver's Dienstzeit? */
function windowViolations(blocks: Phase1VehicleBlock[], drivers: PlanningDriver[]): string[] {
  const r = assignBlocksPhase3(blocks, drivers, { oneVehiclePerDriverDay: true });
  return r.window_violation_details.map(w => w.block_id);
}

// ── the legacy rules, for the negative controls ──────────────────────────────

/** The Dienstzeit rule before item 5: the evening arm only. */
function legacyBlockFitsWindow(bStart: number, bEnd: number, wStart: number, wEnd: number): boolean {
  return wStart <= wEnd
    ? bStart >= wStart && bEnd <= wEnd
    : bStart >= wStart && bEnd <= 24 * 60 + wEnd;
}

/** The note window before item 6: UTC midnight, stepped by 86 400 000 ms. */
function legacyNoteIntervals(n: StructuredNote): { start: number; end: number }[] {
  const MS_PER_DAY = 86_400_000;
  const parse = (d: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  };
  const toMin = (t: string) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(t);
    return m ? +m[1] * 60 + +m[2] : null;
  };
  const startDate = n.start_date ?? (n.note_date ? n.note_date.slice(0, 10) : null);
  const endDate = n.end_date ?? startDate;
  if (!startDate || !endDate) return [];
  const rangeStart = parse(startDate);
  const rangeEnd = parse(endDate);
  if (isNaN(rangeStart) || isNaN(rangeEnd)) return [];
  const capped = Math.min(rangeEnd, rangeStart + 366 * MS_PER_DAY);
  const out: { start: number; end: number }[] = [];
  for (let dateMs = rangeStart; dateMs <= capped; dateMs += MS_PER_DAY) {
    if (n.is_full_day || !n.start_time || !n.end_time) {
      out.push({ start: dateMs, end: dateMs + MS_PER_DAY });
      continue;
    }
    const sMin = toMin(n.start_time);
    const eMin = toMin(n.end_time);
    if (sMin == null || eMin == null) out.push({ start: dateMs, end: dateMs + MS_PER_DAY });
    else if (eMin > sMin) out.push({ start: dateMs + sMin * 60_000, end: dateMs + eMin * 60_000 });
    else out.push({ start: dateMs + sMin * 60_000, end: dateMs + MS_PER_DAY + eMin * 60_000 });
  }
  return out;
}

/** Half-open overlap, the one test both engines use. */
const covers = (ivs: { start: number; end: number }[], s: number, e: number) =>
  ivs.some(iv => s < iv.end && e > iv.start);

// ── the zone ────────────────────────────────────────────────────────────────

describe('the timezone these figures are stated in', () => {
  it('is Europe/Berlin, or nothing below means anything', () => {
    // vitest.config.ts sets TZ before any module evaluates a Date.
    expect(new Date(2026, 4, 22).getTimezoneOffset()).toBe(-120); // CEST, UTC+2
    expect(new Date(2026, 1, 1).getTimezoneOffset()).toBe(-60);   // CET,  UTC+1
  });
});

// ── item 5 ──────────────────────────────────────────────────────────────────

describe('an overnight Dienstzeit covers both sides of midnight', () => {
  it('accepts a block lying wholly after midnight, inside the window', () => {
    // 01:00–03:00 against 20:00–06:00. This is the defect: 7 live drivers.
    expect(windowViolations([block('B1', '2026-05-12', '01:00', '03:00')], [driver()])).toEqual([]);
  });

  it('still accepts the evening side, which always worked', () => {
    expect(windowViolations([block('B2', '2026-05-12', '21:00', '23:00')], [driver()])).toEqual([]);
  });

  it('still accepts a block that crosses midnight inside the window', () => {
    expect(windowViolations([block('B3', '2026-05-12', '22:00', '02:00')], [driver()])).toEqual([]);
  });

  it('counts no violation for the night block in the validation summary either', () => {
    const r = assignBlocksPhase3([block('B1', '2026-05-12', '01:00', '03:00')], [driver()], {
      oneVehiclePerDriverDay: true,
    });
    expect(r.validation.working_time_window_violations).toBe(0);
  });

  // NEGATIVE CONTROLS — a block genuinely outside the window is still refused.
  it('still refuses a midday block', () => {
    expect(windowViolations([block('B4', '2026-05-12', '10:00', '12:00')], [driver()])).toEqual(['B4']);
  });

  it('still refuses a block that runs past the window end', () => {
    // 04:00–08:00 ends after 06:00. `bEnd <= wEnd` must not rescue it.
    expect(windowViolations([block('B5', '2026-05-12', '04:00', '08:00')], [driver()])).toEqual(['B5']);
  });

  it('still refuses a night block for a daytime driver', () => {
    // 08:00–16:00 is not an overnight window, so the second arm must not apply.
    const day = driver({ work_window_start: '08:00', work_window_end: '16:00' });
    expect(windowViolations([block('B6', '2026-05-12', '01:00', '03:00')], [day])).toEqual(['B6']);
  });

  it('is the rule the old one got wrong, and only there', () => {
    // 20:00–06:00 as minutes, blocks as blockTimeOfDayMinutes reports them.
    const w: [number, number] = [20 * 60, 6 * 60];
    // The one case that moved: wholly after midnight.
    expect(legacyBlockFitsWindow(1 * 60, 3 * 60, ...w)).toBe(false);
    expect(windowViolations([block('B1', '2026-05-12', '01:00', '03:00')], [driver()])).toEqual([]);
    // Everything else the old rule already answered correctly.
    expect(legacyBlockFitsWindow(21 * 60, 23 * 60, ...w)).toBe(true);
    expect(legacyBlockFitsWindow(22 * 60, 26 * 60, ...w)).toBe(true);
    expect(legacyBlockFitsWindow(10 * 60, 12 * 60, ...w)).toBe(false);
    expect(legacyBlockFitsWindow(4 * 60, 8 * 60, ...w)).toBe(false);
  });
});

describe('the manual dialog answers the same as the preview', () => {
  /** Two identical post-midnight blocks on two vehicles leaves one open to ask about. */
  function openBlockChecks(allowDienstzeit: boolean): string[] {
    const blocks = [
      block('M1', '2026-05-12', '01:00', '03:00', 'V1'),
      block('M2', '2026-05-12', '01:00', '03:00', 'V2'),
    ];
    const r = assignBlocksPhase3(blocks, [driver()], { oneVehiclePerDriverDay: true });
    expect(r.unassigned).toHaveLength(1);
    return evaluateManualCandidate(r, r.unassigned[0].block_id, 'D1', {
      allowDienstzeit,
      allowDaily: false,
      allowMonthly: false,
    }).blockingChecks;
  }

  it('does not report a night block as outside the Dienstzeit', () => {
    expect(openBlockChecks(false)).not.toContain('Außerhalb Dienstzeit');
  });

  it('still reports the hard reasons that actually block it', () => {
    // Both are HARD in CLAUDE.md's split and must survive item 5 untouched.
    const checks = openBlockChecks(false);
    expect(checks).toContain('Fahrer-Überlappung');
    expect(checks).toContain('Fahrer nutzt bereits anderes Fahrzeug an diesem Tag');
  });
});

// ── item 6 ──────────────────────────────────────────────────────────────────

describe('a note window is built at local midnight', () => {
  it('covers the first hours of its own first day', () => {
    // 00:30 local on 22.05: the sliver. 11 live rides sat here.
    const s = at(2026, 5, 22, 0, 30);
    expect(findBlockingNote('D1', s, s + 20 * 60_000, notesFor(note()))).not.toBeNull();
  });

  it('refuses the assignment for a block in that sliver', () => {
    const r = assignBlocksPhase3([block('C1', '2026-05-22', '00:30', '01:00')], [anyTimeDriver], {
      oneVehiclePerDriverDay: true,
      driverNotesMap: notesFor(note()),
    });
    expect(r.assigned).toHaveLength(0);
    expect(r.unassigned[0].rejected.map(x => x.reason)).toContain('note_constraint');
  });

  it('still covers the middle of the noted day', () => {
    const s = at(2026, 5, 22, 12, 0);
    expect(findBlockingNote('D1', s, s + 2 * 3_600_000, notesFor(note()))).not.toBeNull();
  });

  it('stops at the end of the last noted day, and no longer reaches into the next', () => {
    // 00:30 on 23.05 is outside a note that ends on the 22nd. The old window,
    // opening two hours late, still reached it. 0 live rides, mechanism real.
    const s = at(2026, 5, 23, 0, 30);
    expect(findBlockingNote('D1', s, s + 20 * 60_000, notesFor(note()))).toBeNull();
  });

  // NEGATIVE CONTROLS — a note that does not apply must never block.
  it('ignores a note whose behaviour is not exclude_from_plan', () => {
    const s = at(2026, 5, 22, 12, 0);
    const neutral = note({ note_planning_behavior: 'neutral' });
    expect(findBlockingNote('D1', s, s + 2 * 3_600_000, notesFor(neutral))).toBeNull();
  });

  it('ignores a note on another day, and one with no date at all', () => {
    const s = at(2026, 5, 22, 12, 0);
    const elsewhere = note({ start_date: '2026-06-10', end_date: '2026-06-10' });
    expect(findBlockingNote('D1', s, s + 2 * 3_600_000, notesFor(elsewhere))).toBeNull();
    const undated = note({ start_date: null, end_date: null, note_date: null });
    expect(noteExclusionIntervals(undated)).toEqual([]);
    expect(findBlockingNote('D1', s, s + 2 * 3_600_000, notesFor(undated))).toBeNull();
  });

  it('is the window the old one got wrong, one hour in winter and two in summer', () => {
    // The probe the old base missed, and the ones it did not.
    const summer = notesFor(note());
    const blocked = (s: number) => findBlockingNote('D1', s, s + 20 * 60_000, summer) !== null;

    // Summer: the old window opened at 02:00 local, so 00:30 and 01:30 were free.
    expect(covers(legacyNoteIntervals(note()), at(2026, 5, 22, 0, 30), at(2026, 5, 22, 0, 50))).toBe(false);
    expect(covers(legacyNoteIntervals(note()), at(2026, 5, 22, 1, 30), at(2026, 5, 22, 1, 50))).toBe(false);
    expect(blocked(at(2026, 5, 22, 0, 30))).toBe(true);
    expect(blocked(at(2026, 5, 22, 1, 30))).toBe(true);
    // From 02:30 on, old and new agree.
    expect(covers(legacyNoteIntervals(note()), at(2026, 5, 22, 2, 30), at(2026, 5, 22, 2, 50))).toBe(true);
    expect(blocked(at(2026, 5, 22, 2, 30))).toBe(true);

    // Winter: one hour, so only 00:30 was free.
    const winter = note({ start_date: '2026-02-01', end_date: '2026-02-03' });
    const wBlocked = (s: number) => findBlockingNote('D1', s, s + 20 * 60_000, notesFor(winter)) !== null;
    expect(covers(legacyNoteIntervals(winter), at(2026, 2, 1, 0, 30), at(2026, 2, 1, 0, 50))).toBe(false);
    expect(wBlocked(at(2026, 2, 1, 0, 30))).toBe(true);
    expect(covers(legacyNoteIntervals(winter), at(2026, 2, 1, 1, 30), at(2026, 2, 1, 1, 50))).toBe(true);
    expect(wBlocked(at(2026, 2, 1, 1, 30))).toBe(true);
  });
});

describe('a note range is walked by calendar day', () => {
  /** 28.–30.03.2026 spans Europe/Berlin's spring-forward on the 29th. */
  const dstNote = note({ start_date: '2026-03-28', end_date: '2026-03-30' });

  it('gives one interval per calendar day, contiguous, the short day short', () => {
    const ivs = noteExclusionIntervals(dstNote);
    expect(ivs).toHaveLength(3);
    expect(ivs.map(iv => (iv.end - iv.start) / 3_600_000)).toEqual([24, 23, 24]);
    // Each day ends exactly where the next begins: no gap, no double cover.
    expect(ivs[0].end).toBe(ivs[1].start);
    expect(ivs[1].end).toBe(ivs[2].start);
    // And each starts at that day's own local midnight.
    expect(ivs[0].start).toBe(at(2026, 3, 28, 0));
    expect(ivs[1].start).toBe(at(2026, 3, 29, 0));
    expect(ivs[2].start).toBe(at(2026, 3, 30, 0));
    expect(ivs[2].end).toBe(at(2026, 3, 31, 0));
  });

  it('keeps a timed note at its own wall clock on every day of the range', () => {
    const timed = note({ start_date: '2026-03-28', end_date: '2026-03-30', is_full_day: false, start_time: '08:00', end_time: '10:00' });
    expect(noteExclusionIntervals(timed).map(iv => iv.start)).toEqual([
      at(2026, 3, 28, 8), at(2026, 3, 29, 8), at(2026, 3, 30, 8),
    ]);
    expect(noteExclusionIntervals(timed).map(iv => iv.end)).toEqual([
      at(2026, 3, 28, 10), at(2026, 3, 29, 10), at(2026, 3, 30, 10),
    ]);
  });

  it('is the walk the old one got wrong — a fixed ms step drifts past a transition', () => {
    // The legacy step is 86 400 000 ms from a UTC base, so day 3 of this range no
    // longer begins at a local midnight. Whatever base it starts from, the days
    // are all exactly 24 h, which the 29th is not.
    const legacy = legacyNoteIntervals(dstNote);
    expect(legacy.map(iv => (iv.end - iv.start) / 3_600_000)).toEqual([24, 24, 24]);
    expect(noteExclusionIntervals(dstNote).map(iv => (iv.end - iv.start) / 3_600_000)).toEqual([24, 23, 24]);
  });

  it('keeps the 366-day cap', () => {
    // Day 0 through 366 inclusive, exactly as Math.min(end, start + 366 days) gave.
    const open = note({ start_date: '2026-01-01', end_date: '2030-01-01' });
    expect(noteExclusionIntervals(open)).toHaveLength(367);
    expect(legacyNoteIntervals(open)).toHaveLength(367);
  });

  it('treats a note with no usable time as a full day', () => {
    // is_full_day false but a time missing: the whole calendar day, as before.
    const half = note({ is_full_day: false, start_time: '08:00', end_time: null });
    expect(noteExclusionIntervals(half)).toEqual([{ start: at(2026, 5, 22, 0), end: at(2026, 5, 23, 0) }]);
    const unparseable = note({ is_full_day: false, start_time: 'nonsense', end_time: 'also' });
    expect(noteExclusionIntervals(unparseable)).toEqual([{ start: at(2026, 5, 22, 0), end: at(2026, 5, 23, 0) }]);
  });

  it('runs an end at or before the start into the next day', () => {
    const overnight = note({ is_full_day: false, start_time: '22:00', end_time: '02:00' });
    expect(noteExclusionIntervals(overnight)).toEqual([
      { start: at(2026, 5, 22, 22), end: at(2026, 5, 23, 2) },
    ]);
    const wholeDay = note({ is_full_day: false, start_time: '08:00', end_time: '08:00' });
    expect(noteExclusionIntervals(wholeDay)).toEqual([
      { start: at(2026, 5, 22, 8), end: at(2026, 5, 23, 8) },
    ]);
  });

  it('keeps the overlap test half-open, so a touching block is free', () => {
    const ivs = noteExclusionIntervals(note());
    // A block ending exactly at the note's start, and one starting exactly at its end.
    expect(covers(ivs, at(2026, 5, 21, 23), at(2026, 5, 22, 0))).toBe(false);
    expect(covers(ivs, at(2026, 5, 23, 0), at(2026, 5, 23, 1))).toBe(false);
    // One second of real overlap is enough, which is how the 11 live rides were found.
    expect(covers(ivs, at(2026, 5, 21, 23), at(2026, 5, 22, 0) + 1_000)).toBe(true);
  });
});

// ── the split itself ────────────────────────────────────────────────────────

describe('the hard and bypassable split is where CLAUDE.md puts it', () => {
  it('lets a manual exception bypass the Dienstzeit', () => {
    const blocks = [
      block('M1', '2026-05-12', '10:00', '12:00', 'V1'),
      block('M2', '2026-05-12', '10:00', '12:00', 'V2'),
    ];
    const r = assignBlocksPhase3(blocks, [driver()], { oneVehiclePerDriverDay: true });
    const open = r.unassigned[0].block_id;
    const strict = evaluateManualCandidate(r, open, 'D1', { allowDienstzeit: false, allowDaily: false, allowMonthly: false });
    const bypassed = evaluateManualCandidate(r, open, 'D1', { allowDienstzeit: true, allowDaily: false, allowMonthly: false });
    expect(strict.blockingChecks).toContain('Außerhalb Dienstzeit');
    expect(bypassed.blockingChecks).not.toContain('Außerhalb Dienstzeit');
  });

  it('lets no option bypass the weekday, which is hard', () => {
    // 12.05.2026 is a Tuesday; allow only Monday.
    const monOnly = driver({ allowed_weekdays: [1], is_full_day_available: true, work_window_start: null, work_window_end: null });
    const blocks = [
      block('M1', '2026-05-12', '10:00', '12:00', 'V1'),
      block('M2', '2026-05-12', '10:00', '12:00', 'V2'),
    ];
    const r = assignBlocksPhase3(blocks, [monOnly], { oneVehiclePerDriverDay: true });
    expect(r.unassigned.length).toBeGreaterThan(0);
    const e = evaluateManualCandidate(r, r.unassigned[0].block_id, 'D1', {
      allowDienstzeit: true,
      allowDaily: true,
      allowMonthly: true,
    });
    expect(e.blockingChecks).toContain('Arbeitstag nicht erlaubt');
    expect(e.feasible).toBe(false);
  });

  it('reports a note refusal as note_constraint, which is hard', () => {
    const r = assignBlocksPhase3([block('C1', '2026-05-22', '00:30', '01:00')], [anyTimeDriver], {
      oneVehiclePerDriverDay: true,
      driverNotesMap: notesFor(note()),
    });
    const reasons = r.unassigned.flatMap(u => u.rejected.map(x => x.reason));
    expect(reasons).toContain('note_constraint');
    expect(reasons).not.toContain('outside_working_time_window');
  });
});
