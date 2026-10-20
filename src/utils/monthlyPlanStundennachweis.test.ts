/**
 * The §11 Stundennachweis builder.
 *
 * ## What this pins, and what it would have caught
 *
 * The first test is the one the module exists for. `compressToThree` closes the
 * gap between two periods so a day with more than three shifts fits three column
 * pairs, and `MonatsplanungStundennachweisPreview` then **recomputes the
 * minutes and the night buckets off those compressed windows** — so the gap
 * between two shifts is paid, and CLAUDE.md's rule that compression "must not
 * alter stored minutes, premium buckets, or Brutto figures" is broken for the
 * 92.5% of driver-days that are compressed. `buildCompressedDay` below is a day
 * of five periods whose compressed spans total 390 minutes against 255 worked,
 * and whose compressed night window holds 60 minutes of Nachtarbeit against 45
 * real. A builder that read the compressed windows would print 6,50 and 1,00
 * where this one prints 4,25 and 0,75, and both assertions fail.
 *
 * The rest pins the decisions the module had to make and a reviewer must be able
 * to see: that a period outside the planned month is reported rather than
 * dropped, that Feiertag beats Sonntag in the column while the cumulated figure
 * is kept, that the night boundary is the clean engine's 20:00, that a shift
 * across midnight becomes two rows, that DST is measured in real elapsed time,
 * and that a failed read withholds the document instead of printing zeros.
 *
 * Timezone: `vitest.config.ts` pins `TZ=Europe/Berlin`. Every instant below is
 * built from a local `Date`, which is the zone the payroll rules walk.
 */
import { describe, it, expect } from 'vitest';
import {
  buildMonthlyPlanStundennachweise,
  formatPlanHours,
  monthlyPlanStundennachweisFilename,
  planningNoticeLine,
  PLAN_STUNDENNACHWEIS_COLUMNS,
  PLANNING_NOTICE,
  type StoredMonthlyPlan,
  type StoredPlanBlock,
  type StoredPlanDriver,
} from './monthlyPlanStundennachweis';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const GENERATED_AT = new Date(2026, 3, 20, 9, 30, 0, 0); // 20.04.2026

/** A local wall-clock instant, the way the imported ride log reads. */
const at = (y: number, m: number, d: number, hh: number, mm = 0) =>
  new Date(y, m - 1, d, hh, mm, 0, 0);

const DRIVER: StoredPlanDriver = {
  driverId: 'drv-1',
  driverName: 'Anna Beispiel',
  isOwner: false,
  selected: true,
};

let blockCounter = 0;

/**
 * One `monthly_plan_blocks` row. `spanMinutes` is derived from the instants so a
 * fixture cannot accidentally test the disagreement path; `rideMinutes` is
 * deliberately smaller, because a block's idle time is the point of rule 3.
 */
function block(
  start: Date,
  end: Date,
  overrides: Partial<StoredPlanBlock> = {},
): StoredPlanBlock {
  const span = Math.round((end.getTime() - start.getTime()) / 60_000);
  blockCounter += 1;
  return {
    blockKey: `car-1|${start.getTime()}|${blockCounter}`,
    carId: 'car-1',
    carIdentifier: 'B-EP 1234',
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    spanMinutes: span,
    rideMinutes: Math.max(0, span - 10),
    driverId: DRIVER.driverId,
    driverName: DRIVER.driverName,
    ...overrides,
  };
}

function plan(blocks: StoredPlanBlock[], over: Partial<StoredMonthlyPlan> = {}): StoredMonthlyPlan {
  return {
    year: 2026,
    month: 5,
    status: 'confirmed',
    simulated: false,
    drivers: [DRIVER],
    blocks,
    ...over,
  };
}

const build = (p: StoredMonthlyPlan) =>
  buildMonthlyPlanStundennachweise(p, { generatedAt: GENERATED_AT });

