/**
 * Phase 1 reports a same-vehicle overlapping block pair.
 *
 * ## What was missing
 *
 * Phase 1 emitted six coverage warning types and no overlap test of any kind,
 * and nothing anywhere in the pipeline compares two blocks of **one vehicle**:
 * Phase 3 checks a driver against himself, and the finalization checks a driver
 * and a vehicle switch. So Phase 1 could emit two blocks of one vehicle whose
 * time ranges intersect, and the pair travelled the whole pipeline unreported.
 *
 * `buildPhase1VehicleBlocks` really does produce such a pair: the max-duration
 * split opens the next block at the next ride's start, and the walk is sorted by
 * start only, so a nested ride — one that begins and ends inside a longer ride
 * of the same vehicle — leaves the second block inside the first. The first
 * tests below assert exactly that (the blocks overlap) before asserting that the
 * warning names them, so the test cannot pass by reporting something that is not
 * there.
 *
 * ## What this does not do
 *
 * It reports. No block is moved, split, merged, re-timed or dropped and no trip
 * leaves a block, which the last group asserts. Planning is daily and per
 * vehicle; a driver-side or reporting concern must never reshape a vehicle's
 * day.
 *
 * ## On today's data it fires never
 *
 * Across all 8 imports on staging and production there are currently 0
 * same-vehicle overlapping rides. This is a guard for the next import, not a fix
 * for existing data.
 */
import { describe, expect, it } from 'vitest';
import { buildPhase1VehicleBlocks, type Phase1Trip } from './monatsplanungPhase1';
import { engineText } from '../i18n/engineMessage';
import { translate } from '../i18n';

/** Local wall-clock instant, the only construction right on a 23- or 25-hour day. */
const at = (y: number, m: number, d: number, h: number, min: number): number =>
  new Date(y, m - 1, d, h, min).getTime();

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * One ride. `start_time` / `end_time` are the normalized HH:MM Phase 1 requires
 * to be present; the absolute instants are what it actually groups by, exactly
 * as `CompanyPlannerPage` hands them over from `resolveActualRideWindow`.
 */
function ride(id: string, car: string, startMs: number, endMs: number): Phase1Trip {
  const s = new Date(startMs);
  const e = new Date(endMs);
  return {
    id,
    trip_date: `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`,
    start_time: `${pad(s.getHours())}:${pad(s.getMinutes())}`,
    end_time: `${pad(e.getHours())}:${pad(e.getMinutes())}`,
    car_id: car,
    car_identifier: car,
    is_canceled: false,
    source_row_index: null,
    actual_start_ms: startMs,
    actual_end_ms: endMs,
  };
}

/** Merging off and a 4 h ceiling, so the split under test is the only one. */
const OPTS = { minBlockDurationMinutes: 0, maxBlockDurationMinutes: 240 };

const overlaps = (result: ReturnType<typeof buildPhase1VehicleBlocks>) =>
  result.coverageIssues.filter(c => c.type === 'block_overlap');

describe('the timezone premise these tests rest on', () => {
  it('runs in Europe/Berlin', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Berlin');
  });
});

