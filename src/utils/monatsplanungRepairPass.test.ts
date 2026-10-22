/**
 * The final overlap repair pass: whose blocks overlap, and what time it writes.
 *
 * ── The rule this file preserves ──────────────────────────────────────────────
 *
 * `repairFinalOverlaps` moves a SHIFTABLE block (the owner's, or one an earlier
 * repair placed) to a free slot when it overlaps another block of the same
 * DRIVER or the same VEHICLE. A regular driver's block is never moved: it is
 * reported. Nothing here changes that, nor the reasons the pass gives, its
 * diagnostics or its German text. The move tests assert the reasons verbatim, so
 * a rewording fails here, and the relocation itself is exercised in every test
 * that moves a block.
 *
 * ── Defect 1: the conflict key was a display name ─────────────────────────────
 *
 * Two blocks were "the same driver" when `driver_name` matched, and the owner was
 * recognised by name too. A company can hold two driver records with one name:
 * on staging, exactly one pair, an active `company_owner` and an inactive
 * `employee`. Measured on 22.10.2026 by running the real pipeline over the real
 * data (8 real months, 2,453 Phase 1 blocks): under every driver pool the screen
 * can build except "Alle auswählen" the pass found 0 conflicts and moved 0
 * blocks. "Alle auswählen" admits the inactive namesake, and then it moved 42
 * blocks in 6 of the 8 months, a median of seven days away. All 62 conflict pairs
 * in the whole measurement were two DIFFERENT driver ids with one name; none
 * shared an id. Rename the one record and the 62 moves become 0.
 *
 * So the tests below hold the key to the record: two ids with one name never
 * conflict, one id overlapping itself always does, and a namesake is not the
 * owner, so its blocks are not shiftable either.
 *
 * ── Defect 2: the pass wrote local times through UTC ──────────────────────────
 *
 * Phase 1 builds `actual_start_ms` with `new Date(y, m, d, h, min)` and writes
 * the wall clock beside it. The pass read the month at `Date.UTC` and wrote
 * `block_start_datetime`, `block_end_datetime` and `service_date` with `getUTC*`,
 * so a moved block carried a string 60 (winter) or 120 (summer) minutes earlier
 * than the Berlin wall clock of its own instant. Measured: all 62 moved blocks,
 * against 0 of 12,252 unmoved ones. The month started at 02:00 Berlin time in
 * summer, so a block between 00:00 and 02:00 on the 1st counted as outside it.
 *
 * ── How the negative controls work ────────────────────────────────────────────
 *
 * The expectations are computed independently of the code under test: the Berlin
 * wall clock comes from `Intl.DateTimeFormat` with `timeZone: 'Europe/Berlin'`,
 * not from the getters the pass uses, and the fixtures are built the way Phase 1
 * builds a block. Each scenario was run against the old key and the old UTC
 * reads and fails there; every other assertion states what must stay as it was.
 *
 * 25.10.2026 is a 25-hour day and 29.03.2026 a 23-hour one, so the month bounds
 * and the day arithmetic are exercised across both. A day is never advanced by
 * adding 86 400 000 ms.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssignedBlock } from './monatsplanungPhase3';
import {
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

/** The owner works 08:00-16:00 on V1 on days 1..lastDay, so the free time is a day's evening. */
function ownerWorkdays(year: number, month: number, lastDay: number): AssignedBlock[] {
  const out: AssignedBlock[] = [];
  for (let d = 1; d <= lastDay; d++) {
    out.push(mk({ id: `w${pad(d)}`, driver: OWNER, vehicle: 'V1', startMs: at(year, month, d, 8), durationMin: 480 }));
  }
  return out;
}

