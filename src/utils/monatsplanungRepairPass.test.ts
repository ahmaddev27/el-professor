/**
 * The final overlap pass: what it reports, and that it changes nothing.
 *
 * ── The rule this file preserves ──────────────────────────────────────────────
 *
 * "التخطيط يومي وللسيارة. إسناد السائقين بصير آخر الشهر" — planning is daily and
 * per vehicle; drivers are assigned at month end. So **the vehicle's day is the
 * fact and the driver is provisional**, and the pass may never answer a
 * driver-side conflict by moving a vehicle's block in time.
 *
 * It used to. `repairFinalOverlaps` relocated a shiftable block — the owner's, or
 * one an earlier repair had placed — to a free slot, up to 200 iterations of it,
 * and `MonatsplanungAssignmentPreview` returned the moved blocks as the plan.
 * That is the rule exactly backwards: a driver's problem reshaped a vehicle's
 * day. `src/utils/monthlyPlan/assign.ts` had already refused to do it and
 * recorded why ("No repair pass, deliberately" — §7 rule 6, and the recorded
 * boundary of 22.09.2026: never an engine function that shifts a block's time).
 *
 * Now a block whose assignment cannot hold loses its **driver**, keeps every one
 * of its times, and is reported unassigned for a person to decide. So the tests
 * below are mostly one assertion in different lights: **no block changed**.
 *
 * ── What is NOT this slice, and is asserted to be untouched ───────────────────
 *
 * The hard/bypassable reject split is Phase 3's. Two regular-driver blocks that
 * overlap are still *reported and not touched* — Phase 3 placed both
 * deliberately, and a hard constraint it believes it kept is a defect to
 * surface, not an assignment for this pass to undo. That report keeps its exact
 * German text, key and vars, which the tests pin verbatim.
 *
 * ── Two measured defects this file already pinned, and still does ─────────────
 *
 * **The conflict key is the driver record, not the display name.** A company can
 * hold two driver records with one name: on staging, exactly one pair, an active
 * `company_owner` and an inactive `employee`. Keyed on the name their ordinary
 * simultaneous blocks "overlapped", and the pass moved one of them by days.
 * Measured on 22.10.2026 over the real data (12 imports, 16,025 trips): all 62
 * conflict pairs were two DIFFERENT driver ids with one name; none shared an id.
 *
 * **The pass must read and write local calendar parts.** Phase 1 builds
 * `actual_start_ms` with `new Date(y, m, d, h, min)`, so every number is a real
 * instant; `Date.UTC` and `getUTC*` are one or two hours away from it. Nothing
 * writes a block time any more, so the surviving readers are the month bounds,
 * `fmtRepairMs` and `buildInhaberFreeWindows` — all still exercised across
 * 25.10.2026 (a 25-hour day) and 29.03.2026 (a 23-hour one). A day is never
 * advanced by adding 86 400 000 ms.
 *
 * ── How the negative controls work ────────────────────────────────────────────
 *
 * The expectations are computed independently of the code under test: the Berlin
 * wall clock comes from `Intl.DateTimeFormat` with `timeZone: 'Europe/Berlin'`,
 * not from the getters the pass uses, and the fixtures are built the way Phase 1
 * builds a block. The German-text check renders the dictionary entry with the
 * product's own `translate`, so the engine's sentence and the dictionary's cannot
 * drift apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssignedBlock, DriverPlanState, Phase3Result } from './monatsplanungPhase3';
import type { PlanningDriver } from '../components/MonatsplanungDriverPool';
import { engineText } from '../i18n/engineMessage';
import { translate, type TranslationKey, type TranslationVars } from '../i18n';
import {
  applyRepairPass,
  buildInhaberFreeWindows,
  fmtRepairMs,
  repairFinalOverlaps,
  type RepairPassResult,
} from './monatsplanungRepairPass';

// ── fixtures ────────────────────────────────────────────────────────────────

const OWNER = { id: 'owner-1', name: 'Ahmed Khan' };
/** An inactive employee record that shares the owner's display name. */
const NAMESAKE = { id: 'employee-2', name: 'Ahmed Khan' };
const RITA = { id: 'driver-3', name: 'Rita Vogel' };

const MIN = 60_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** A local wall-clock instant, built the way Phase 1 builds one. */
const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime();

/** `block_*_datetime` as Phase 1 writes it: the local wall clock of an instant. */
const isoLocal = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const BERLIN = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** The Berlin wall clock of an instant, from the platform's zone database. */
function berlin(ms: number): { date: string; time: string; iso: string } {
  const p: Record<string, string> = {};
  for (const part of BERLIN.formatToParts(ms)) if (part.type !== 'literal') p[part.type] = part.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  return { date, time, iso: `${date}T${time}` };
}

interface Spec {
  id: string;
  driver: { id: string; name: string };
  vehicle: string;
  startMs: number;
  durationMin: number;
  /** Default 'auto': nothing in it marks the block shiftable. */
  reason?: string;
  /** Leave out `actual_*_ms`, as a block built by hand may. */
  stringsOnly?: boolean;
  over?: Partial<AssignedBlock>;
}