/** Minutes back out of a printed decimal cell, so a row and its total can be compared. */
function minutesFromCell(cell: string): number {
  if (!cell) return 0;
  return Math.round(Number(cell.replace(',', '.')) * 60);
}

const dayOf = (set: ReturnType<typeof build>, dateKey: string) => {
  const day = set.drivers[0].days.find(d => d.dateKey === dateKey);
  if (!day) throw new Error(`no day ${dateKey}`);
  return day;
};

const rowOf = (set: ReturnType<typeof build>, dateKey: string) => {
  const index = set.drivers[0].days.findIndex(d => d.dateKey === dateKey);
  return set.drivers[0].exportData.rows[index];
};

// ── 1. Compression is display-only ───────────────────────────────────────────

/**
 * Monday 4 May 2026, five periods:
 *   06:00–07:00, 09:00–10:00, 12:00–13:00  →  180 min, all base
 *   19:30–20:00                            →   30 min, all base (night starts 20:00)
 *   20:15–21:00                            →   45 min, all Nachtarbeit
 * Worked: 255 min (4,25 h). Nachtarbeit: 45 min (0,75 h).
 *
 * Compression merges the 15-minute gap first, then the 120-minute one:
 *   06:00–10:00, 12:00–13:00, 19:30–21:00  →  390 min of span, 60 min inside 20:00–24:00.
 */
const buildCompressedDay = () => build(plan([
  block(at(2026, 5, 4, 6), at(2026, 5, 4, 7)),
  block(at(2026, 5, 4, 9), at(2026, 5, 4, 10)),
  block(at(2026, 5, 4, 12), at(2026, 5, 4, 13)),
  block(at(2026, 5, 4, 19, 30), at(2026, 5, 4, 20)),
  block(at(2026, 5, 4, 20, 15), at(2026, 5, 4, 21)),
]));

describe('compression merges for display and changes no figure', () => {
  it('pays the five real periods, not the three compressed spans', () => {
    const day = dayOf(buildCompressedDay(), '2026-05-04');
    expect(day.shifts).toHaveLength(5);
    expect(day.workedMinutes).toBe(255);
    // The compressed spans total 390. Reading minutes off them is the defect.
    expect(day.displayShifts.reduce((s, d) => s + d.minutes, 0)).toBe(390);
  });

  it('takes the night buckets from the real periods, not the compressed window', () => {
    const day = dayOf(buildCompressedDay(), '2026-05-04');
    // 20:15–21:00 is 45 minutes of Nachtarbeit. The compressed 19:30–21:00
    // window would give 60.
    expect(day.nachtarbeitMinutes).toBe(45);
    expect(day.nacht0bis4Minutes).toBe(0);
  });

  it('prints three pairs and a marker naming the real count', () => {
    const row = rowOf(buildCompressedDay(), '2026-05-04');
    expect([row.von1, row.bis1, row.von2, row.bis2, row.von3, row.bis3])
      .toEqual(['06:00', '10:00', '12:00', '13:00', '19:30', '21:00']);
    expect(row.marker).toBe('(5)');
    expect(row.grundlohn).toBe('4,25');
    expect(row.nachtarbeit).toBe('0,75');
  });

  it('notes the merge on the sheet, naming the day and the real count', () => {
    const notes = buildCompressedDay().drivers[0].exportData.notes ?? [];
    const merged = notes.filter(n => n.note_type === 'Zusammengefasste Schichten');
    expect(merged).toHaveLength(1);
    expect(merged[0].note_date).toBe('2026-05-04');
    expect(merged[0].note_text).toContain('5 Zeiträume');
  });

  it('accounts for every real period in the displayed pairs', () => {
    const day = dayOf(buildCompressedDay(), '2026-05-04');
    expect(day.displayShifts).toHaveLength(3);
    expect(day.displayShifts.reduce((s, d) => s + d.mergedFrom, 0)).toBe(day.shifts.length);
  });

  it('leaves a day of three or fewer periods uncompressed and unmarked', () => {
    const set = build(plan([
      block(at(2026, 5, 5, 8), at(2026, 5, 5, 10)),
      block(at(2026, 5, 5, 14), at(2026, 5, 5, 15)),
    ]));
    const day = dayOf(set, '2026-05-05');
    expect(day.compressed).toBe(false);
    expect(day.workedMinutes).toBe(180);
    expect(rowOf(set, '2026-05-05').marker).toBe('');
  });
});

