/**
 * The join between screen 4 and the three document builders.
 *
 * ## Why this file exists at all
 *
 * The four pieces of §10–§12 were built in parallel against a contract none of
 * them could import, and `monthlyPlanDocumentBuilders.ts` shipped as an **empty
 * map** — the screen typechecked, every builder's own suite passed, and the
 * documents tab rendered nothing. A join with no test is where that hides.
 *
 * So the assertions below are about the join and nothing else, and they are
 * written the one way that can catch it: each one compares what the **screen**
 * receives against what the **builder** itself produces from the same plan. A
 * test that restated the expected figures as literals would agree with an
 * adapter that computed them wrongly, which is the exact failure mode CLAUDE.md
 * records twice over in this product's older Stundennachweis builders.
 *
 * Every plan here comes out of the real engine through `project()`, so a
 * projection that drifts from what the engine produces fails here too.
 */

import { describe, it, expect } from 'vitest';
import {
  PROPOSAL_NOTICE,
  storedPlanFromGenerated,
  type StoredMonthlyPlan,
  type StoredPlanProjection,
} from './monthlyPlanDocuments';
import { assignBlocks, buildBlocks, buildAvailability, validatePlan } from './monthlyPlan';
import type { PlanDriverInput, PlanTripInput } from './monthlyPlan';
import { MONTHLY_PLAN_DOCUMENT_BUILDERS } from './monthlyPlanDocumentBuilders';
import {
  buildMonthlyPlanStundennachweise,
  formatPlanHours,
  PLAN_STUNDENNACHWEIS_COLUMNS,
} from './monthlyPlanStundennachweis';
import {
  buildPayrollSummary,
  computePlanDriverHours,
  PAYROLL_SUMMARY_COLUMNS,
} from './monthlyPlanPayrollSummary';
import {
  buildPlannedFahrtenbuch,
  type PlannedFahrtenbuchSheet,
} from './monthlyPlanFahrtenbuchExport';

// ── fixtures ────────────────────────────────────────────────────────────────

const CAR_UUID = '11111111-2222-3333-4444-555555555555';
const STAMP = new Date('2026-09-30T11:00:00+02:00');

function trip(p: Partial<PlanTripInput> & { id: string }): PlanTripInput {
  return {
    id: p.id,
    vehicleId: 'vehicleId' in p ? p.vehicleId! : CAR_UUID,
    vehicleIdentifier: 'vehicleIdentifier' in p ? p.vehicleIdentifier! : 'B-AA-1',
    startAt: p.startAt,
    endAt: p.endAt,
    tripDate: p.tripDate,
    startTime: p.startTime,
    endTime: p.endTime,
    isCanceled: p.isCanceled,
    originalDriverName: p.originalDriverName ?? null,
    originalDriverId: p.originalDriverId ?? null,
  };
}

function driver(p: Partial<PlanDriverInput> & { id: string; name: string }): PlanDriverInput {
  return {
    id: p.id,
    name: p.name,
    isOwner: p.isOwner ?? false,
    minSalary: 'minSalary' in p ? p.minSalary! : 1000,
    maxSalary: 'maxSalary' in p ? p.maxSalary! : 2000,
    hourlyRate: 'hourlyRate' in p ? p.hourlyRate! : 20,
    maxMonthlyHours: p.maxMonthlyHours,
    planningPriority: p.planningPriority,
    canCoverOtherDrivers: p.canCoverOtherDrivers,
  };
}

/** The real engine, so the adapters are fed what production feeds them. */
function project(trips: PlanTripInput[], drivers: PlanDriverInput[]): StoredMonthlyPlan {
  const switchMinutes = 60;
  const built = buildBlocks(trips, { switchMinutes });
  const pool = new Set(drivers.map(d => d.id));
  const availability = buildAvailability([], built.blocks, pool);
  const result = assignBlocks(built.blocks, drivers, availability, { switchMinutes, seed: 0 });
  const validation = validatePlan({
    blocks: built.blocks,
    drivers,
    availability,
    result,
    switchMinutes,
    rejectedTrips: built.rejected,
    sourceOverlaps: built.overlaps,
  });
  const projection: StoredPlanProjection = {
    companyId: 'company-1',
    year: 2026,
    month: 10,
    importId: 'import-1',
    switchMinutes,
    generation: 0,
    blocks: built.blocks,
    drivers,
    result,
    warnings: validation.warnings,
    selectedDriverIds: pool,
  };
  return { ...storedPlanFromGenerated(projection), id: 'plan-1' };
}