function mk(s: Spec): AssignedBlock {
  const endMs = s.startMs + s.durationMin * MIN;
  const block: AssignedBlock = {
    block_id: s.id,
    vehicle_id: s.vehicle,
    vehicle_identifier: s.vehicle,
    service_date: isoLocal(s.startMs).slice(0, 10),
    block_start_datetime: isoLocal(s.startMs),
    block_end_datetime: isoLocal(endMs),
    duration_minutes: s.durationMin,
    trip_ids: [`${s.id}-t1`],
    trip_count: 1,
    first_trip_id: `${s.id}-t1`,
    last_trip_id: `${s.id}-t1`,
    first_excel_row: 1,
    last_excel_row: 1,
    trip_rows: [],
    split_reason: 'gap_gt_60',
    internal_gaps: [],
    longest_internal_gap_minutes: 0,
    merge_status: 'none',
    actual_start_ms: s.startMs,
    actual_end_ms: endMs,
    driver_id: s.driver.id,
    driver_name: s.driver.name,
    assignment_reason: s.reason ?? 'auto',
    effective_max_daily_hours: 10,
    used_default_max_daily: false,
    ...s.over,
  };
  if (s.stringsOnly) {
    delete block.actual_start_ms;
    delete block.actual_end_ms;
  }
  return block;
}

/** The pass, the way the screen calls it: the owner is named by id. */
function run(blocks: AssignedBlock[], year: number, month: number): RepairPassResult {
  return repairFinalOverlaps(blocks, year, month, OWNER.name, 30, OWNER.id);
}

/** The owner works 08:00-16:00 on V1 on days 1..lastDay. */
function ownerWorkdays(year: number, month: number, lastDay: number): AssignedBlock[] {
  const out: AssignedBlock[] = [];
  for (let d = 1; d <= lastDay; d++) {
    out.push(mk({ id: `w${pad(d)}`, driver: OWNER, vehicle: 'V1', startMs: at(year, month, d, 8), durationMin: 480 }));
  }
  return out;
}

/**
 * Every field of every block, exactly as it went in. The one assertion this
 * whole file is about; `toEqual` on the array would also pass for a pass that
 * reordered, so the blocks are compared by id as well.
 */
function expectNothingChanged(r: RepairPassResult, input: AssignedBlock[]): void {
  expect(r.movedBlocks).toEqual([]);
  expect(r.assignedBlocks).toEqual(input);
  expect(r.diagnostics.daueraenderungen).toBe(0);
  for (const before of input) {
    const after = r.assignedBlocks.find(b => b.block_id === before.block_id);
    expect(after, `block ${before.block_id} is still there`).toBeDefined();
    expect(after).toEqual(before);
    // Named one by one, because these six are what a move used to rewrite.
    expect(after!.actual_start_ms).toBe(before.actual_start_ms);
    expect(after!.actual_end_ms).toBe(before.actual_end_ms);
    expect(after!.block_start_datetime).toBe(before.block_start_datetime);
    expect(after!.block_end_datetime).toBe(before.block_end_datetime);
    expect(after!.service_date).toBe(before.service_date);
    expect(after!.duration_minutes).toBe(before.duration_minutes);
    // And the flag the move used to raise.
    expect(after!.repair_moved).toBe(before.repair_moved);
  }
}