beforeEach(() => {
  // The pass narrates every iteration to the console.
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

// ── defect 1: a driver is a record, not a label ─────────────────────────────

describe('the conflict key is the driver id', () => {
  it('two records with one display name are not one driver: no conflict, no move', () => {
    const owner = mk({ id: 'o', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const namesake = mk({ id: 'e', driver: NAMESAKE, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 120 });

    const r = run([owner, namesake], 2026, 7);

    expect(r.movedBlocks).toEqual([]);
    expect(r.unrepairable).toEqual([]);
    expect(r.conflictsBefore).toBe(0);
    expect(r.conflictsAfter).toBe(0);
    expect(r.diagnostics.fahrerUeberschneidungen).toBe(0);
    expect(r.diagnostics.inhaberUeberschneidungen).toBe(0);
    expect(r.assignedBlocks).toEqual([owner, namesake]);
  });

  it('the same record overlapping itself is still found, and the owner is still moved', () => {
    const first = mk({ id: 'o1', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const second = mk({ id: 'o2', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 90 });

    const r = run([first, second], 2026, 7);

    expect(r.movedBlocks).toHaveLength(1);
    expect(r.movedBlocks[0]).toMatchObject({
      blockId: 'o2', // the shorter block moves
      vehicle: 'V2',
      driverName: OWNER.name,
      oldStartMs: at(2026, 7, 8, 11),
      oldEndMs: at(2026, 7, 8, 12, 30),
      // The reasons are the screen's and the audit's: unchanged, to the letter.
      reason: 'Inhaberüberschneidung',
      reasonKey: 'engine.repair.conflictKind.inhaber',
      bufferUsedMin: 30,
    });
    // The largest free window is the one after the first block; it lands at its start.
    expect(r.movedBlocks[0].newStartMs).toBe(at(2026, 7, 8, 12));
    expect(r.movedBlocks[0].newEndMs).toBe(at(2026, 7, 8, 13, 30));
    expect(r.conflictsBefore).toBe(1);
    expect(r.conflictsAfter).toBe(0);
    expect(r.assignedBlocks.find(b => b.block_id === 'o1')).toEqual(first);
  });

  it('a regular driver overlapping himself is reported, never moved', () => {
    const a = mk({ id: 'r1', driver: RITA, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const b = mk({ id: 'r2', driver: RITA, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 120 });

    const r = run([a, b], 2026, 7);

    expect(r.movedBlocks).toEqual([]);
    expect(r.assignedBlocks).toEqual([a, b]);
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
  });

  it('a block with no driver id is a driver nobody can identify: two of them are not taken for one person', () => {
    const a = mk({ id: 'x1', driver: { id: '', name: NAMESAKE.name }, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const b = mk({ id: 'x2', driver: { id: '', name: NAMESAKE.name }, vehicle: 'V2', startMs: at(2026, 7, 8, 11), durationMin: 120 });

    const r = run([a, b], 2026, 7);

    expect(r.movedBlocks).toEqual([]);
    expect(r.conflictsBefore).toBe(0);
    expect(r.diagnostics.fahrerUeberschneidungen).toBe(0);
  });

  it('a namesake is not the owner: its blocks are regular, so a vehicle clash is reported, not moved', () => {
    // Same vehicle, overlapping in time, two different people. By name the
    // namesake was "the Inhaber", therefore shiftable, and the pass moved it.
    const namesake = mk({ id: 'e', driver: NAMESAKE, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const rita = mk({ id: 'r', driver: RITA, vehicle: 'V1', startMs: at(2026, 7, 8, 11), durationMin: 120 });

    const r = run([namesake, rita], 2026, 7);

    expect(r.movedBlocks).toEqual([]);
    expect(r.assignedBlocks).toEqual([namesake, rita]);
    expect(r.diagnostics.fahrzeugUeberschneidungen).toBe(1);
    expect(r.unrepairable).toHaveLength(1);
    expect(r.unrepairable[0].reasonKey).toBe('engine.repair.unrepairable.regularDriverConflict');
  });

  it('the owner is still the owner: his block is shiftable, and a vehicle clash moves it', () => {
    // The counterpart of the namesake test: the same clash, but the block is the owner's.
    const owner = mk({ id: 'o', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 120 });
    const rita = mk({ id: 'r', driver: RITA, vehicle: 'V1', startMs: at(2026, 7, 8, 11), durationMin: 120 });

    const r = run([owner, rita], 2026, 7);

    expect(r.movedBlocks).toHaveLength(1);
    expect(r.movedBlocks[0]).toMatchObject({ blockId: 'o', reason: 'Fahrzeugüberschneidung', reasonKey: 'engine.repair.conflictKind.vehicle' });
    expect(r.conflictsAfter).toBe(0);
    expect(r.assignedBlocks.find(b => b.block_id === 'r')).toEqual(rita);
  });

  it("a namesake's blocks do not bound where the owner's block can go", () => {
    // The owner overlaps himself on 20.07., so his shorter block moves. The
    // largest free window is the one from the start of the month. The namesake
    // holds 00:00-03:00 on the 1st on another vehicle: not the owner's time.
    const o1 = mk({ id: 'o1', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 20, 10), durationMin: 120 });
    const o2 = mk({ id: 'o2', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 20, 11), durationMin: 90 });
    const namesake = mk({ id: 'e', driver: NAMESAKE, vehicle: 'V3', startMs: at(2026, 7, 1, 0), durationMin: 180 });

    const r = run([o1, o2, namesake], 2026, 7);

    expect(r.movedBlocks).toHaveLength(1);
    expect(r.movedBlocks[0].blockId).toBe('o2');
    expect(r.movedBlocks[0].newStartMs).toBe(at(2026, 7, 1, 0));
    expect(r.conflictsAfter).toBe(0);
    expect(r.assignedBlocks.find(b => b.block_id === 'e')).toEqual(namesake);
  });

  /**
   * The buffer pair. The owner's second block would go to the largest free
   * window, which opens at 01:00 on the 1st, when Rita's block frees V2. A block
   * of V1 ends ten minutes earlier, at 00:50. Whether that V1 block is the
   * OWNER's decides if the landing waits: the 30-minute vehicle-switch buffer is
   * the owner's rule between his own vehicles.
   */
  function bufferScenario(neighbour: { id: string; name: string }): AssignedBlock[] {
    return [
      mk({ id: 'o1', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 20, 10), durationMin: 120 }),
      mk({ id: 'o2', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 20, 11), durationMin: 90 }),
      mk({ id: 'rita', driver: RITA, vehicle: 'V2', startMs: at(2026, 7, 1, 0), durationMin: 60 }),
      mk({ id: 'next-door', driver: neighbour, vehicle: 'V1', startMs: at(2026, 7, 1, 0, 20), durationMin: 30 }),
    ];
  }

  it("the owner's own buffer still applies between his own vehicles", () => {
    const r = run(bufferScenario(OWNER), 2026, 7);

    expect(r.movedBlocks).toHaveLength(1);
    expect(r.movedBlocks[0].blockId).toBe('o2');
    // 01:00 would leave ten minutes to his block on V1, so the block waits until
    // the gap is the full thirty (a gap of zero, touching, is not a switch).
    expect(r.movedBlocks[0].newStartMs).toBe(at(2026, 7, 1, 1, 20));
  });

  it("a namesake's block next door is not the owner's neighbour: no vehicle-switch buffer applies", () => {
    // The same geometry, one difference: the block ten minutes earlier belongs
    // to another person who shares the owner's name. Nothing is owed to it.
    const r = run(bufferScenario(NAMESAKE), 2026, 7);

    expect(r.movedBlocks).toHaveLength(1);
    expect(r.movedBlocks[0].blockId).toBe('o2');
    expect(r.movedBlocks[0].newStartMs).toBe(at(2026, 7, 1, 1, 0));
  });

  it("a namesake whose block an earlier repair placed is shiftable, but is not held to the owner's buffer", () => {
    // Shiftable is not the same as owner: a repair flag makes any driver's block
    // movable. The buffer is the owner's rule, so a namesake that merely shares
    // his name does not inherit it. The geometry is the buffer pair's, with the
    // moving block and its neighbour both the namesake's.
    const blocks = [
      mk({ id: 'n1', driver: NAMESAKE, vehicle: 'V1', startMs: at(2026, 7, 20, 10), durationMin: 120 }),
      mk({ id: 'n2', driver: NAMESAKE, vehicle: 'V2', startMs: at(2026, 7, 20, 11), durationMin: 90, over: { repair_moved: true } }),
      mk({ id: 'rita', driver: RITA, vehicle: 'V2', startMs: at(2026, 7, 1, 0), durationMin: 60 }),
      mk({ id: 'next-door', driver: NAMESAKE, vehicle: 'V1', startMs: at(2026, 7, 1, 0, 20), durationMin: 30 }),
    ];

    const r = run(blocks, 2026, 7);

    expect(r.movedBlocks).toHaveLength(1);
    expect(r.movedBlocks[0]).toMatchObject({
      blockId: 'n2',
      reason: 'Fahrerüberschneidung',
      reasonKey: 'engine.repair.conflictKind.driver',
    });
    expect(r.movedBlocks[0].newStartMs).toBe(at(2026, 7, 1, 1, 0));
  });

  it('a block with no driver id has no other blocks to dodge: unknown drivers are not one person', () => {
    // A vehicle clash moves the shiftable block of a driver nobody can identify.
    // Another unidentified driver holds the start of the month; it is not his time.
    const blocks = [
      mk({ id: 'u1', driver: { id: '', name: 'Unbekannt' }, vehicle: 'V1', startMs: at(2026, 7, 20, 10), durationMin: 120, over: { repair_moved: true } }),
      mk({ id: 'rita', driver: RITA, vehicle: 'V1', startMs: at(2026, 7, 20, 11), durationMin: 90 }),
      mk({ id: 'u2', driver: { id: '', name: 'Unbekannt zwei' }, vehicle: 'V3', startMs: at(2026, 7, 1, 0), durationMin: 180 }),
    ];

    const r = run(blocks, 2026, 7);

    expect(r.movedBlocks).toHaveLength(1);
    expect(r.movedBlocks[0]).toMatchObject({ blockId: 'u1', reason: 'Fahrzeugüberschneidung' });
    expect(r.movedBlocks[0].newStartMs).toBe(at(2026, 7, 1, 0));
    expect(r.conflictsAfter).toBe(0);
  });
});

// ── defect 2: the pass writes the local wall clock ──────────────────────────

describe('what a moved block carries is its own local wall clock', () => {
  interface Landing {
    label: string;
    year: number;
    month: number;
    /** The owner works days 1..pairDay-1; on pairDay two of his blocks overlap. */
    pairDay: number;
    first: { startMs: number; durationMin: number };
    second: { startMs: number; durationMin: number };
    expectStart: string;
    expectEnd: string;
    /** Minutes the old UTC read put the string BEFORE the Berlin wall clock. */
    oldOffsetMin: number;
  }

  const landings: Landing[] = [
    {
      label: 'January (UTC+1)',
      year: 2026, month: 1, pairDay: 15,
      first: { startMs: at(2026, 1, 15, 10), durationMin: 180 },
      second: { startMs: at(2026, 1, 15, 11), durationMin: 120 },
      expectStart: '2026-01-15T13:00', expectEnd: '2026-01-15T15:00', oldOffsetMin: 60,
    },
    {
      label: 'July (UTC+2)',
      year: 2026, month: 7, pairDay: 15,
      first: { startMs: at(2026, 7, 15, 10), durationMin: 180 },
      second: { startMs: at(2026, 7, 15, 11), durationMin: 120 },
      expectStart: '2026-07-15T13:00', expectEnd: '2026-07-15T15:00', oldOffsetMin: 120,
    },
    {
      // The clocks go back at 03:00 CEST, so 02:00-03:00 happens twice and the
      // first block lasts four real hours across a three-hour wall clock.
      label: '25.10.2026, the 25-hour day',
      year: 2026, month: 10, pairDay: 25,
      first: { startMs: at(2026, 10, 25, 0, 30), durationMin: 240 },
      second: { startMs: at(2026, 10, 25, 1, 0), durationMin: 120 },
      expectStart: '2026-10-25T03:30', expectEnd: '2026-10-25T05:30', oldOffsetMin: 60,
    },
    {
      // 02:00-03:00 does not exist: the first block is two real hours long, and
      // the old UTC string for the landing, 02:00, is a time that day never had.
      label: '29.03.2026, the 23-hour day',
      year: 2026, month: 3, pairDay: 29,
      first: { startMs: at(2026, 3, 29, 1, 0), durationMin: 120 },
      second: { startMs: at(2026, 3, 29, 1, 30), durationMin: 60 },
      expectStart: '2026-03-29T04:00', expectEnd: '2026-03-29T05:00', oldOffsetMin: 120,
    },
  ];

  it.each(landings)('$label: the strings equal the Berlin wall clock of the instant', c => {
    const blocks = [
      ...ownerWorkdays(c.year, c.month, c.pairDay - 1),
      mk({ id: 'p', driver: OWNER, vehicle: 'V1', ...c.first }),
      mk({ id: 'c', driver: OWNER, vehicle: 'V2', ...c.second }),
    ];

    const r = run(blocks, c.year, c.month);

    expect(r.movedBlocks).toHaveLength(1);
    const move = r.movedBlocks[0];
    expect(move.blockId).toBe('c');
    // The scenario lands the block right after the first one (the largest free window).
    expect(move.newStartMs).toBe(c.first.startMs + c.first.durationMin * MIN);

    const moved = r.assignedBlocks.find(b => b.block_id === 'c')!;
    expect(moved.actual_start_ms).toBe(move.newStartMs);
    expect(moved.actual_end_ms).toBe(move.newEndMs);
    // Independent of the code under test: the platform's Berlin clock.
    expect(moved.block_start_datetime).toBe(berlin(moved.actual_start_ms!).iso);
    expect(moved.block_end_datetime).toBe(berlin(moved.actual_end_ms!).iso);
    expect(moved.service_date).toBe(berlin(moved.actual_start_ms!).date);
    // And as literals, so a wrong zone cannot make the two sides agree by accident.
    expect(moved.block_start_datetime).toBe(c.expectStart);
    expect(moved.block_end_datetime).toBe(c.expectEnd);
    expect(moved.service_date).toBe(c.expectStart.slice(0, 10));
    // The old string, for the record: the instant read through UTC.
    const utcRead = new Date(moved.actual_start_ms! - c.oldOffsetMin * MIN);
    expect(isoLocal(utcRead.getTime())).not.toBe(moved.block_start_datetime);
    // Everything the pass did not move is as Phase 3 left it.
    for (const before of blocks.filter(b => b.block_id !== 'c')) {
      expect(r.assignedBlocks.find(b => b.block_id === before.block_id)).toEqual(before);
    }
  });

  it.each(landings)('$label: the screen shows the same clock as the data', c => {
    const blocks = [
      ...ownerWorkdays(c.year, c.month, c.pairDay - 1),
      mk({ id: 'p', driver: OWNER, vehicle: 'V1', ...c.first }),
      mk({ id: 'c', driver: OWNER, vehicle: 'V2', ...c.second }),
    ];

    const move = run(blocks, c.year, c.month).movedBlocks[0];

    expect(fmtRepairMs(move.newStartMs)).toBe(c.expectStart.slice(11));
    expect(fmtRepairMs(move.newEndMs)).toBe(c.expectEnd.slice(11));
    // The "Alt" column prints the block's old time, not the old time minus an offset.
    expect(fmtRepairMs(move.oldStartMs)).toBe(berlin(c.second.startMs).time);
    expect(fmtRepairMs(move.oldEndMs)).toBe(berlin(c.second.startMs + c.second.durationMin * MIN).time);
  });

  const monthStarts = [
    { label: 'January', year: 2026, month: 1 },
    { label: 'March (29.03. falls inside)', year: 2026, month: 3 },
    { label: 'July', year: 2026, month: 7 },
    { label: 'October (25.10. falls inside)', year: 2026, month: 10 },
  ];

  it.each(monthStarts)('$label: a block moved to the start of the month starts at local midnight', m => {
    // The owner overlaps himself late in the month, so the largest free window
    // is the one from the start of the month.
    const blocks = [
      mk({ id: 'p', driver: OWNER, vehicle: 'V1', startMs: at(m.year, m.month, 20, 10), durationMin: 180 }),
      mk({ id: 'c', driver: OWNER, vehicle: 'V2', startMs: at(m.year, m.month, 20, 11), durationMin: 90 }),
    ];

    const r = run(blocks, m.year, m.month);

    expect(r.movedBlocks).toHaveLength(1);
    const moved = r.assignedBlocks.find(b => b.block_id === 'c')!;
    const first = `${m.year}-${pad(m.month)}-01`;
    expect(moved.actual_start_ms).toBe(at(m.year, m.month, 1));
    expect(moved.block_start_datetime).toBe(`${first}T00:00`);
    expect(moved.block_end_datetime).toBe(`${first}T01:30`);
    expect(moved.service_date).toBe(first);
    expect(moved.block_start_datetime).toBe(berlin(moved.actual_start_ms!).iso);
  });

  it('a block with no instant of its own is read as a local wall clock, not as UTC', () => {
    // 10:00-11:30 local on the string-only block overlaps 09:00-10:30 on the
    // other (30 minutes). Read as UTC it would be 12:00-13:30 local and clear.
    const stringsOnly = mk({ id: 's', driver: OWNER, vehicle: 'V1', startMs: at(2026, 7, 8, 10), durationMin: 90, stringsOnly: true });
    const instant = mk({ id: 'i', driver: OWNER, vehicle: 'V2', startMs: at(2026, 7, 8, 9), durationMin: 90 });
    expect(stringsOnly.actual_start_ms).toBeUndefined();

    const r = run([stringsOnly, instant], 2026, 7);

    expect(r.movedBlocks).toHaveLength(1);
    expect(r.conflictsBefore).toBe(1);
    expect(r.conflictsAfter).toBe(0);
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