/** One driver, one 81-minute ride — §16's own figure, on an ordinary Monday. */
function simplePlan(): StoredMonthlyPlan {
  return project(
    [trip({
      id: 't1',
      startAt: '2026-10-05T08:23:00+02:00',
      endAt: '2026-10-05T09:44:00+02:00',
    })],
    [driver({ id: 'd1', name: 'Anna Beispiel' })],
  );
}

// ── 1. the wiring itself ────────────────────────────────────────────────────

describe('MONTHLY_PLAN_DOCUMENT_BUILDERS', () => {
  /**
   * The regression this file was written for. The map shipped empty once; the
   * screen's own `documentBlockReason` turns a missing builder into
   * "not in this build", so the tab explained itself and nobody noticed.
   */
  it('holds a builder for each of the three documents §10–§12 require', () => {
    expect(Object.keys(MONTHLY_PLAN_DOCUMENT_BUILDERS).sort())
      .toEqual(['fahrtenbuch', 'payroll_summary', 'stundennachweis']);
  });

  it('gives each builder the kind it is filed under, so the screen cannot mislabel one', () => {
    for (const [key, builder] of Object.entries(MONTHLY_PLAN_DOCUMENT_BUILDERS)) {
      expect(builder?.kind).toBe(key);
    }
  });

  /**
   * §10's document is the imported sheet with the driver column overlaid, so it
   * needs the import's own rows — which a plan does not carry. Losing `load`
   * would leave `preview` with nothing and draw an empty Fahrtenbuch, which is a
   * claim that the month had no rides.
   */
  it('gives the Fahrtenbuch a load step and the other two none', () => {
    expect(typeof MONTHLY_PLAN_DOCUMENT_BUILDERS.fahrtenbuch?.load).toBe('function');
    expect(MONTHLY_PLAN_DOCUMENT_BUILDERS.stundennachweis?.load).toBeUndefined();
    expect(MONTHLY_PLAN_DOCUMENT_BUILDERS.payroll_summary?.load).toBeUndefined();
  });

  it('puts the proposal notice in every document header, which is the plan\'s own rule', () => {
    const plan = simplePlan();
    const sn = MONTHLY_PLAN_DOCUMENT_BUILDERS.stundennachweis!
      .preview({ plan, generatedAt: STAMP });
    const payroll = MONTHLY_PLAN_DOCUMENT_BUILDERS.payroll_summary!
      .preview({ plan, generatedAt: STAMP });
    const fahrtenbuch = MONTHLY_PLAN_DOCUMENT_BUILDERS.fahrtenbuch!
      .preview({ plan, generatedAt: STAMP }, fahrtenbuchSheet(plan));

    for (const preview of [sn, payroll, fahrtenbuch]) {
      expect(preview.header.some(line => line.includes(PROPOSAL_NOTICE))).toBe(true);
    }
  });
});

// ── 2. §11 — the Stundennachweis adapter copies, never computes ─────────────