beforeEach(() => {
  // The pass narrates to the console.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ── the premise ─────────────────────────────────────────────────────────────

describe('premise', () => {
  it('runs in Europe/Berlin: July is UTC+2, January UTC+1, and two days are not 24 hours long', () => {
    // If this fails, every wall-clock assertion below measures a different zone.
    expect(new Date(2026, 6, 1, 12).getTimezoneOffset()).toBe(-120);
    expect(new Date(2026, 0, 1, 12).getTimezoneOffset()).toBe(-60);
    expect(at(2026, 10, 26) - at(2026, 10, 25)).toBe(25 * 60 * MIN);
    expect(at(2026, 3, 30) - at(2026, 3, 29)).toBe(23 * 60 * MIN);
  });

  it('the independent clock agrees with the platform at a known instant', () => {
    // 08:00 UTC on 15.07.2026 is 10:00 in Berlin; on 15.01.2026 it is 09:00.
    expect(berlin(Date.UTC(2026, 6, 15, 8)).iso).toBe('2026-07-15T10:00');
    expect(berlin(Date.UTC(2026, 0, 15, 8)).iso).toBe('2026-01-15T09:00');
    expect(berlin(at(2026, 7, 1)).iso).toBe('2026-07-01T00:00');
  });
});

// ── the rule: no block moves, whatever the conflict ─────────────────────────

describe('the pass moves no block', () => {
  it('the owner overlapping himself: his block is released, and both keep their times', () => {
    const first = mk({ id: 'o1', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const second = mk({ id: 'o2', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 90 });
    const input = [first, second];

    const r = run(input, 2026, 7);

    // Before: `movedBlocks` held one entry, o2 relocated to 12:00-13:30.
    expectNothingChanged(r, input);
    expect(r.releases).toHaveLength(1);
    expect(r.releases[0].blockId).toBe('o2'); // the shorter block loses its driver
  });

  it('a vehicle clash on the owner: released, not relocated', () => {
    const owner = mk({ id: 'o', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const rita = mk({ id: 'r', driver: RITA, vehicle: 'V1', startMs: at(2026, 7, 8, 11), durationMin: 120 });
    const input = [owner, rita];

    const r = run(input, 2026, 7);

    expectNothingChanged(r, input);
    expect(r.releases.map(x => x.blockId)).toEqual(['o']);
    expect(r.releases[0].conflictKind).toBe('vehicle');
  });

  it('a whole month of free evenings is no longer an invitation: the block stays on its own day', () => {
    // The scenario that used to move a block to the start of the month, which is
    // where the median seven-day displacement came from.
    const input = [
      ...ownerWorkdays(2026, 7, 19),
      mk({ id: 'p', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 20, 10), durationMin: 180 }),
      mk({ id: 'c', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 20, 11), durationMin: 90 }),
    ];

    const r = run(input, 2026, 7);

    expectNothingChanged(r, input);
    // Before: 'c' landed at 2026-07-01T00:00, eleven hundred minutes away.
    const c = r.assignedBlocks.find(b => b.block_id === 'c')!;
    expect(c.actual_start_ms).toBe(at(2026, 7, 20, 11));
    expect(c.service_date).toBe('2026-07-20');
  });

  it('the buffer argument decides nothing here any more', () => {
    // It bounded the search for a landing slot, and there is no search. Phase 3
    // enforces the vehicle-switch buffer as a hard constraint instead.
    const input = [
      mk({ id: 'o1', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 20, 10), durationMin: 120 }),
      mk({ id: 'o2', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 20, 11), durationMin: 90 }),
      mk({ id: 'rita', driver: RITA, vehicle: 'V2', startMs: at(2026, 7, 1, 0), durationMin: 60 }),
      mk({ id: 'next-door', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 1, 0, 20), durationMin: 30 }),
    ];

    for (const buffer of [0, 30, 240]) {
      const r = repairFinalOverlaps(input, 2026, 7, OWNER.name, buffer, OWNER.id);
      expectNothingChanged(r, input);
      expect(r.releases.map(x => x.blockId), `buffer ${buffer}`).toEqual(['o2']);
    }
  });

  it('one detection pass, never two hundred', () => {
    const input = [
      mk({ id: 'o1', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 }),
      mk({ id: 'o2', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 90 }),
    ];

    expect(run(input, 2026, 7).iterations).toBe(1);
    expect(run([], 2026, 7).iterations).toBe(1);
  });

  /**
   * The clock-change days. These landings are where a moved block used to carry
   * a string one or two hours away from its own instant; now the assertion is
   * that no string moved at all, on a 23-hour day and a 25-hour one.
   */
  const landings = [
    {
      label: 'January (UTC+1)',
      year: 2026, month: 1, pairDay: 15,
      first: { startMs: at(2026, 1, 15, 10), durationMin: 180 },
      second: { startMs: at(2026, 1, 15, 11), durationMin: 120 },
    },
    {
      label: 'July (UTC+2)',
      year: 2026, month: 7, pairDay: 15,
      first: { startMs: at(2026, 7, 15, 10), durationMin: 180 },
      second: { startMs: at(2026, 7, 15, 11), durationMin: 120 },
    },
    {
      // The clocks go back at 03:00 CEST, so 02:00-03:00 happens twice and the
      // first block lasts four real hours across a three-hour wall clock.
      label: '25.10.2026, the 25-hour day',
      year: 2026, month: 10, pairDay: 25,
      first: { startMs: at(2026, 10, 25, 0, 30), durationMin: 240 },
      second: { startMs: at(2026, 10, 25, 1, 0), durationMin: 120 },
    },
    {
      // 02:00-03:00 does not exist: the first block is two real hours long.
      label: '29.03.2026, the 23-hour day',
      year: 2026, month: 3, pairDay: 29,
      first: { startMs: at(2026, 3, 29, 1, 0), durationMin: 120 },
      second: { startMs: at(2026, 3, 29, 1, 30), durationMin: 60 },
    },
  ];

  it.each(landings)('$label: every block keeps the Berlin wall clock it arrived with', c => {
    const input = [
      ...ownerWorkdays(c.year, c.month, c.pairDay - 1),
      mk({ id: 'p', driver: OWNER, vehicle: 'V1', ...c.first }),
      mk({ id: 'c', driver: OWNER, vehicle: 'V2', ...c.second }),
    ];

    const r = run(input, c.year, c.month);

    expectNothingChanged(r, input);
    expect(r.releases).toHaveLength(1);
    // Independent of the code under test: the platform's own Berlin clock still
    // describes every block, because no block was rewritten.
    for (const b of r.assignedBlocks) {
      expect(b.block_start_datetime).toBe(berlin(b.actual_start_ms!).iso);
      expect(b.block_end_datetime).toBe(berlin(b.actual_end_ms!).iso);
      expect(b.service_date).toBe(berlin(b.actual_start_ms!).date);
    }
  });

  it('a block with no instant of its own is still read as a local wall clock, not as UTC', () => {
    // 10:00-11:30 local on the string-only block overlaps 09:00-10:30 on the
    // other (30 minutes). Read as UTC it would be 12:00-13:30 local and clear,
    // so the conflict is only found when the string is read locally.
    const stringsOnly = mk({ id: 's', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 90, stringsOnly: true });
    const instant = mk({ id: 'i', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 8, 9), durationMin: 90 });
    expect(stringsOnly.actual_start_ms).toBeUndefined();
    const input = [stringsOnly, instant];

    const r = run(input, 2026, 7);

    expect(r.conflictsBefore).toBe(1);
    expectNothingChanged(r, input);
    // The released block still carries no instant: nothing invented one for it.
    const s = r.assignedBlocks.find(b => b.block_id === 's')!;
    expect(s.actual_start_ms).toBeUndefined();
    expect(s.actual_end_ms).toBeUndefined();
  });
});