// ── 2. A gap inside a block is paid ──────────────────────────────────────────

describe('the paid window is the block span, and ride minutes are reported beside it', () => {
  it('pays the whole block although its rides are shorter', () => {
    const set = build(plan([
      { ...block(at(2026, 5, 6, 8), at(2026, 5, 6, 12)), rideMinutes: 100 },
    ]));
    expect(dayOf(set, '2026-05-06').workedMinutes).toBe(240);
    expect(set.drivers[0].planBlockMinutes).toBe(240);
    expect(set.drivers[0].planRideMinutes).toBe(100);
  });
});

// ── 3. Midnight, DST and the month's edge ────────────────────────────────────

describe('a shift across midnight becomes two rows and loses no minute', () => {
  const set = build(plan([block(at(2026, 5, 20, 22), at(2026, 5, 21, 2))]));

  it('splits at local midnight and labels the first part 24:00', () => {
    const first = dayOf(set, '2026-05-20');
    const second = dayOf(set, '2026-05-21');
    expect(first.workedMinutes).toBe(120);
    expect(second.workedMinutes).toBe(120);
    expect(first.shifts[0].startLabel).toBe('22:00');
    expect(first.shifts[0].endLabel).toBe('24:00');
    expect(second.shifts[0].startLabel).toBe('00:00');
    expect(second.shifts[0].endLabel).toBe('02:00');
  });

  it('splits the premium buckets with it — 22:00–24:00 is 25%, 00:00–02:00 is 40%', () => {
    expect(dayOf(set, '2026-05-20').nachtarbeitMinutes).toBe(120);
    expect(dayOf(set, '2026-05-20').nacht0bis4Minutes).toBe(0);
    expect(dayOf(set, '2026-05-21').nachtarbeitMinutes).toBe(0);
    expect(dayOf(set, '2026-05-21').nacht0bis4Minutes).toBe(120);
  });
});

describe('a period after the planned month is reported, never dropped', () => {
  // 31 May 2026 is a Sunday; the shift runs into Monday 1 June, outside the month.
  const set = build(plan([block(at(2026, 5, 31, 22), at(2026, 6, 1, 2))]));

  it('counts only the in-month part in the totals', () => {
    expect(dayOf(set, '2026-05-31').workedMinutes).toBe(120);
    expect(set.drivers[0].totals.grundlohn).toBe(120);
  });

  it('names the out-of-month part, with its minutes', () => {
    expect(set.drivers[0].carryOver).toEqual([
      { dateKey: '2026-06-01', startLabel: '00:00', endLabel: '02:00', minutes: 120 },
    ]);
    const problems = set.drivers[0].problems.filter(p => p.kind === 'period_outside_month');
    expect(problems).toHaveLength(1);
    expect(problems[0].blocking).toBe(false);
    expect(problems[0].detail).toContain('01.06.2026');
  });

  it('prints it on the sheet as a note, so the paper says so too', () => {
    const notes = set.drivers[0].exportData.notes ?? [];
    const carry = notes.filter(n => n.note_type === 'Außerhalb des Planmonats');
    expect(carry).toHaveLength(1);
    expect(carry[0].note_date).toBe('2026-06-01');
    expect(carry[0].note_text).toContain('120 Min.');
  });

  it('still exports — a carry-over is a statement, not a broken figure', () => {
    expect(set.drivers[0].exportable).toBe(true);
  });
});