describe('Phase 1 reports a same-vehicle overlapping block pair', () => {
  it('finds the pair a nested ride produces, and names both blocks', () => {
    const result = buildPhase1VehicleBlocks([
      ride('long',   'V1', at(2026, 5, 4, 10, 0), at(2026, 5, 4, 16, 0)),
      ride('nested', 'V1', at(2026, 5, 4, 10, 30), at(2026, 5, 4, 11, 0)),
    ], OPTS);

    // The premise: two blocks of one vehicle that really do intersect.
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].block_start_datetime).toBe('2026-05-04T10:00');
    expect(result.blocks[0].block_end_datetime).toBe('2026-05-04T16:00');
    expect(result.blocks[1].block_start_datetime).toBe('2026-05-04T10:30');
    expect(result.blocks[1].block_end_datetime).toBe('2026-05-04T11:00');
    expect(result.blocks[0].vehicle_id).toBe(result.blocks[1].vehicle_id);

    const found = overlaps(result);
    expect(found).toHaveLength(1);
    expect(found[0].messageVars).toEqual({
      vehicle: 'V1',
      blockId: result.blocks[0].block_id,
      otherBlockId: result.blocks[1].block_id,
      minutes: 30,
    });
    expect(found[0].detail).toBe(
      `Fahrzeug V1: Block ${result.blocks[0].block_id} und Block ${result.blocks[1].block_id} überlappen sich um 30 Min.`,
    );
  });

  it('finds it across midnight, which a wall-clock comparison cannot', () => {
    // A bare HH:MM comparison reads the first block as 22:00→03:00 and the
    // second as 23:00→23:30, so `23:00 >= 03:00` ends the scan and the pair is
    // missed. Absolute milliseconds are what make this case visible.
    const result = buildPhase1VehicleBlocks([
      ride('night',  'V2', at(2026, 3, 14, 22, 0), at(2026, 3, 15, 3, 0)),
      ride('inside', 'V2', at(2026, 3, 14, 23, 0), at(2026, 3, 14, 23, 30)),
    ], OPTS);

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].block_end_datetime).toBe('2026-03-15T03:00');
    expect(result.blocks[1].block_start_datetime).toBe('2026-03-14T23:00');

    const found = overlaps(result);
    expect(found).toHaveLength(1);
    expect(found[0].messageVars?.minutes).toBe(30);
  });

  it('finds it on the 25-hour day, where a fixed 24-hour step is an hour out', () => {
    // 2026-10-25 is the fall-back day: 22:00 on the 24th to 03:00 on the 25th
    // is six real hours, not five. Nothing here steps a day by a constant, and
    // this is the case that would notice if it did.
    const result = buildPhase1VehicleBlocks([
      ride('dst',    'V3', at(2026, 10, 24, 22, 0), at(2026, 10, 25, 3, 0)),
      ride('inside', 'V3', at(2026, 10, 24, 23, 0), at(2026, 10, 24, 23, 30)),
    ], OPTS);

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].duration_minutes).toBe(360);

    const found = overlaps(result);
    expect(found).toHaveLength(1);
    expect(found[0].messageVars?.minutes).toBe(30);
  });

  it('finds a pair that is not a neighbouring pair', () => {
    // Two rides nested inside one long one, far enough apart (120 min > the
    // 60-minute separator) to become two blocks of their own: three blocks,
    // where the long one overlaps BOTH short ones and the two short ones do
    // not touch each other. A scan that compared only neighbouring blocks
    // would find the first pair and miss the second.
    const result = buildPhase1VehicleBlocks([
      ride('long',         'V4', at(2026, 5, 4, 10, 0), at(2026, 5, 4, 20, 0)),
      ride('firstNested',  'V4', at(2026, 5, 4, 10, 30), at(2026, 5, 4, 11, 0)),
      ride('secondNested', 'V4', at(2026, 5, 4, 13, 0), at(2026, 5, 4, 13, 30)),
    ], OPTS);

    expect(result.blocks.map(b => b.block_start_datetime)).toEqual([
      '2026-05-04T10:00', '2026-05-04T10:30', '2026-05-04T13:00',
    ]);

    const found = overlaps(result);
    expect(found).toHaveLength(2);
    expect(found.map(c => c.messageVars?.otherBlockId)).toEqual([
      result.blocks[1].block_id,
      result.blocks[2].block_id,
    ]);
    expect(found.map(c => c.messageVars?.minutes)).toEqual([30, 30]);
  });
});