// ── the conflict key is the driver record, not the display name ─────────────

describe('the conflict key is the driver id', () => {
  it('two records with one display name are not one driver: no conflict, nothing released', () => {
    const owner = mk({ id: 'o', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const namesake = mk({ id: 'e', driver: NAMESAKE, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 120 });
    const input = [owner, namesake];

    const r = run(input, 2026, 7);

    expect(r.releases).toEqual([]);
    expect(r.unrepairable).toEqual([]);
    expect(r.conflictsBefore).toBe(0);
    expect(r.conflictsAfter).toBe(0);
    expect(r.diagnostics.fahrerUeberschneidungen).toBe(0);
    expect(r.diagnostics.inhaberUeberschneidungen).toBe(0);
    expectNothingChanged(r, input);
  });

  it('the same record overlapping itself is still found', () => {
    const input = [
      mk({ id: 'o1', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 }),
      mk({ id: 'o2', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 90 }),
    ];

    const r = run(input, 2026, 7);

    expect(r.conflictsBefore).toBe(1);
    expect(r.releases).toHaveLength(1);
    expect(r.releases[0].conflictKind).toBe('inhaber');
  });

  it('a block with no driver id is a driver nobody can identify: two of them are not taken for one person', () => {
    const input = [
      mk({ id: 'x1', driver: { id: '', name: NAMESAKE.name }, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 }),
      mk({ id: 'x2', driver: { id: '', name: NAMESAKE.name }, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 120 }),
    ];

    const r = run(input, 2026, 7);

    expect(r.releases).toEqual([]);
    expect(r.conflictsBefore).toBe(0);
    expect(r.diagnostics.fahrerUeberschneidungen).toBe(0);
  });

  it('a namesake is not the owner: its block is regular, so a vehicle clash is reported, not released', () => {
    // By name the namesake was "the Inhaber", therefore shiftable, and the pass
    // moved it. It is a regular driver, so neither block may lose its driver here.
    const namesake = mk({ id: 'e', driver: NAMESAKE, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const rita = mk({ id: 'r', driver: RITA, vehicle: 'V1', startMs: at(2026, 7, 8, 11), durationMin: 120 });
    const input = [namesake, rita];

    const r = run(input, 2026, 7);

    expect(r.releases).toEqual([]);
    expect(r.diagnostics.fahrzeugUeberschneidungen).toBe(1);
    expect(r.unrepairable).toHaveLength(1);
    expect(r.unrepairable[0].reasonKey).toBe('engine.repair.unrepairable.regularDriverConflict');
    expectNothingChanged(r, input);
  });

  it("a namesake's blocks do not make the owner's conflict someone else's", () => {
    // The owner overlaps himself on 20.07.; the namesake holds another vehicle at
    // the start of the month. Exactly one release, and it is the owner's block.
    const input = [
      mk({ id: 'o1', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 20, 10), durationMin: 120 }),
      mk({ id: 'o2', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 20, 11), durationMin: 90 }),
      mk({ id: 'e', driver: NAMESAKE, vehicle: 'V3', startMs: at(2026, 7, 1, 0), durationMin: 180 }),
    ];

    const r = run(input, 2026, 7);

    expect(r.releases.map(x => x.blockId)).toEqual(['o2']);
    expectNothingChanged(r, input);
  });

  it('a repair-flagged block of any driver is shiftable, so it is the one released', () => {
    // `isShiftable` is not the same as owner: a repair flag makes any driver's
    // block the candidate. It loses its driver; it does not move.
    const input = [
      mk({ id: 'n1', driver: NAMESAKE, vehicle: 'V1', startMs: at(2026, 7, 20, 10), durationMin: 120 }),
      mk({ id: 'n2', driver: NAMESAKE, vehicle: 'V2', startMs: at(2026, 7, 20, 11), durationMin: 90, over: { repair_moved: true } }),
    ];

    const r = run(input, 2026, 7);

    expect(r.releases.map(x => x.blockId)).toEqual(['n2']);
    expect(r.releases[0].conflictKind).toBe('driver');
    expectNothingChanged(r, input);
  });

  it('a block overlapping two others is released once, not once per conflict', () => {
    // The short middle block overlaps both neighbours, and the neighbours only
    // touch, so they do not conflict with each other. It is the shorter block in
    // both pairs, so it is chosen twice and must still be released once.
    const input = [
      mk({ id: 'left', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 60 }),
      mk({ id: 'short', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 8, 10, 45), durationMin: 30 }),
      mk({ id: 'right', driver: OWNER, vehicle: 'V3', startMs: at(2026, 7, 8, 11), durationMin: 60 }),
    ];

    const r = run(input, 2026, 7);

    expect(r.conflictsBefore).toBe(2);
    expect(r.releases.map(x => x.blockId)).toEqual(['short']);
    expect(r.conflictsAfter).toBe(0);
    expectNothingChanged(r, input);
  });

  /**
   * Inherited greediness, recorded rather than fixed. `chooseCandidate` is the
   * old pass's own preference — it used to pick the block to MOVE and now picks
   * the block to RELEASE — and on equal durations it takes the FIRST of the
   * pair. So a chain of equal-length overlapping blocks loses one driver per
   * conflict, where releasing the middle block alone would have answered both.
   *
   * Left as it is on purpose: the choice is Phase 3's output being repaired, the
   * old pass over-MOVED in exactly the same shape, and on the real data the whole
   * path is unreachable (12 imports, 16,025 trips, 0 conflicts). Whoever makes
   * the release set minimal should start here — and will fail this test, which is
   * the intent.
   */
  it('releases one driver per conflict when the durations tie, which can be more than needed', () => {
    const input = [
      mk({ id: 'o1', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 60 }),
      mk({ id: 'o2', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 8, 10, 30), durationMin: 60 }),
      mk({ id: 'o3', driver: OWNER, vehicle: 'V3', startMs: at(2026, 7, 8, 11), durationMin: 60 }),
    ];

    const r = run(input, 2026, 7);

    expect(r.conflictsBefore).toBe(2);
    // Releasing o2 alone would have left o1 and o3, which only touch.
    expect(r.releases.map(x => x.blockId)).toEqual(['o1', 'o2']);
    expect(r.conflictsAfter).toBe(0);
    expectNothingChanged(r, input);
  });
});