describe('DST is measured in elapsed time, not in clock faces', () => {
  // 29 March 2026 is the spring-forward Sunday in Europe/Berlin: 02:00 becomes
  // 03:00, so 01:00 to 04:00 on the clock is two hours of work.
  const set = buildMonthlyPlanStundennachweise(
    plan([block(at(2026, 3, 29, 1), at(2026, 3, 29, 4))], { month: 3 }),
    { generatedAt: GENERATED_AT },
  );

  it('pays the two hours actually elapsed', () => {
    const day = dayOf(set, '2026-03-29');
    expect(day.workedMinutes).toBe(120);
    expect(rowOf(set, '2026-03-29').grundlohn).toBe('2,00');
  });

  it('classifies the elapsed time, all of it inside 00:00–04:00', () => {
    const day = dayOf(set, '2026-03-29');
    expect(day.nacht0bis4Minutes).toBe(120);
    expect(day.nachtarbeitMinutes).toBe(0);
    expect(day.isSunday).toBe(true);
    expect(day.sonntagMinutes).toBe(120);
  });
});

// ── 4. Sonntag, Feiertag and the two holiday tables ──────────────────────────

describe('the Sonntag column yields to Feiertag, and nothing is hidden', () => {
  it('pays Sonntag on an ordinary Sunday', () => {
    const set = build(plan([block(at(2026, 5, 10, 10), at(2026, 5, 10, 14))]));
    const day = dayOf(set, '2026-05-10');
    expect(day.isSunday).toBe(true);
    expect(day.isHoliday).toBe(false);
    expect(day.sonntagMinutes).toBe(240);
    expect(day.feiertagMinutes).toBe(0);
  });

  it('shows Feiertag and 0 Sonntag on a holiday Sunday, keeping the cumulated figure', () => {
    // Ostersonntag 2026 is 5 April. The clean engine's table counts it as a
    // national holiday — it is statutory nowhere in Germany but Brandenburg —
    // and cumulates Sonntag with Feiertag (FINDINGS.md H19). The column rule
    // below is the one all three existing builders use; the raw figure is kept
    // beside it rather than thrown away.
    const set = buildMonthlyPlanStundennachweise(
      plan([block(at(2026, 4, 5, 10), at(2026, 4, 5, 14))], { month: 4 }),
      { generatedAt: GENERATED_AT },
    );
    const day = dayOf(set, '2026-04-05');
    expect(day.isSunday).toBe(true);
    expect(day.isHoliday).toBe(true);
    expect(day.feiertagMinutes).toBe(240);
    expect(day.sonntagMinutes).toBe(0);
    expect(day.sonntagMinutesCumulated).toBe(240);
  });

  it('fills the Weihnachten/1.-Mai column on 1 May, beside Feiertag', () => {
    const set = build(plan([block(at(2026, 5, 1, 8), at(2026, 5, 1, 16))]));
    const day = dayOf(set, '2026-05-01');
    expect(day.isHoliday).toBe(true);
    expect(day.feiertagMinutes).toBe(480);
    expect(day.weihnachtenMinutes).toBe(480);
    expect(day.isSunday).toBe(false);
  });

  it('counts Christi Himmelfahrt and Pfingstmontag as Feiertag', () => {
    const set = build(plan([
      block(at(2026, 5, 14, 9), at(2026, 5, 14, 11)),
      block(at(2026, 5, 25, 9), at(2026, 5, 25, 11)),
    ]));
    expect(dayOf(set, '2026-05-14').feiertagMinutes).toBe(120);
    expect(dayOf(set, '2026-05-25').feiertagMinutes).toBe(120);
  });
});