describe('the Stundennachweis adapter', () => {
  const builder = MONTHLY_PLAN_DOCUMENT_BUILDERS.stundennachweis!;

  it('names its subjects from the builder\'s own driver list', () => {
    const plan = simplePlan();
    const set = buildMonthlyPlanStundennachweise(
      // The adapter's projection is internal, so the comparison is made on the
      // one thing both sides agree on: the ids and names in the plan.
      { year: plan.year, month: plan.month, status: plan.status,
        drivers: plan.drivers.map(d => ({
          driverId: d.driver_id, driverName: d.driver_name, isOwner: d.is_owner,
          selected: d.selected,
        })),
        blocks: plan.blocks.map(b => ({
          blockKey: b.block_key, carId: b.car_id, carIdentifier: b.car_identifier,
          startsAt: b.starts_at, endsAt: b.ends_at,
          spanMinutes: b.span_minutes, rideMinutes: b.ride_minutes,
          driverId: b.driver_id, driverName: b.driver_name,
        })) },
      { generatedAt: new Date(0) },
    );

    expect(builder.subjects!(plan)).toEqual(
      set.drivers.filter(d => d.exportable).map(d => ({ id: d.driverId, label: d.driverName })),
    );
  });

  /**
   * §16's own figure, read off the screen: 08:23 → 09:44 is 81 minutes, which is
   * 1,35 hours. It is asserted through the **preview** rather than through the
   * builder, because the adapter is what chooses the unit for the cell, and the
   * two older builders in this product print one unit in the rows and another in
   * the total.
   */
  it('prints §16\'s 81 minutes as 1,35 in the Grundlohn cell', () => {
    const plan = simplePlan();
    const preview = builder.preview({ plan, generatedAt: STAMP });
    const section = preview.sections[0];

    const grundlohnIndex = section.columns.findIndex(c => c.header === 'Grundlohn');
    expect(grundlohnIndex).toBeGreaterThan(0);

    const row = section.rows.find(r => r.cells[0] === '05.10.2026');
    expect(row?.cells[grundlohnIndex]).toBe('1,35');
    // And the same unit in the totals row, which is the half that used to differ.
    expect(section.totals?.[grundlohnIndex]).toBe('1,35');
  });

  it('draws one row per calendar day of the month, so no day is silently absent', () => {
    const plan = simplePlan();
    const section = builder.preview({ plan, generatedAt: STAMP }).sections[0];
    // October has 31 days, and the builder always emits the whole month.
    expect(section.rows).toHaveLength(31);
    expect(section.rows[0].cells[0]).toBe('01.10.2026');
    expect(section.rows[30].cells[0]).toBe('31.10.2026');
  });

  /**
   * The rule the whole join exists for: every hour cell must be the builder's own
   * minute figure through the builder's own formatter. Compared column by column
   * against a direct call, so an adapter that summed anything itself fails here.
   */
  it('reproduces the builder\'s totals exactly, in every hour column', () => {
    const plan = project(
      [
        trip({ id: 't1', startAt: '2026-10-05T22:00:00+02:00', endAt: '2026-10-06T01:30:00+02:00' }),
        trip({ id: 't2', startAt: '2026-10-11T09:00:00+02:00', endAt: '2026-10-11T17:00:00+02:00' }),
        trip({ id: 't3', startAt: '2026-10-03T20:00:00+02:00', endAt: '2026-10-03T23:15:00+02:00' }),
      ],
      [driver({ id: 'd1', name: 'Anna Beispiel', maxSalary: 9000 })],
    );

    const section = builder.preview({ plan, generatedAt: STAMP }).sections[0];
    const sheet = directStundennachweis(plan);

    const expected: Record<string, number> = {
      grundlohn: sheet.totals.grundlohn,
      nachtarbeit: sheet.totals.nachtarbeit,
      nachtarbeit04: sheet.totals.nacht04,
      sonntag: sheet.totals.sonntag,
      feiertag: sheet.totals.feiertag,
      weihnachten: sheet.totals.weihnachten,
    };

    for (const column of PLAN_STUNDENNACHWEIS_COLUMNS) {
      const at = section.columns.findIndex(c => c.header === column.label);
      expect(at).toBeGreaterThan(0);
      expect(section.totals?.[at]).toBe(formatPlanHours(expected[column.key]) || null);
    }
  });

  /**
   * CLAUDE.md's rule, and §11's: compression is display-only. The Von/Bis pairs
   * stop at three; the hour columns hold every period. Without the note a reader
   * sees three shifts and a total that does not match them, and cannot tell that
   * from a lost shift.
   */
  it('says so when a day has more periods than the form has columns', () => {
    const plan = project(
      [
        trip({ id: 'a', startAt: '2026-10-05T06:00:00+02:00', endAt: '2026-10-05T07:00:00+02:00' }),
        trip({ id: 'b', startAt: '2026-10-05T09:00:00+02:00', endAt: '2026-10-05T10:00:00+02:00' }),
        trip({ id: 'c', startAt: '2026-10-05T12:00:00+02:00', endAt: '2026-10-05T13:00:00+02:00' }),
        trip({ id: 'd', startAt: '2026-10-05T15:00:00+02:00', endAt: '2026-10-05T16:00:00+02:00' }),
      ],
      [driver({ id: 'd1', name: 'Anna Beispiel' })],
    );

    const sheet = directStundennachweis(plan);
    const day = sheet.days.find(d => d.dateKey === '2026-10-05');
    // The 60-minute switch splits these into four blocks on one day.
    expect(day?.compressed).toBe(true);

    const preview = builder.preview({ plan, generatedAt: STAMP });
    expect(preview.footnotes?.some(n => n.includes('Von/Bis'))).toBe(true);

    // And the hour column still carries all four periods, not the three shown.
    const section = preview.sections[0];
    const at = section.columns.findIndex(c => c.header === 'Grundlohn');
    const row = section.rows.find(r => r.cells[0] === '05.10.2026');
    expect(row?.cells[at]).toBe(formatPlanHours(day!.workedMinutes));
  });

  it('refuses a driver the plan has no block for, rather than drawing an empty sheet', () => {
    const plan = simplePlan();
    expect(() => builder.preview({ plan, subjectId: 'nobody', generatedAt: STAMP }))
      .toThrow(/Fahrer/);
  });
});