// ── what the operator is told ───────────────────────────────────────────────

describe('a released block says why, in the engine-message shape', () => {
  const release = () => {
    const input = [
      mk({ id: 'o1', driver: OWNER, vehicle: 'V-ALPHA', startMs: at(2026, 7, 8, 10), durationMin: 120 }),
      mk({ id: 'o2', driver: OWNER, vehicle: 'V-BETA', startMs: at(2026, 7, 8, 11), durationMin: 90 }),
    ];
    return run(input, 2026, 7).releases[0];
  };

  it('carries the German text, a key and the vars beside it', () => {
    const x = release();

    expect(x).toMatchObject({
      blockId: 'o2',
      driverName: OWNER.name,
      driverId: OWNER.id,
      vehicle: 'V-BETA',
      otherBlockId: 'o1',
      otherVehicle: 'V-ALPHA',
      conflictKind: 'inhaber',
      reasonKey: 'engine.repair.released.conflict',
      reasonVars: {
        // A var whose value is itself a dictionary key: resolved first by
        // `engineText`, which is how a closed vocabulary travels inside the
        // sentence without the engine reaching the dictionaries.
        kind: 'engine.repair.conflictKind.inhaber',
        driver: OWNER.name,
        vehicleA: 'V-BETA',
        vehicleB: 'V-ALPHA',
        overlapMinutes: 60,
      },
    });
    expect(x.overlapMs).toBe(60 * MIN);
  });

  it('says it is not assigned, names the overlap, and says block times do not move', () => {
    expect(release().reason).toBe(
      'Nicht zugewiesen (Inhaberüberschneidung): Ahmed Khan · V-BETA und V-ALPHA überlappen um 60 Min. '
      + 'Blockzeiten werden nicht verschoben; Fahrer werden am Monatsende zugewiesen.',
    );
  });

  /**
   * The repo's rule: a German dictionary entry must render EXACTLY the text the
   * engine already produced, or turning the key on silently rewords the German
   * UI. Rendered here with the product's own translator, so the two cannot drift.
   */
  it('the German dictionary entry renders exactly the sentence the engine wrote', () => {
    const x = release();
    const t = (key: TranslationKey, vars?: TranslationVars) => translate('de', key, vars);

    expect(engineText(t, x.reason, x.reasonKey, x.reasonVars)).toBe(x.reason);
  });

  it('the English entry says the same thing, with every placeholder filled', () => {
    const x = release();
    const t = (key: TranslationKey, vars?: TranslationVars) => translate('en', key, vars);

    const rendered = engineText(t, x.reason, x.reasonKey, x.reasonVars);
    expect(rendered).toBe(
      'Not assigned (Inhaber overlap): Ahmed Khan · V-BETA and V-ALPHA overlap by 60 min. '
      + 'Block times are not moved; drivers are assigned at month end.',
    );
    expect(rendered).not.toContain('{');
  });

  it('the three conflict kinds each name their own word', () => {
    const t = (key: TranslationKey, vars?: TranslationVars) => translate('de', key, vars);

    // inhaber: the owner against himself.
    const inhaber = run([
      mk({ id: 'a', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 }),
      mk({ id: 'b', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 90 }),
    ], 2026, 7).releases[0];
    expect(engineText(t, inhaber.reason, inhaber.reasonKey, inhaber.reasonVars)).toContain('Inhaberüberschneidung');

    // driver: a non-owner record against itself, made shiftable by a repair flag.
    const driver = run([
      mk({ id: 'a', driver: RITA, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 }),
      mk({ id: 'b', driver: RITA, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 90, over: { repair_moved: true } }),
    ], 2026, 7).releases[0];
    expect(engineText(t, driver.reason, driver.reasonKey, driver.reasonVars)).toContain('Fahrerüberschneidung');

    // vehicle: two records on one vehicle, one of them the owner's.
    const vehicle = run([
      mk({ id: 'a', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 }),
      mk({ id: 'b', driver: RITA, vehicle: 'V1', startMs: at(2026, 7, 8, 11), durationMin: 120 }),
    ], 2026, 7).releases[0];
    expect(engineText(t, vehicle.reason, vehicle.reasonKey, vehicle.reasonVars)).toContain('Fahrzeugüberschneidung');
  });
});