describe('the night boundary is the clean engine\'s 20:00, not the monthly pipeline\'s 23:00', () => {
  it('reads 19:00–23:00 as three hours of Nachtarbeit', () => {
    // `computeNightBuckets` in MonatsplanungStundennachweisPreview counts
    // 23:00–24:00 only and would answer 0 here. §3b EStG names 20:00; neither
    // implementation has been checked against the statute, so this pins the
    // choice rather than claiming it is the right one.
    const day = dayOf(build(plan([block(at(2026, 5, 6, 19), at(2026, 5, 6, 23))])), '2026-05-06');
    expect(day.workedMinutes).toBe(240);
    expect(day.nachtarbeitMinutes).toBe(180);
    expect(day.nacht0bis4Minutes).toBe(0);
  });

  it('never lets Lohnart 1500 and 1501 overlap', () => {
    const set = build(plan([
      block(at(2026, 5, 4, 3), at(2026, 5, 4, 7)),
      block(at(2026, 5, 7, 18), at(2026, 5, 8, 5)),
      block(at(2026, 5, 10, 12), at(2026, 5, 10, 13)),
      block(at(2026, 5, 31, 22), at(2026, 6, 1, 2)),
    ]));
    for (const driver of set.drivers) {
      for (const day of driver.days) {
        expect(day.nachtarbeitMinutes + day.nacht0bis4Minutes)
          .toBeLessThanOrEqual(day.workedMinutes);
      }
    }
  });
});

// ── 5. The sheet's own arithmetic ────────────────────────────────────────────

describe('the printed rows add up to the printed total', () => {
  const set = build(plan([
    block(at(2026, 5, 1, 8), at(2026, 5, 1, 16)),
    block(at(2026, 5, 4, 6), at(2026, 5, 4, 7)),
    block(at(2026, 5, 4, 9), at(2026, 5, 4, 10)),
    block(at(2026, 5, 4, 12), at(2026, 5, 4, 13)),
    block(at(2026, 5, 4, 19, 30), at(2026, 5, 4, 20)),
    block(at(2026, 5, 4, 20, 15), at(2026, 5, 4, 21)),
    block(at(2026, 5, 10, 10), at(2026, 5, 10, 14)),
    block(at(2026, 5, 20, 22), at(2026, 5, 21, 2)),
  ]));

  it('has one row per calendar day of the planned month', () => {
    expect(set.drivers[0].days).toHaveLength(31);
    expect(set.drivers[0].exportData.rows).toHaveLength(31);
    expect(set.drivers[0].days[0].dateKey).toBe('2026-05-01');
    expect(set.drivers[0].days[30].dateKey).toBe('2026-05-31');
  });

  it('sums each column out of the cells it printed', () => {
    const rows = set.drivers[0].exportData.rows;
    const summed = (key: 'grundlohn' | 'nachtarbeit' | 'nachtarbeit04' | 'sonntag' | 'feiertag' | 'weihnachten') =>
      rows.reduce((s, r) => s + minutesFromCell(r[key]), 0);
    expect(summed('grundlohn')).toBe(set.drivers[0].totals.grundlohn);
    expect(summed('nachtarbeit')).toBe(set.drivers[0].totals.nachtarbeit);
    expect(summed('nachtarbeit04')).toBe(set.drivers[0].totals.nacht04);
    expect(summed('sonntag')).toBe(set.drivers[0].totals.sonntag);
    expect(summed('feiertag')).toBe(set.drivers[0].totals.feiertag);
    expect(summed('weihnachten')).toBe(set.drivers[0].totals.weihnachten);
  });

  it('hands the renderer the totals in minutes, as PdfTotals is', () => {
    expect(set.drivers[0].exportData.totals.grundlohn).toBe(set.drivers[0].totals.grundlohn);
  });

  it('is deterministic', () => {
    expect(build(plan([
      block(at(2026, 5, 4, 6), at(2026, 5, 4, 7)),
      block(at(2026, 5, 10, 10), at(2026, 5, 10, 14)),
    ]))).toEqual(build(plan([
      block(at(2026, 5, 4, 6), at(2026, 5, 4, 7)),
      block(at(2026, 5, 10, 10), at(2026, 5, 10, 14)),
    ])));
  });
});