/** The Stundennachweis as its own module builds it, for comparison. */
function directStundennachweis(plan: StoredMonthlyPlan) {
  const set = buildMonthlyPlanStundennachweise(
    { year: plan.year, month: plan.month, status: plan.status,
      drivers: plan.drivers.map(d => ({
        driverId: d.driver_id, driverName: d.driver_name, isOwner: d.is_owner,
        selected: d.selected,
      })),
      blocks: plan.blocks.map(b => ({
        blockKey: b.block_key, carId: b.car_id, carIdentifier: b.car_identifier,
        startsAt: b.starts_at, endsAt: b.ends_at,
        spanMinutes: b.span_minutes, rideMinutes: b.ride_minutes,
        driverId: b.driver_id, driverName: b.driver_name,
      })) },
    { generatedAt: STAMP },
  );
  return set.drivers[0];
}

// ── 3. §12 — the payroll adapter ────────────────────────────────────────────

describe('the payroll summary adapter', () => {
  const builder = MONTHLY_PLAN_DOCUMENT_BUILDERS.payroll_summary!;

  /**
   * Cell for cell against a direct call. The adapter's only job here is to turn
   * the builder's `(string | number)[]` into preview cells, and the one
   * substantive choice — an empty string is a blank cell, not the text "" — is
   * what §12 asks for: a driver with no assigned work gets blanks, never zeros,
   * because nothing was measured for them.
   */
  it('renders the builder\'s own cells, blanks included', () => {
    const plan = project(
      [trip({ id: 't1', startAt: '2026-10-05T08:00:00+02:00', endAt: '2026-10-05T16:00:00+02:00' })],
      [
        driver({ id: 'd1', name: 'Anna Beispiel' }),
        driver({ id: 'd2', name: 'Bert Ohnearbeit' }),
      ],
    );

    const direct = buildPayrollSummary({
      month: plan.month,
      year: plan.year,
      companyName: '',
      drivers: plan.drivers.map(d => ({
        driverId: d.driver_id, driverName: d.driver_name, personalnummer: null,
      })),
      hoursByDriverId: computePlanDriverHours(plan.blocks.map(b => ({
        driverId: b.driver_id,
        startMs: Date.parse(b.starts_at),
        endMs: Date.parse(b.ends_at),
        rideMinutes: b.ride_minutes,
      }))),
      generatedAtMs: STAMP.getTime(),
    });

    const section = builder.preview({ plan, generatedAt: STAMP }).sections[0];

    expect(section.columns.map(c => c.header)).toEqual(PAYROLL_SUMMARY_COLUMNS.map(c => c.label));
    expect(section.rows.map(r => r.id)).toEqual(direct.rows.map(r => r.driverId));
    expect(section.rows.map(r => r.cells)).toEqual(
      direct.rows.map(r => r.cells.map(cell => (cell === '' ? null : String(cell)))),
    );
    // The driver with no block keeps a row of blanks, and is counted.
    expect(direct.driversWithoutWork).toBe(1);
    expect(section.rows).toHaveLength(2);
  });

  /**
   * The document's own footer says Samstag, Sonntag, Feiertag and Weihnachten are
   * surcharge kinds of the same hours and must not be added. A totals row would
   * state a figure the document explicitly refuses to state.
   */
  it('states no totals row, because the columns must not be added', () => {
    const plan = simplePlan();
    const section = builder.preview({ plan, generatedAt: STAMP }).sections[0];
    expect(section.totals).toBeUndefined();
    expect(builder.preview({ plan, generatedAt: STAMP }).footnotes?.[0])
      .toContain('dürfen nicht addiert werden');
  });

  /**
   * Criterion 22 — the documents' figures come from one plan. The two documents
   * have *different columns* (the form's Grundlohn is the whole worked day,
   * Lohnart 1000 is 06:00–20:00), so the figure that must agree is the one both
   * state: the total hours.
   */
  it('agrees with the Stundennachweis about a driver\'s total hours', () => {
    const plan = project(
      [
        trip({ id: 't1', startAt: '2026-10-05T22:00:00+02:00', endAt: '2026-10-06T02:00:00+02:00' }),
        trip({ id: 't2', startAt: '2026-10-11T09:00:00+02:00', endAt: '2026-10-11T17:00:00+02:00' }),
      ],
      [driver({ id: 'd1', name: 'Anna Beispiel', maxSalary: 9000 })],
    );

    const sheet = directStundennachweis(plan);
    const section = builder.preview({ plan, generatedAt: STAMP }).sections[0];
    const at = PAYROLL_SUMMARY_COLUMNS.findIndex(c => c.label === 'Std. Gesamt');
    expect(at).toBeGreaterThan(0);

    // The Stundennachweis's Grundlohn total is the driver's worked minutes for
    // the month; the summary's "Std. Gesamt" is the same span in hours. Both
    // reach it through `computeLohnartSeconds` over the same stored blocks.
    const expected = (sheet.totals.grundlohn / 60).toFixed(2).replace('.', ',');
    expect(section.rows[0].cells[at]).toBe(expected);
  });
});