describe('Phase 1 does not invent an overlap', () => {
  it('says nothing about two blocks of one vehicle that are merely apart', () => {
    const result = buildPhase1VehicleBlocks([
      ride('morning',   'V5', at(2026, 5, 4, 8, 0), at(2026, 5, 4, 9, 0)),
      ride('afternoon', 'V5', at(2026, 5, 4, 11, 0), at(2026, 5, 4, 12, 0)),
    ], OPTS);

    expect(result.blocks).toHaveLength(2);
    expect(overlaps(result)).toEqual([]);
  });

  it('says nothing about a block that ends exactly where the next begins', () => {
    const result = buildPhase1VehicleBlocks([
      ride('first',  'V6', at(2026, 5, 4, 8, 0), at(2026, 5, 4, 12, 0)),
      ride('second', 'V6', at(2026, 5, 4, 12, 0), at(2026, 5, 4, 13, 0)),
    ], OPTS);

    expect(result.blocks).toHaveLength(2);
    expect(overlaps(result)).toEqual([]);
  });

  it('never compares two vehicles, however much their blocks overlap', () => {
    const result = buildPhase1VehicleBlocks([
      ride('a', 'V7', at(2026, 5, 4, 10, 0), at(2026, 5, 4, 12, 0)),
      ride('b', 'V8', at(2026, 5, 4, 10, 30), at(2026, 5, 4, 11, 30)),
    ], OPTS);

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].vehicle_id).not.toBe(result.blocks[1].vehicle_id);
    expect(overlaps(result)).toEqual([]);
  });

  it('says nothing about a month of ordinary, well-separated blocks', () => {
    const trips: Phase1Trip[] = [];
    for (let day = 1; day <= 28; day++) {
      trips.push(ride(`early-${day}`, 'V9', at(2026, 5, day, 6, 0), at(2026, 5, day, 9, 0)));
      trips.push(ride(`late-${day}`,  'V9', at(2026, 5, day, 15, 0), at(2026, 5, day, 18, 0)));
    }
    const result = buildPhase1VehicleBlocks(trips, OPTS);

    expect(result.blocks).toHaveLength(56);
    expect(overlaps(result)).toEqual([]);
  });
});

describe('the warning reports and changes nothing', () => {
  const trips = [
    ride('long',   'V1', at(2026, 5, 4, 10, 0), at(2026, 5, 4, 16, 0)),
    ride('nested', 'V1', at(2026, 5, 4, 10, 30), at(2026, 5, 4, 11, 0)),
  ];

  it('leaves every trip in exactly one block', () => {
    const result = buildPhase1VehicleBlocks(trips, OPTS);
    const assigned = result.blocks.flatMap(b => b.trip_ids);

    expect(assigned.sort()).toEqual(['long', 'nested']);
    expect(result.skippedTrips).toEqual([]);
    expect(result.coverageIssues.filter(c => c.type === 'duplicate_trip')).toEqual([]);
    expect(result.coverageIssues.filter(c => c.type === 'missing_trip')).toEqual([]);
  });

  it('leaves the blocks themselves untouched', () => {
    const result = buildPhase1VehicleBlocks(trips, OPTS);

    expect(result.blocks.map(b => [b.block_start_datetime, b.block_end_datetime, b.duration_minutes])).toEqual([
      ['2026-05-04T10:00', '2026-05-04T16:00', 360],
      ['2026-05-04T10:30', '2026-05-04T11:00', 30],
    ]);
    expect(result.summary.blocks_total).toBe(2);
    expect(result.summary.blocks_split_by_max_duration).toBe(1);
  });

  it('counts the new warning in the summary the screen reads', () => {
    const result = buildPhase1VehicleBlocks(trips, OPTS);

    // `coverage_issues` drives the planner's StatCard and its
    // problems-detected banner, so the new type is surfaced by counting.
    expect(result.summary.coverage_issues).toBe(result.coverageIssues.length);
    expect(result.summary.coverage_issues).toBeGreaterThan(overlaps(result).length);
  });
});

describe('the dictionaries carry the warning', () => {
  const trips = [
    ride('long',   'V1', at(2026, 5, 4, 10, 0), at(2026, 5, 4, 16, 0)),
    ride('nested', 'V1', at(2026, 5, 4, 10, 30), at(2026, 5, 4, 11, 0)),
  ];

  it('the German entry renders exactly the text the engine produced', () => {
    // CLAUDE.md: a German dictionary entry must render exactly the text the
    // engine already produced, or turning the key on silently rewords the
    // German UI.
    const result = buildPhase1VehicleBlocks(trips, OPTS);
    const issue = overlaps(result)[0];

    const rendered = engineText(
      (key, vars) => translate('de', key, vars),
      issue.detail,
      issue.messageKey,
      issue.messageVars,
    );
    expect(rendered).toBe(issue.detail);
  });

  it('the English entry renders the same facts in English', () => {
    const result = buildPhase1VehicleBlocks(trips, OPTS);
    const issue = overlaps(result)[0];

    const rendered = engineText(
      (key, vars) => translate('en', key, vars),
      issue.detail,
      issue.messageKey,
      issue.messageVars,
    );
    expect(rendered).toBe(
      `Vehicle V1: block ${result.blocks[0].block_id} and block ${result.blocks[1].block_id} overlap by 30 min`,
    );
  });
});