// ── 6. Every output says it is a proposal ────────────────────────────────────

describe('a proposal, not a record', () => {
  const set = build(plan([block(at(2026, 5, 6, 8), at(2026, 5, 6, 12))]));

  it('carries the notice line, with the generation date', () => {
    expect(set.noticeLine).toBe(`${PLANNING_NOTICE} · Erstellt am 20.04.2026`);
    expect(set.drivers[0].exportData.planningNotice).toBe(set.noticeLine);
    expect(planningNoticeLine(new Date(2026, 11, 31))).toContain('31.12.2026');
  });

  it('carries _PLANUNG_ in the filename', () => {
    expect(set.drivers[0].filename).toBe('Stundennachweis_PLANUNG_Anna_Beispiel_Mai_2026');
    expect(monthlyPlanStundennachweisFilename('Bo Tester', 1, 2027))
      .toBe('Stundennachweis_PLANUNG_Bo_Tester_Januar_2027');
  });

  it('never marks the sheet historical, which would change its wording', () => {
    expect(set.drivers[0].exportData.isHistorical).toBeUndefined();
  });
});

// ── 7. Nothing is shown that cannot be trusted ───────────────────────────────

describe('a figure whose load failed is neither shown nor exported', () => {
  it('withholds the whole set when the caller says the read was short', () => {
    const set = buildMonthlyPlanStundennachweise(
      plan([block(at(2026, 5, 6, 8), at(2026, 5, 6, 12))]),
      { generatedAt: GENERATED_AT, dataComplete: false },
    );
    expect(set.withheld).toBe(true);
    expect(set.drivers).toEqual([]);
    expect(set.problems[0].kind).toBe('source_incomplete');
    expect(set.problems[0].blocking).toBe(true);
  });

  it('withholds one driver whose block has unusable times', () => {
    const set = build(plan([
      block(at(2026, 5, 6, 8), at(2026, 5, 6, 12)),
      { ...block(at(2026, 5, 7, 8), at(2026, 5, 7, 12)), startsAt: 'kein Datum' },
    ]));
    expect(set.drivers[0].exportable).toBe(false);
    expect(set.drivers[0].problems.some(p => p.kind === 'block_ends_before_start' && p.blocking))
      .toBe(true);
    // The usable block is still measured, so the figure is not silently zero.
    expect(dayOf(set, '2026-05-06').workedMinutes).toBe(240);
  });
});

// ── 8. Nothing is silently dropped ───────────────────────────────────────────