// ── the regular-driver report: untouched, to the letter ─────────────────────

describe('two regular-driver blocks are reported and not touched', () => {
  it('keeps its exact German text, key and vars', () => {
    const a = mk({ id: 'r1', driver: RITA, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const b = mk({ id: 'r2', driver: RITA, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 120 });
    const input = [a, b];

    const r = run(input, 2026, 7);

    expect(r.releases).toEqual([]);
    expect(r.conflictsAfter).toBe(1);
    expect(r.diagnostics.fahrerUeberschneidungen).toBe(1);
    expect(r.diagnostics.nichtReparierbar).toBe(1);
    expect(r.unrepairable).toHaveLength(1);
    expect(r.unrepairable[0]).toMatchObject({
      blockId: 'r1',
      driverName: RITA.name,
      conflictKind: 'Regulärer Fahrer-Konflikt aus Ausgangsplanung',
      conflictKindKey: 'engine.repair.conflictKind.regularDriver',
      reasonKey: 'engine.repair.unrepairable.regularDriverConflict',
      reasonVars: { driver: RITA.name, vehicleA: 'V1', vehicleB: 'V2', overlapMinutes: 60 },
    });
    expect(r.unrepairable[0].reason).toBe(
      'Regulärer Fahrer-Konflikt aus Ausgangsplanung: Rita Vogel · V1 und V2 überlappen um 60 Min.',
    );
    expectNothingChanged(r, input);
  });
});

// ── applyRepairPass: the release reaches the result the screen renders ──────

describe('applyRepairPass carries a release into the Phase3Result', () => {
  function driver(d: { id: string; name: string }, owner: boolean): PlanningDriver {
    return {
      id: d.id,
      name: d.name,
      driver_usage_type: 'regular',
      planning_enabled: true,
      status: 'active',
      work_window_start: null,
      work_window_end: null,
      allowed_weekdays: null,
      max_daily_hours: 10,
      planning_target_salary: null,
      target_monthly_hours: null,
      max_monthly_hours: null,
      planning_min_salary: null,
      planning_max_salary: null,
      planning_hourly_rate: null,
      notes: null,
      is_full_day_available: true,
      employment_type: owner ? 'company_owner' : 'employee',
    };
  }

  function state(d: PlanningDriver, blocks: AssignedBlock[]): DriverPlanState {
    const daily = new Map<string, number>();
    let monthly = 0;
    for (const b of blocks) {
      daily.set(b.service_date, (daily.get(b.service_date) ?? 0) + b.duration_minutes);
      monthly += b.duration_minutes;
    }
    return {
      driver_id: d.id,
      driver_name: d.name,
      driver: d,
      effective_max_daily_hours: 10,
      used_default_max_daily: false,
      assigned: blocks,
      daily_minutes: daily,
      monthly_minutes: monthly,
    };
  }

  /** The owner holds two overlapping blocks: the shorter one must be released. */
  function scenario() {
    const first = mk({ id: 'o1', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const second = mk({ id: 'o2', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 90 });
    const ownerDriver = driver(OWNER, true);
    const result = {
      assigned: [first, second],
      unassigned: [],
      driverStates: [state(ownerDriver, [first, second])],
      validation: {},
      options: {},
      multiple_vehicles_per_day_details: [],
      noteWarnings: [],
    } as unknown as Phase3Result;
    return { first, second, ownerDriver, result };
  }

  it('the block leaves `assigned` and arrives in `unassigned` with its reason', () => {
    const { second, ownerDriver, result } = scenario();

    const { result: next, repair } = applyRepairPass(result, [ownerDriver], 2026, 7, OWNER.name, 30, OWNER.id);

    expect(repair.releases).toHaveLength(1);
    expect(next.assigned.map(b => b.block_id)).toEqual(['o1']);
    expect(next.unassigned.map(b => b.block_id)).toEqual(['o2']);

    const u = next.unassigned[0];
    // The shape the review UI already renders, through `engineText`.
    expect(u.repair_attempted).toBe(true);
    expect(u.repair_reason).toBe(repair.releases[0].reason);
    expect(u.repair_reason_key).toBe('engine.repair.released.conflict');
    expect(u.repair_reason_vars).toEqual(repair.releases[0].reasonVars);
    // Its times are the ones it arrived with. An unassigned block is still the
    // vehicle's day; only the driver is gone.
    expect(u.actual_start_ms).toBe(second.actual_start_ms);
    expect(u.actual_end_ms).toBe(second.actual_end_ms);
    expect(u.block_start_datetime).toBe(second.block_start_datetime);
    expect(u.block_end_datetime).toBe(second.block_end_datetime);
    expect(u.service_date).toBe(second.service_date);
    expect(u.duration_minutes).toBe(second.duration_minutes);
  });

  it('it is the driver that is gone: no driver_id survives on the released block', () => {
    const { ownerDriver, result } = scenario();

    const { result: next } = applyRepairPass(result, [ownerDriver], 2026, 7, OWNER.name, 30, OWNER.id);

    expect(next.unassigned[0]).not.toHaveProperty('driver_id');
    expect(next.unassigned[0]).not.toHaveProperty('driver_name');
  });

  it("the driver's minutes come down by exactly the released block", () => {
    const { ownerDriver, result } = scenario();
    const before = result.driverStates[0];
    expect(before.monthly_minutes).toBe(210);

    const { result: next } = applyRepairPass(result, [ownerDriver], 2026, 7, OWNER.name, 30, OWNER.id);

    const after = next.driverStates[0];
    expect(after.monthly_minutes).toBe(120);
    expect(after.daily_minutes.get('2026-07-08')).toBe(120);
    expect(after.assigned.map(b => b.block_id)).toEqual(['o1']);
  });

  it('a result with no conflict comes back as the very same object', () => {
    const rita = driver(RITA, false);
    const lone = mk({ id: 'solo', driver: RITA, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const result = {
      assigned: [lone],
      unassigned: [],
      driverStates: [state(rita, [lone])],
      validation: {}, options: {}, multiple_vehicles_per_day_details: [], noteWarnings: [],
    } as unknown as Phase3Result;

    const { result: next, repair } = applyRepairPass(result, [rita], 2026, 7, OWNER.name, 30, OWNER.id);

    expect(repair.releases).toEqual([]);
    expect(next).toBe(result); // untouched, not merely equal
  });
});

// ── the month: local midnights, and a month is not days x 24 hours ──────────

describe('the month bounds are local midnights', () => {
  const months = [
    { label: 'January 2026', year: 2026, month: 1 },
    { label: 'March 2026 (23 hours short, 29.03.)', year: 2026, month: 3 },
    { label: 'July 2026', year: 2026, month: 7 },
    { label: 'October 2026 (an hour long, 25.10.)', year: 2026, month: 10 },
  ];

  /** One lone block, so nothing conflicts: how many does the pass count as outside the month? */
  function outside(year: number, month: number, startMs: number, endMs: number): number {
    const block = mk({
      id: 'solo',
      driver: RITA,
      vehicle: 'V9',
      startMs,
      durationMin: Math.round((endMs - startMs) / MIN),
    });
    return repairFinalOverlaps([block], year, month, '', 30, '').diagnostics.ausserhalb;
  }

  describe.each(months)('$label', ({ year, month }) => {
    const last = new Date(year, month, 0).getDate();

    it('a block that starts at 00:30 on the 1st is inside the month', () => {
      expect(outside(year, month, at(year, month, 1, 0, 30), at(year, month, 1, 1, 30))).toBe(0);
    });

    it('a block that starts at local midnight on the 1st is inside the month', () => {
      expect(outside(year, month, at(year, month, 1, 0, 0), at(year, month, 1, 1, 0))).toBe(0);
    });

    it('a block that started at 23:30 on the last day of the previous month is outside', () => {
      expect(outside(year, month, at(year, month, 0, 23, 30), at(year, month, 1, 0, 30))).toBe(1);
    });

    it('a block that ends at 23:30 on the last day is inside', () => {
      // A month of fixed 24-hour days ends an hour early in October.
      expect(outside(year, month, at(year, month, last, 22, 30), at(year, month, last, 23, 30))).toBe(0);
    });

    it('a block that ends exactly at the next local midnight is inside', () => {
      expect(outside(year, month, at(year, month, last, 23, 0), at(year, month + 1, 1, 0, 0))).toBe(0);
    });

    it('a block that ends at 00:30 on the 1st of the next month is outside', () => {
      // A month of fixed 24-hour days ends an hour late in March.
      expect(outside(year, month, at(year, month, last, 23, 30), at(year, month + 1, 1, 0, 30))).toBe(1);
    });
  });
});

// ── the display and the day arithmetic ──────────────────────────────────────

describe('fmtRepairMs prints the local wall clock', () => {
  it('summer and winter', () => {
    expect(fmtRepairMs(Date.UTC(2026, 6, 15, 8, 0))).toBe('10:00');
    expect(fmtRepairMs(Date.UTC(2026, 0, 15, 8, 0))).toBe('09:00');
  });

  it('around both clock changes', () => {
    // 29.03.2026: 01:30 UTC is 03:30 CEST, the hour 02:00-03:00 was skipped.
    expect(fmtRepairMs(Date.UTC(2026, 2, 29, 1, 30))).toBe('03:30');
    // 25.10.2026: 00:30 UTC is 02:30 CEST, and 01:30 UTC is 02:30 CET: the same label twice.
    expect(fmtRepairMs(Date.UTC(2026, 9, 25, 0, 30))).toBe('02:30');
    expect(fmtRepairMs(Date.UTC(2026, 9, 25, 1, 30))).toBe('02:30');
    expect(fmtRepairMs(at(2026, 10, 25, 3, 30))).toBe('03:30');
  });
});

describe('buildInhaberFreeWindows steps local days, never 86 400 000 ms', () => {
  const months = [
    { label: 'October 2026', year: 2026, month: 10, days: 31, oddDay: 25, oddHours: 25 },
    { label: 'March 2026', year: 2026, month: 3, days: 31, oddDay: 29, oddHours: 23 },
    { label: 'July 2026 (no clock change)', year: 2026, month: 7, days: 31, oddDay: 0, oddHours: 24 },
  ];

  it.each(months)('$label: every day starts at its own local midnight and the days meet', m => {
    const windows = buildInhaberFreeWindows([], OWNER.name, m.year, m.month);

    expect([...windows.keys()]).toEqual(
      Array.from({ length: m.days }, (_, i) => `${m.year}-${pad(m.month)}-${pad(i + 1)}`),
    );
    let previousEnd = at(m.year, m.month, 1);
    for (let d = 1; d <= m.days; d++) {
      const [day] = windows.get(`${m.year}-${pad(m.month)}-${pad(d)}`)!;
      expect(day.startMs, `day ${d}`).toBe(at(m.year, m.month, d));
      expect(day.startMs, `day ${d}`).toBe(previousEnd);
      expect(day.endMs, `day ${d}`).toBe(at(m.year, m.month, d + 1));
      expect(day.durationSec, `day ${d}`).toBe((d === m.oddDay ? m.oddHours : 24) * 3600);
      previousEnd = day.endMs;
    }
    expect(previousEnd).toBe(at(m.year, m.month + 1, 1));
  });

  it('the 25-hour day: free time around a block that crosses the repeated hour', () => {
    // 00:30 CEST to 03:30 CET is four real hours. The day keeps its 25 hours.
    const block = mk({ id: 'o', driver: OWNER, vehicle: 'V1', startMs: at(2026, 10, 25, 0, 30), durationMin: 240 });

    const windows = buildInhaberFreeWindows([block], OWNER.name, 2026, 10);

    // 03:30 CET to the next midnight is 20.5 hours.
    expect(windows.get('2026-10-25')).toEqual([
      { startMs: at(2026, 10, 25), endMs: at(2026, 10, 25, 0, 30), durationSec: 30 * 60 },
      { startMs: at(2026, 10, 25, 3, 30), endMs: at(2026, 10, 26), durationSec: 20.5 * 3600 },
    ]);
    expect(windows.get('2026-10-26')).toEqual([
      { startMs: at(2026, 10, 26), endMs: at(2026, 10, 27), durationSec: 24 * 3600 },
    ]);
  });

  it('the 23-hour day: free time around a block that crosses the skipped hour', () => {
    // 01:00 CET to 04:00 CEST is two real hours.
    const block = mk({ id: 'o', driver: OWNER, vehicle: 'V1', startMs: at(2026, 3, 29, 1, 0), durationMin: 120 });

    const windows = buildInhaberFreeWindows([block], OWNER.name, 2026, 3);

    expect(windows.get('2026-03-29')).toEqual([
      { startMs: at(2026, 3, 29), endMs: at(2026, 3, 29, 1, 0), durationSec: 3600 },
      { startMs: at(2026, 3, 29, 4, 0), endMs: at(2026, 3, 30), durationSec: 20 * 3600 },
    ]);
    expect(windows.get('2026-03-30')).toEqual([
      { startMs: at(2026, 3, 30), endMs: at(2026, 3, 31), durationSec: 24 * 3600 },
    ]);
  });
});