// ── 4. §10 — the Fahrtenbuch adapter ────────────────────────────────────────

/** A sheet as `load` would return one, built from the plan's own rides. */
function fahrtenbuchSheet(plan: StoredMonthlyPlan): PlannedFahrtenbuchSheet {
  const tripIds = plan.blocks.flatMap(b => b.trips.map(t => t.trip_id));
  return buildPlannedFahrtenbuch({
    headers: ['Datum der Fahrt', 'Fahrername', 'Kennzeichen'],
    trips: tripIds.map((id, i) => ({
      id,
      is_canceled: false,
      original_driver_name: 'Importierter Fahrer',
      raw_data_json: {
        'Datum der Fahrt': '05.10.2026',
        Fahrername: 'Importierter Fahrer',
        Kennzeichen: 'B-AA-1',
      },
      source_row_index: i,
      trip_date: '2026-10-05',
      start_time: '08:23:00',
    })),
    blocks: plan.blocks.map((b, i) => ({
      id: `block-${i}`,
      block_key: b.block_key,
      driver_id: b.driver_id,
      driver_name: b.driver_name,
    })),
    blockTrips: plan.blocks.flatMap((b, i) =>
      b.trips.map(t => ({ block_id: `block-${i}`, trip_id: t.trip_id })),
    ),
    meta: {
      year: plan.year,
      month: plan.month,
      planStatus: plan.status,
      switchMinutes: plan.switch_minutes,
      generation: plan.generation,
      sourceFileName: 'Fahrtenbuch_Oktober.xlsx',
      sourceSheetName: 'Tabelle1',
      generatedAt: STAMP,
    },
  });
}

describe('the planned Fahrtenbuch adapter', () => {
  const builder = MONTHLY_PLAN_DOCUMENT_BUILDERS.fahrtenbuch!;

  it('renders the sheet\'s own cells, in the import\'s own column order', () => {
    const plan = simplePlan();
    const sheet = fahrtenbuchSheet(plan);
    const section = builder.preview({ plan, generatedAt: STAMP }, sheet).sections[0];

    expect(section.columns.map(c => c.header)).toEqual(sheet.headers);
    expect(section.rows.map(r => r.id)).toEqual(sheet.rows.map(r => r.tripId));
    expect(section.rows.map(r => r.cells)).toEqual(
      sheet.rows.map(r => r.cells.map(c => (c === null || c === '' ? null : String(c)))),
    );
  });

  it('overlays the planned driver and leaves every other column alone', () => {
    const plan = simplePlan();
    const sheet = fahrtenbuchSheet(plan);
    const section = builder.preview({ plan, generatedAt: STAMP }, sheet).sections[0];

    const driverAt = sheet.headers.indexOf('Fahrername');
    expect(section.rows[0].cells[driverAt]).toBe('Anna Beispiel');
    expect(section.rows[0].cells[sheet.headers.indexOf('Kennzeichen')]).toBe('B-AA-1');
    expect(section.rows[0].cells[sheet.headers.indexOf('Datum der Fahrt')]).toBe('05.10.2026');
  });

  it('names how many rows carry a planned driver, so the overlay is not taken on trust', () => {
    const plan = simplePlan();
    const sheet = fahrtenbuchSheet(plan);
    const preview = builder.preview({ plan, generatedAt: STAMP }, sheet);
    expect(preview.footnotes?.[0]).toContain(`${sheet.completeness.plannedRows} von`);
  });

  /**
   * The state the screen is in while the read is in flight. Throwing is what the
   * screen turns into a named refusal and what withholds the download button; an
   * empty table would be a claim that the month had no rides.
   */
  it('refuses to draw anything before its data is loaded', () => {
    const plan = simplePlan();
    expect(() => builder.preview({ plan, generatedAt: STAMP }, undefined))
      .toThrow(/geladen/);
  });

  it('refuses a plan that was never saved, because the import\'s rows hang off its id', async () => {
    const plan = { ...simplePlan(), id: null };
    await expect(builder.load!({ plan, generatedAt: STAMP })).rejects.toThrow(/gespeichert/);
  });
});