describe('what belongs to nobody is reported', () => {
  it('reports an unassigned block and gives it to no document', () => {
    const set = build(plan([
      block(at(2026, 5, 6, 8), at(2026, 5, 6, 12)),
      { ...block(at(2026, 5, 6, 14), at(2026, 5, 6, 18)), driverId: null, driverName: null },
    ]));
    expect(set.unassignedBlockCount).toBe(1);
    expect(set.unassignedBlockMinutes).toBe(240);
    expect(set.problems.some(p => p.kind === 'block_without_driver')).toBe(true);
    expect(set.drivers).toHaveLength(1);
    expect(set.drivers[0].totals.grundlohn).toBe(240);
  });

  it('builds a sheet for a block naming a driver the snapshot does not hold', () => {
    const set = build(plan([
      { ...block(at(2026, 5, 6, 8), at(2026, 5, 6, 12)), driverId: 'drv-9', driverName: 'Carl Fremd' },
    ]));
    const carl = set.drivers.find(d => d.driverId === 'drv-9');
    expect(carl?.driverName).toBe('Carl Fremd');
    expect(carl?.totals.grundlohn).toBe(240);
    expect(carl?.problems.some(p => p.kind === 'driver_not_in_snapshot')).toBe(true);
    // Non-blocking: the block carries its own name, so no minute is lost.
    expect(carl?.exportable).toBe(true);
  });

  it('gives a selected driver with no block an empty sheet rather than no sheet', () => {
    const set = build(plan([]));
    expect(set.drivers).toHaveLength(1);
    expect(set.drivers[0].days).toHaveLength(31);
    expect(set.drivers[0].totals.grundlohn).toBe(0);
    expect(set.drivers[0].exportData.rows.every(r => r.grundlohn === '')).toBe(true);
  });

  it('reports a stored span that disagrees with the instants, and keeps the instants', () => {
    const set = build(plan([
      { ...block(at(2026, 5, 6, 8), at(2026, 5, 6, 12)), spanMinutes: 300 },
    ]));
    const problem = set.drivers[0].problems.find(p => p.kind === 'block_minutes_disagree');
    expect(problem?.blocking).toBe(false);
    expect(problem?.detail).toContain('300');
    expect(dayOf(set, '2026-05-06').workedMinutes).toBe(240);
    // The plan's own figure is still reported, unrepaired.
    expect(set.drivers[0].planBlockMinutes).toBe(300);
  });

  it('counts two overlapping blocks of one driver once', () => {
    // §7 rule 2 forbids this, and a broken plan could still hold it. Merging
    // before measuring is what stops the minutes being paid twice.
    const set = build(plan([
      block(at(2026, 5, 6, 8), at(2026, 5, 6, 12)),
      block(at(2026, 5, 6, 10), at(2026, 5, 6, 13)),
    ]));
    expect(dayOf(set, '2026-05-06').workedMinutes).toBe(300);
    expect(dayOf(set, '2026-05-06').shifts).toHaveLength(1);
  });
});

// ── 9. The preview draws the same sheet ──────────────────────────────────────

describe('the preview reads the same cells the PDF prints', () => {
  it('names the six duration columns by the keys the rows carry', () => {
    const set = build(plan([block(at(2026, 5, 4, 19), at(2026, 5, 4, 23))]));
    const row = rowOf(set, '2026-05-04');
    // A screen drawing `row[col.key]` gets exactly the printed cell, so the
    // preview and the paper cannot disagree about a figure.
    expect(PLAN_STUNDENNACHWEIS_COLUMNS.map(c => row[c.key]))
      .toEqual(['4,00', '3,00', '', '', '', '']);
  });

  it('formats the totals row the way the cells are formatted', () => {
    expect(formatPlanHours(255)).toBe('4,25');
    expect(formatPlanHours(81)).toBe('1,35');
    expect(formatPlanHours(0)).toBe('');
  });
});

// ── 10. The driver snapshot is what the sheet reads ──────────────────────────

describe('the sheet reads the plan snapshot, not the live driver row', () => {
  it('uses the snapshot name, so a renamed driver does not re-label an old plan', () => {
    const set = build(plan(
      [{ ...block(at(2026, 5, 6, 8), at(2026, 5, 6, 12)), driverName: 'Anna Neu' }],
      { drivers: [{ ...DRIVER, driverName: 'Anna Beispiel' }] },
    ));
    expect(set.drivers[0].driverName).toBe('Anna Beispiel');
    expect(set.drivers[0].exportData.driver.name).toBe('Anna Beispiel');
  });

  it('leaves the Pers.-Nr. line off when the caller passes none', () => {
    const set = build(plan([block(at(2026, 5, 6, 8), at(2026, 5, 6, 12))]));
    expect(set.drivers[0].exportData.driver.personalnummer).toBeUndefined();
  });

  it('carries a Personalnummer the caller does pass', () => {
    const set = build(plan(
      [block(at(2026, 5, 6, 8), at(2026, 5, 6, 12))],
      { drivers: [{ ...DRIVER, personalnummer: '0815' }] },
    ));
    expect(set.drivers[0].exportData.driver.personalnummer).toBe('0815');
  });
});
