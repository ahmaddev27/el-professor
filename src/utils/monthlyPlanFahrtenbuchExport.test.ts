/**
 * §10 — the planned Fahrtenbuch, and the one property that makes it trustworthy.
 *
 * **THE RULE THESE PIN.** The document is built from the imported rows and
 * exactly one column may differ from the file that was uploaded: the Fahrername.
 * Every other cell — the times, the vehicle, the kilometres, the destinations,
 * the money — is `raw_data_json[header]` written through, with no arithmetic and
 * no reformatting anywhere in the module. The first describe below is that rule
 * as an assertion over every cell of every row, and it is the one to read first.
 *
 * **AND THE SECOND RULE: this plans a month that has not happened.** So the
 * sheet's first row is the PLANUNG banner, the headers are row 2, the filename
 * carries `_PLANUNG_`, and nothing is written anywhere. The banner row is not a
 * label but a guard: `FahrtenbuchImportModal` reads a workbook's first row as its
 * header set, so with the banner there the file cannot be re-imported and a
 * proposal cannot become stored trip data. A test that only checked "the banner
 * exists somewhere" would pass for a banner on a separate tab, which does not
 * have that property — hence the row-index assertions.
 *
 * **What would have failed before.** Nothing existed to fail: this is a new
 * module. So each describe carries its negative control as a comment naming the
 * plausible wrong implementation it rules out — the driver read from
 * `fahrtenbuch_trips.assigned_driver_name` (the legacy pipeline's column, a
 * second source for the same figure); a truncated blocks read reported as
 * "unassigned"; `||` where `??` is needed for a switch duration of 0; a
 * `toLocaleString('de-DE')` date; a banner on a tab instead of in row 1; and the
 * number-format offset off by one now that a banner row precedes the headers.
 *
 * **Not verified here**: that these assertions pass. There is no `node_modules`
 * in the worktree this was written in, so the suite never ran. They are written
 * against the code as committed. `loadPlannedFahrtenbuch` is exercised through
 * its injected client; `downloadMonthlyPlanFahrtenbuch` and
 * `writePlannedFahrtenbuchWorkbook` are not, because they end in
 * `XLSX.writeFile`, which in this suite's `node` environment would write a real
 * file into the repository — which is exactly why the read and the workbook build
 * were split out of them, and both of those *are* covered.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  MonthlyPlanFahrtenbuchBlockedError,
  PLANUNG_BANNER,
  PLANUNG_SHEET_NAME,
  buildPlannedFahrtenbuch,
  buildPlannedFahrtenbuchWorkbook,
  distinctSheetName,
  formatPlanungPeriod,
  formatPlanungTimestamp,
  loadPlannedFahrtenbuch,
  planStatusLabel,
  type ImportedTripRowForExport,
  type MonthlyPlanExportClient,
  type PlanBlockRowForExport,
  type PlanBlockTripRowForExport,
  type PlannedFahrtenbuchInput,
  type PlannedFahrtenbuchMeta,
} from './monthlyPlanFahrtenbuchExport';

const MODULE_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'monthlyPlanFahrtenbuchExport.ts'),
  'utf8',
);

/**
 * The module with its comments removed, for the assertions about what the code
 * reads and writes.
 *
 * Needed because the module's header quotes `buildOriginalSheet` verbatim — the
 * rule it preserves — and that quotation names the legacy pipeline's driver
 * column. An assertion over the raw text would either fail on the quotation or
 * force the most valuable line of documentation out of the file.
 *
 * The stripper is deliberately naive: block comments, then whole lines whose
 * first non-space characters are a double slash. It is sound only while the
 * module has no trailing comment and no slash outside a comment, which the first
 * test below asserts as its premise — so the stripper cannot start lying quietly.
 */
const CODE_ONLY = MODULE_SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter(line => !line.trimStart().startsWith('//'))
  .join('\n');

/** A cell as an object, so `.v` and `.z` are reachable under `strict`. */
function cellOf(ws: XLSX.WorkSheet, address: string): XLSX.CellObject {
  return ws[address] as XLSX.CellObject;
}

// ── fixtures ───────────────────────────────────────────────────────────────

/** The real Uber export's columns, in the order the importer stores them. */
const HEADERS = [
  'Datum der Fahrt',
  'Uhrzeit des Fahrtbeginns',
  'Uhrzeit des Fahrtendes',
  'Kennzeichen',
  'Fahrername',
  'Fahrpreis',
  'Kilometer',
  'Zielort',
] as const;

const DRIVER_INDEX = HEADERS.indexOf('Fahrername');

const META: PlannedFahrtenbuchMeta = {
  year: 2026,
  month: 10,
  planStatus: 'confirmed',
  switchMinutes: 45,
  generation: 3,
  sourceFileName: 'fahrtenbuch_2026_10.xlsx',
  sourceSheetName: 'Fahrten Oktober',
  // A fixed instant, so nothing in this suite reads the clock.
  generatedAt: new Date(2026, 8, 5, 7, 4, 31),
};

function trip(over: Partial<ImportedTripRowForExport> & { id: string }): ImportedTripRowForExport {
  return {
    is_canceled: false,
    original_driver_name: 'Original Fahrer',
    raw_data_json: {
      'Datum der Fahrt': '01.10.2026',
      'Uhrzeit des Fahrtbeginns': '08:23:00',
      'Uhrzeit des Fahrtendes': '09:44:00',
      Kennzeichen: 'B-TX 1234',
      Fahrername: 'Original Fahrer',
      Fahrpreis: 12.94,
      Kilometer: 7.2,
      Zielort: 'Berlin Hauptbahnhof',
    },
    source_row_index: 1,
    trip_date: '2026-10-01',
    start_time: '08:23:00',
    ...over,
  };
}

function block(over: Partial<PlanBlockRowForExport> & { id: string }): PlanBlockRowForExport {
  return {
    block_key: `car-1|${over.id}`,
    driver_id: 'driver-1',
    driver_name: 'Geplanter Fahrer',
    ...over,
  };
}

function link(block_id: string, trip_id: string): PlanBlockTripRowForExport {
  return { block_id, trip_id };
}

function input(over: Partial<PlannedFahrtenbuchInput> = {}): PlannedFahrtenbuchInput {
  return {
    headers: [...HEADERS],
    trips: [trip({ id: 't1' })],
    blocks: [block({ id: 'b1' })],
    blockTrips: [link('b1', 't1')],
    meta: META,
    ...over,
  };
}

// ── 1. the rule: only the driver may differ ────────────────────────────────

describe('every cell but the Fahrername is the imported cell, verbatim', () => {
  /**
   * NEGATIVE CONTROL for this whole block: an implementation that built a row
   * from anything but `raw_data_json[header]` — a normalised date, a formatted
   * amount, a re-derived duration, a column taken from a `fahrtenbuch_trips`
   * column instead of the raw row. Each would move a cell here.
   */
  it('writes each header cell straight from raw_data_json', () => {
    const sheet = buildPlannedFahrtenbuch(input());
    const raw = sheet.rows[0];
    const source = trip({ id: 't1' }).raw_data_json!;

    HEADERS.forEach((header, index) => {
      if (index === DRIVER_INDEX) return;
      expect(raw.cells[index]).toBe(source[header]);
    });
  });

  it('keeps a money cell a bare number, not a formatted string', () => {
    const sheet = buildPlannedFahrtenbuch(input());
    expect(sheet.rows[0].cells[HEADERS.indexOf('Fahrpreis')]).toBe(12.94);
    expect(sheet.rows[0].cells[HEADERS.indexOf('Kilometer')]).toBe(7.2);
  });

  it('replaces exactly one cell, and it is the Fahrername', () => {
    const sheet = buildPlannedFahrtenbuch(input());
    const source = trip({ id: 't1' }).raw_data_json!;
    const differing = HEADERS.filter((header, index) => sheet.rows[0].cells[index] !== source[header]);
    expect(differing).toEqual(['Fahrername']);
    expect(sheet.rows[0].cells[DRIVER_INDEX]).toBe('Geplanter Fahrer');
  });

  it('writes null for an absent source cell, so no cell is emitted at all', () => {
    // `buildOriginalSheet`'s own choice. `''` would emit an empty string cell
    // where the source sheet had nothing.
    const sheet = buildPlannedFahrtenbuch(
      input({ trips: [trip({ id: 't1', raw_data_json: { Fahrername: 'Original Fahrer' } })] }),
    );
    expect(sheet.rows[0].cells[HEADERS.indexOf('Zielort')]).toBeNull();
  });

  it('emits one column per header, in the imported order', () => {
    const sheet = buildPlannedFahrtenbuch(input());
    expect(sheet.headers).toEqual([...HEADERS]);
    expect(sheet.rows[0].cells).toHaveLength(HEADERS.length);
    expect(sheet.sheetRows[1]).toEqual([...HEADERS]);
  });
});

// ── 2. the driver comes from the plan, and from the plan's own snapshot ─────

describe('the driver is the block’s, not the trip row’s', () => {
  it('takes the block’s stored driver_name even when the raw row names someone else', () => {
    // §13's snapshot rule: a renamed or deleted driver must not re-label a plan
    // that was already made, so the name written is the plan's copy.
    const sheet = buildPlannedFahrtenbuch(
      input({ blocks: [block({ id: 'b1', driver_name: 'Snapshot Name' })] }),
    );
    expect(sheet.rows[0].cells[DRIVER_INDEX]).toBe('Snapshot Name');
    expect(sheet.rows[0].driverSource).toBe('plan');
    expect(sheet.rows[0].originalDriverName).toBe('Original Fahrer');
  });

  it('the comment stripper\u2019s premise holds: no trailing comment, no stray slash', () => {
    // If this fails, CODE_ONLY is no longer the code and the two source
    // assertions that use it are vacuous. Fix the stripper, not this test.
    const offenders = MODULE_SOURCE.split('\n').filter(line => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
      return line.includes('//');
    });
    expect(offenders).toEqual([]);
  });

  it('no code path reads the legacy pipeline\u2019s driver column on the trip row', () => {
    // NEGATIVE CONTROL, and the reason it is a source assertion: that column is a
    // plausible place to read a driver from and would be a second source for one
    // figure. The row type this module takes has no such field, so a regression
    // would have to add it — and adding it fails here rather than in a document
    // nobody re-reads. Asserted over CODE_ONLY because the header quotes
    // `buildOriginalSheet`, which names it.
    expect(CODE_ONLY).not.toMatch(/assigned_driver/);
    expect(CODE_ONLY).not.toMatch(/assignment_planning_run_id/);
    // And the header still carries the quotation the rule is stated as.
    expect(MODULE_SOURCE).toContain('assigned_driver_name');
  });

  it('follows the block through the block_trips relation, not by vehicle or date', () => {
    const sheet = buildPlannedFahrtenbuch(
      input({
        trips: [trip({ id: 't1', source_row_index: 1 }), trip({ id: 't2', source_row_index: 2 })],
        blocks: [
          block({ id: 'b1', driver_name: 'Fahrer A' }),
          block({ id: 'b2', driver_name: 'Fahrer B' }),
        ],
        blockTrips: [link('b2', 't1'), link('b1', 't2')],
      }),
    );
    expect(sheet.rows.map(r => r.cells[DRIVER_INDEX])).toEqual(['Fahrer B', 'Fahrer A']);
    expect(sheet.rows.map(r => r.blockKey)).toEqual(['car-1|b2', 'car-1|b1']);
  });
});

// ── 3. the three states that keep the original driver ──────────────────────

describe('a cancelled ride is never reassigned and never counted', () => {
  it('leaves a cancelled row byte-identical to the import', () => {
    const source = trip({ id: 't1' }).raw_data_json!;
    const sheet = buildPlannedFahrtenbuch(
      input({ trips: [trip({ id: 't1', is_canceled: true })], blockTrips: [] }),
    );
    HEADERS.forEach((header, index) => expect(sheet.rows[0].cells[index]).toBe(source[header]));
    expect(sheet.rows[0].driverSource).toBe('original');
    expect(sheet.rows[0].keptOriginalReason).toBe('canceled');
    expect(sheet.completeness.canceledRows).toBe(1);
    expect(sheet.completeness.plannedRows).toBe(0);
  });

  it('leaves it alone even when a block contains it, and says so', () => {
    // `buildBlocks` filters cancelled rides, so a block holding one means a
    // mismatched plan and import. It is counted, not refused: refusing would let
    // one anomalous row withhold a whole month's document.
    const sheet = buildPlannedFahrtenbuch(
      input({ trips: [trip({ id: 't1', is_canceled: true })] }),
    );
    expect(sheet.rows[0].cells[DRIVER_INDEX]).toBe('Original Fahrer');
    expect(sheet.completeness.canceledInPlanRows).toBe(1);
    expect(sheet.completeness.complete).toBe(false);
    expect(sheet.metaRows.some(row => String(row[0]) === 'Warnung')).toBe(true);
  });
});

describe('a ride in no block, and a block §8 left unassigned', () => {
  it('keeps the original driver for a ride in no block and counts it', () => {
    const sheet = buildPlannedFahrtenbuch(input({ blockTrips: [] }));
    expect(sheet.rows[0].cells[DRIVER_INDEX]).toBe('Original Fahrer');
    expect(sheet.rows[0].keptOriginalReason).toBe('not_in_plan');
    expect(sheet.completeness.notInPlanRows).toBe(1);
    expect(sheet.completeness.complete).toBe(false);
  });

  it('keeps the original driver for a block with no driver and counts it', () => {
    const sheet = buildPlannedFahrtenbuch(
      input({ blocks: [block({ id: 'b1', driver_id: null, driver_name: null })] }),
    );
    expect(sheet.rows[0].cells[DRIVER_INDEX]).toBe('Original Fahrer');
    expect(sheet.rows[0].keptOriginalReason).toBe('block_unassigned');
    expect(sheet.completeness.unassignedBlockRows).toBe(1);
    expect(sheet.completeness.complete).toBe(false);
  });

  it('treats a blank driver_name as unassigned, not as an empty name to write', () => {
    const sheet = buildPlannedFahrtenbuch(
      input({ blocks: [block({ id: 'b1', driver_name: '   ' })] }),
    );
    expect(sheet.rows[0].cells[DRIVER_INDEX]).toBe('Original Fahrer');
    expect(sheet.completeness.unassignedBlockRows).toBe(1);
  });

  it('is complete when every non-cancelled ride carries a planned driver', () => {
    const sheet = buildPlannedFahrtenbuch(
      input({
        trips: [trip({ id: 't1' }), trip({ id: 't2', source_row_index: 2, is_canceled: true })],
        blockTrips: [link('b1', 't1')],
      }),
    );
    expect(sheet.completeness).toMatchObject({
      totalRows: 2,
      plannedRows: 1,
      keptOriginalRows: 1,
      canceledRows: 1,
      notInPlanRows: 0,
      unassignedBlockRows: 0,
      canceledInPlanRows: 0,
      complete: true,
    });
  });
});

// ── 4. the refusals ────────────────────────────────────────────────────────

function reasonOf(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(MonthlyPlanFahrtenbuchBlockedError);
    return (error as MonthlyPlanFahrtenbuchBlockedError).reason;
  }
  throw new Error('expected a refusal, none was thrown');
}

describe('a document that could not be trusted is refused, with a stable reason', () => {
  it('refuses an import with no rides', () => {
    expect(reasonOf(() => buildPlannedFahrtenbuch(input({ trips: [] })))).toBe('no_trips');
  });

  it('refuses headers it could not read', () => {
    expect(reasonOf(() => buildPlannedFahrtenbuch(input({ headers: [] })))).toBe('no_columns');
    expect(reasonOf(() => buildPlannedFahrtenbuch(input({ headers: ['', ''] })))).toBe('no_columns');
  });

  it('refuses a sheet with no Fahrername column, rather than shipping the import', () => {
    // Without that column nothing can be replaced, so the file would be the
    // uploaded sheet under a PLANUNG name — a document claiming to be a plan.
    const reason = reasonOf(() =>
      buildPlannedFahrtenbuch(input({ headers: ['Datum der Fahrt', 'Kennzeichen', 'Zielort'] })),
    );
    expect(reason).toBe('no_driver_column');
  });

  it('refuses a block reference that resolves to no block', () => {
    // THE ONE THAT MATTERS. A truncated blocks read looks exactly like "these
    // rides are unassigned": the rides would keep their original drivers, the
    // figures would all be plausible, and nothing would say the read failed.
    // NEGATIVE CONTROL: an implementation using `blocksById.get(id)` and simply
    // treating `undefined` as "no block" — which is the natural way to write it.
    const reason = reasonOf(() =>
      buildPlannedFahrtenbuch(input({ blocks: [], blockTrips: [link('b1', 't1')] })),
    );
    expect(reason).toBe('unknown_block');
  });

  it('refuses one ride in two blocks', () => {
    // §23: no ride is counted twice. Which driver won would be arbitrary.
    const reason = reasonOf(() =>
      buildPlannedFahrtenbuch(
        input({
          blocks: [block({ id: 'b1' }), block({ id: 'b2', driver_name: 'Andere' })],
          blockTrips: [link('b1', 't1'), link('b2', 't1')],
        }),
      ),
    );
    expect(reason).toBe('trip_in_two_blocks');
  });

  it('accepts the same block naming a ride twice — it is one block, not two', () => {
    const sheet = buildPlannedFahrtenbuch(
      input({ blockTrips: [link('b1', 't1'), link('b1', 't1')] }),
    );
    expect(sheet.rows[0].driverSource).toBe('plan');
  });

  it('every refusal carries a German sentence, because that sentence is rendered as-is', () => {
    try {
      buildPlannedFahrtenbuch(input({ trips: [] }));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toMatch(/Fahrten/);
      expect((error as Error).name).toBe('MonthlyPlanFahrtenbuchBlockedError');
    }
  });
});

// ── 5. it is a proposal, and the file says so before anything else ──────────

describe('the PLANUNG label, and why it is in row 1', () => {
  it('puts the banner in row 1 and the headers in row 2', () => {
    // NEGATIVE CONTROL: a banner on a separate tab, or in the filename only,
    // would pass a "the label exists" check and lose the property below.
    const sheet = buildPlannedFahrtenbuch(input());
    expect(sheet.sheetRows[0]).toEqual([sheet.banner]);
    expect(String(sheet.sheetRows[0][0]).startsWith(PLANUNG_BANNER)).toBe(true);
    expect(sheet.sheetRows[1]).toEqual([...HEADERS]);
  });

  it('makes row 1 unusable as a header set, so the file cannot be re-imported', () => {
    // This is the guard, not the decoration. `FahrtenbuchImportModal` reads a
    // workbook's first row as its headers; a proposal that imported cleanly
    // would become stored trip data for a month that has not happened.
    const sheet = buildPlannedFahrtenbuch(input());
    const firstRow = sheet.sheetRows[0].map(cell => String(cell ?? ''));
    expect(firstRow).not.toContain('Datum der Fahrt');
    expect(firstRow).not.toContain('Fahrername');
  });

  it('names the period and the generation time in the banner', () => {
    const sheet = buildPlannedFahrtenbuch(input());
    expect(sheet.banner).toContain('01.10.2026 – 31.10.2026');
    expect(sheet.banner).toContain('05.09.2026 07:04');
  });

  it('carries _PLANUNG_ in the filename and never reuses the import’s name', () => {
    const sheet = buildPlannedFahrtenbuch(input());
    expect(sheet.fileName).toBe('Fahrtenbuch_PLANUNG_2026-10.xlsx');
    expect(sheet.fileName).not.toContain('fahrtenbuch_2026_10');
  });

  it('writes nothing: the module has no insert, update, upsert, delete or rpc', () => {
    // The owner's decision, as a structural assertion. Nothing writes
    // `fahrtenbuch_trips`, and nothing writes `saved_stundennachweise` either —
    // that table is the statutory archive and a proposal in it would overwrite a
    // real record.
    for (const call of ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(']) {
      expect(CODE_ONLY).not.toContain(call);
    }
    expect(CODE_ONLY).not.toContain('saved_stundennachweise');
    expect(CODE_ONLY).not.toContain('fahrtenbuch_assignment_audit');
  });
});

// ── 6. the preview and the file are one array ──────────────────────────────

describe('the table and the sheet cannot disagree', () => {
  it('hands out the identical array for the row a table renders and the row the sheet writes', () => {
    // The whole reason this module exists as one builder: today's product has two
    // independent Stundennachweis builders and they disagree. `toBe`, not
    // `toEqual` — identity, so a later change cannot fork them into two arrays
    // that merely start out equal.
    const sheet = buildPlannedFahrtenbuch(
      input({
        trips: [trip({ id: 't1' }), trip({ id: 't2', source_row_index: 2 })],
        blockTrips: [link('b1', 't1'), link('b1', 't2')],
      }),
    );
    sheet.rows.forEach((row, index) => {
      expect(sheet.sheetRows[index + 2]).toBe(row.cells);
    });
    expect(sheet.sheetRows).toHaveLength(sheet.rows.length + 2);
  });

  it('exposes the provenance a preview needs, per row', () => {
    const sheet = buildPlannedFahrtenbuch(
      input({
        trips: [trip({ id: 't1' }), trip({ id: 't2', source_row_index: 2, is_canceled: true })],
        blockTrips: [link('b1', 't1')],
      }),
    );
    expect(sheet.rows.map(r => [r.tripId, r.driverName, r.driverSource, r.keptOriginalReason])).toEqual([
      ['t1', 'Geplanter Fahrer', 'plan', null],
      ['t2', 'Original Fahrer', 'original', 'canceled'],
    ]);
  });
});

// ── 7. the row order is the file's own, and it is decided here ─────────────

describe('row order', () => {
  it('orders by source_row_index, then day, then start, then id', () => {
    const sheet = buildPlannedFahrtenbuch(
      input({
        trips: [
          trip({ id: 'c', source_row_index: 3 }),
          trip({ id: 'a', source_row_index: 1 }),
          trip({ id: 'b', source_row_index: 2 }),
        ],
        blockTrips: [],
      }),
    );
    expect(sheet.rows.map(r => r.tripId)).toEqual(['a', 'b', 'c']);
  });

  it('sorts a row without a source index after every row that has one', () => {
    const sheet = buildPlannedFahrtenbuch(
      input({
        trips: [
          trip({ id: 'z', source_row_index: null, trip_date: '2026-10-01' }),
          trip({ id: 'a', source_row_index: 9 }),
        ],
        blockTrips: [],
      }),
    );
    expect(sheet.rows.map(r => r.tripId)).toEqual(['a', 'z']);
  });

  it('breaks a tie by day, then start time, then id — a total order', () => {
    const sheet = buildPlannedFahrtenbuch(
      input({
        trips: [
          trip({ id: 'b2', source_row_index: null, trip_date: '2026-10-02', start_time: '10:00:00' }),
          trip({ id: 'b1', source_row_index: null, trip_date: '2026-10-02', start_time: '09:00:00' }),
          trip({ id: 'a2', source_row_index: null, trip_date: '2026-10-01', start_time: '09:00:00' }),
          trip({ id: 'a1', source_row_index: null, trip_date: '2026-10-01', start_time: '09:00:00' }),
        ],
        blockTrips: [],
      }),
    );
    expect(sheet.rows.map(r => r.tripId)).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('does not mutate the array it was given', () => {
    const trips = [trip({ id: 'b', source_row_index: 2 }), trip({ id: 'a', source_row_index: 1 })];
    buildPlannedFahrtenbuch(input({ trips, blockTrips: [] }));
    expect(trips.map(t => t.id)).toEqual(['b', 'a']);
  });
});

// ── 8. the figures are in the file, not only in the return value ───────────

describe('the completeness report is part of the artefact', () => {
  /**
   * WHY: `exportAppliedRunXlsx` returns a validation and two of its three call
   * sites discard it, so a file with missing drivers is written with nobody told.
   * A caller that drops this module's result still ships a document that says so.
   */
  it('prints every count on the PLANUNG sheet', () => {
    const sheet = buildPlannedFahrtenbuch(
      input({
        trips: [
          trip({ id: 't1' }),
          trip({ id: 't2', source_row_index: 2, is_canceled: true }),
          trip({ id: 't3', source_row_index: 3 }),
        ],
        blockTrips: [link('b1', 't1')],
      }),
    );
    const labelled = new Map(sheet.metaRows.filter(r => r.length >= 2).map(r => [String(r[0]), r[1]] as const));
    expect(labelled.get('Zeilen insgesamt')).toBe(3);
    expect(labelled.get('Davon mit geplantem Fahrer')).toBe(1);
    expect(labelled.get('Davon mit Originalfahrer')).toBe(2);
    expect(labelled.get('  davon storniert (nie zugewiesen)')).toBe(1);
    expect(labelled.get('  davon keinem Block zugeordnet')).toBe(1);
    expect(labelled.get('  davon Block ohne Fahrer')).toBe(0);
    expect(String(labelled.get('Vollständigkeit'))).toContain(
      '1 nicht stornierte Fahrt(en) tragen weiterhin den Originalfahrer',
    );
  });

  it('names the plan it was made from, and 0 minutes is a value', () => {
    // NEGATIVE CONTROL: `meta.switchMinutes || 'nicht erfasst'` would print
    // "nicht erfasst" for 0, which `buildBlocks` defines as "split at every gap".
    const sheet = buildPlannedFahrtenbuch(
      input({ meta: { ...META, switchMinutes: 0, generation: 0 } }),
    );
    const labelled = new Map(sheet.metaRows.filter(r => r.length >= 2).map(r => [String(r[0]), r[1]] as const));
    expect(labelled.get('Wechseldauer (Minuten)')).toBe(0);
    expect(labelled.get('Variante (Neu generieren)')).toBe(0);
    expect(labelled.get('Quelldatei des Imports')).toBe('fahrtenbuch_2026_10.xlsx');
    expect(labelled.get('Status der Planung')).toBe('Bestätigt');
  });

  it('says which column it changed, and that the Fahrtenbuch itself was not touched', () => {
    const sheet = buildPlannedFahrtenbuch(input());
    const note = String(sheet.metaRows.find(r => String(r[0]) === 'Hinweis')?.[1] ?? '');
    expect(note).toContain('Fahrername');
    expect(note).toContain('unverändert');
    expect(note).toContain('nichts gespeichert');
  });

  it('opens the PLANUNG sheet with the banner too', () => {
    const sheet = buildPlannedFahrtenbuch(input());
    expect(sheet.metaRows[0]).toEqual([PLANUNG_BANNER]);
  });
});

// ── 9. the sheet names, which are a live crash ─────────────────────────────

describe('sheet names', () => {
  it('puts the customer’s tab label through safeSheetName', () => {
    // Not a second copy of the rule: this asserts the imported one is applied.
    // 38 characters with a forward slash and a backslash in them — three of
    // `check_ws_name`'s five refusals at once. The backslash matters: the first
    // version of `safeSheetName` left it out of the class while its own docblock
    // listed it, and `book_append_sheet` still threw.
    const sheet = buildPlannedFahrtenbuch(
      input({ meta: { ...META, sourceSheetName: "Fahrten/Oktober\\2026 ganz langer Name" } }),
    );
    expect(sheet.sheetName.length).toBeLessThanOrEqual(31);
    expect(sheet.sheetName).not.toMatch(/[:\\/?*[\]]/);
  });

  it('strips an apostrophe at either end of the tab label', () => {
    // A short name, so the 31-character cap does not remove the apostrophe
    // before the strip can be observed. `check_ws_name` tests both ends.
    const sheet = buildPlannedFahrtenbuch(
      input({ meta: { ...META, sourceSheetName: "'Oktober'" } }),
    );
    expect(sheet.sheetName).toBe('Oktober');
  });

  it('renames the reserved tab label History', () => {
    const sheet = buildPlannedFahrtenbuch(input({ meta: { ...META, sourceSheetName: 'History' } }));
    expect(sheet.sheetName.toLowerCase()).not.toBe('history');
  });

  it('falls back to Sheet1 for a missing tab label', () => {
    const sheet = buildPlannedFahrtenbuch(input({ meta: { ...META, sourceSheetName: null } }));
    expect(sheet.sheetName).toBe('Sheet1');
    expect(sheet.metaSheetName).toBe(PLANUNG_SHEET_NAME);
  });

  it('renames the PLANUNG sheet when the customer’s own tab is called that', () => {
    // `book_append_sheet` throws "Worksheet with name |X| already exists!".
    const same = buildPlannedFahrtenbuch(input({ meta: { ...META, sourceSheetName: 'PLANUNG' } }));
    expect(same.sheetName).toBe('PLANUNG');
    expect(same.metaSheetName).not.toBe('PLANUNG');
  });

  it('renames it for a differently-cased collision too, because Excel folds case', () => {
    const folded = buildPlannedFahrtenbuch(input({ meta: { ...META, sourceSheetName: 'Planung' } }));
    expect(folded.metaSheetName.toLowerCase()).not.toBe('planung');
  });

  it('distinctSheetName keeps the 31-character cap while it disambiguates', () => {
    const taken = ['A'.repeat(31)];
    const name = distinctSheetName('A'.repeat(31), taken);
    expect(name).not.toBe(taken[0]);
    expect(name.length).toBeLessThanOrEqual(31);
  });
});

// ── 10. the workbook, including the offset a reader cannot check ───────────

describe('the workbook', () => {
  it('holds both sheets, in order, and book_append_sheet accepts both names', () => {
    const wb = buildPlannedFahrtenbuchWorkbook(buildPlannedFahrtenbuch(input()));
    expect(wb.SheetNames).toEqual(['Fahrten Oktober', PLANUNG_SHEET_NAME]);
  });

  it('does not throw when the customer’s tab is called PLANUNG', () => {
    const sheet = buildPlannedFahrtenbuch(input({ meta: { ...META, sourceSheetName: 'PLANUNG' } }));
    expect(() => buildPlannedFahrtenbuchWorkbook(sheet)).not.toThrow();
  });

  it('puts the banner in A1 and the first header in A2', () => {
    const wb = buildPlannedFahrtenbuchWorkbook(buildPlannedFahrtenbuch(input()));
    const ws = wb.Sheets['Fahrten Oktober'];
    expect(String(cellOf(ws, 'A1').v).startsWith(PLANUNG_BANNER)).toBe(true);
    expect(cellOf(ws, 'A2').v).toBe('Datum der Fahrt');
    expect(cellOf(ws, 'A3').v).toBe('01.10.2026');
  });

  it('formats a date serial on the right row, one below where the legacy export puts it', () => {
    // THE OFFSET. `applySourceCellFormats` hard-codes `r + 1`, written for a
    // sheet whose row 0 is the headers. Here row 0 is the banner, so it is handed
    // `sheetRows.slice(1)`. NEGATIVE CONTROL: passing the data rows alone would
    // format row 1 — the header row — and leave every data cell a bare serial,
    // which is `46265` where the source sheet read `31.08.2026`.
    const wb = buildPlannedFahrtenbuchWorkbook(
      buildPlannedFahrtenbuch(
        input({
          trips: [
            trip({
              id: 't1',
              raw_data_json: {
                'Datum der Fahrt': 46265,
                Fahrername: 'Original Fahrer',
                Fahrpreis: 12.94,
              },
            }),
          ],
        }),
      ),
    );
    const ws = wb.Sheets['Fahrten Oktober'];
    // A3 is the first data row: banner, headers, then data.
    expect(cellOf(ws, 'A3').z).toBe('dd.mm.yyyy');
    expect(cellOf(ws, 'A3').t).toBe('n');
    // The header row was not touched, and a money column stays a bare number.
    expect(cellOf(ws, 'A2').z).toBeUndefined();
    const fahrpreis = XLSX.utils.encode_cell({ r: 2, c: HEADERS.indexOf('Fahrpreis') });
    expect(cellOf(ws, fahrpreis).v).toBe(12.94);
    expect(cellOf(ws, fahrpreis).z).toBeUndefined();
  });

  it('carries the label in the workbook properties as well', () => {
    const wb = buildPlannedFahrtenbuchWorkbook(buildPlannedFahrtenbuch(input()));
    expect(wb.Props?.Title).toContain(PLANUNG_BANNER);
  });
});

// ── 11. the small formatters ───────────────────────────────────────────────

describe('the document’s own German text', () => {
  it('formats a timestamp DD.MM.YYYY HH:MM, zero-padded', () => {
    // NEGATIVE CONTROL: `toLocaleString('de-DE')` gives `5.9.2026, 07:04:31` in
    // Node — neither the day nor the month padded — and the product's rule is
    // DD.MM.YYYY.
    expect(formatPlanungTimestamp(new Date(2026, 8, 5, 7, 4, 31))).toBe('05.09.2026 07:04');
    expect(formatPlanungTimestamp(new Date(2026, 11, 31, 23, 59))).toBe('31.12.2026 23:59');
  });

  it('formats the planned month as a DD.MM.YYYY range, leap year included', () => {
    expect(formatPlanungPeriod(2026, 10)).toBe('01.10.2026 – 31.10.2026');
    expect(formatPlanungPeriod(2026, 2)).toBe('01.02.2026 – 28.02.2026');
    expect(formatPlanungPeriod(2024, 2)).toBe('01.02.2024 – 29.02.2024');
    expect(formatPlanungPeriod(2026, 1)).toBe('01.01.2026 – 31.01.2026');
    expect(formatPlanungPeriod(2026, 12)).toBe('01.12.2026 – 31.12.2026');
  });

  it('names every plan status, and prints an unknown one rather than dropping it', () => {
    expect(planStatusLabel('draft')).toBe('Entwurf');
    expect(planStatusLabel('confirmed')).toBe('Bestätigt');
    expect(planStatusLabel('superseded')).toBe('Ersetzt');
    expect(planStatusLabel('something_new')).toBe('something_new');
    expect(planStatusLabel(null)).toBe('Unbekannt');
    expect(planStatusLabel('   ')).toBe('Unbekannt');
  });

  it('keeps the document’s text out of the dictionaries', () => {
    // CLAUDE.md's closed list: the Fahrtenbuch XLSX carries statutory German
    // text, which lives in the export module and never in de.ts / en.ts. A
    // `t(...)` call or an `engine.` key here would be the drift.
    expect(CODE_ONLY).not.toMatch(/\bt\(['"]/);
    expect(CODE_ONLY).not.toMatch(/'engine\./);
  });
});

// ── 12. the thin download ──────────────────────────────────────────────────

/**
 * A client that answers each table once and then a short page, so
 * `fetchAllPaginated` stops. It records what was asked of which table.
 */
function fakeClient(tables: Record<string, unknown[]>): {
  client: MonthlyPlanExportClient;
  requests: { table: string; columns: string; column: string; value: string }[];
} {
  const requests: { table: string; columns: string; column: string; value: string }[] = [];
  const client: MonthlyPlanExportClient = {
    from(table: string) {
      return {
        select(columns: string) {
          return {
            eq(column: string, value: string) {
              return {
                order() {
                  return {
                    range(from: number) {
                      requests.push({ table, columns, column, value });
                      return Promise.resolve({
                        data: from === 0 ? (tables[table] ?? []) : [],
                        error: null,
                      });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, requests };
}

const PLAN = {
  id: 'plan-1',
  company_id: 'company-1',
  year: 2026,
  month: 10,
  status: 'confirmed' as string | null,
  switch_minutes: 45 as number | null,
  generation: 3 as number | null,
  import_id: 'import-1' as string | null,
};

const IMPORT_ROW = {
  id: 'import-1',
  file_name: 'fahrtenbuch_2026_10.xlsx',
  source_columns_json: [...HEADERS],
  source_sheet_name: 'Fahrten Oktober',
};

/**
 * `loadPlannedFahrtenbuch` is covered and `downloadMonthlyPlanFahrtenbuch` is
 * not, on purpose: the download is that function plus `XLSX.writeFile`, which in
 * the `node` environment this suite runs in would write a real file into the
 * repository. The split exists for the preview the fourth screen asks for, and it
 * is what makes the read path testable at all.
 */
describe('loadPlannedFahrtenbuch', () => {
  it('refuses a plan with no import before it reads anything', async () => {
    const { client, requests } = fakeClient({});
    await expect(
      loadPlannedFahrtenbuch({ ...PLAN, import_id: null }, { client }),
    ).rejects.toThrow(MonthlyPlanFahrtenbuchBlockedError);
    expect(requests).toEqual([]);
  });

  it('reads the blocks by plan_id, the rides by import_id, and builds the document', async () => {
    const { client, requests } = fakeClient({
      monthly_plan_blocks: [block({ id: 'b1' })],
      monthly_plan_block_trips: [{ id: 'l1', plan_id: 'plan-1', ...link('b1', 't1') }],
      fahrtenbuch_trips: [trip({ id: 't1' })],
      fahrtenbuch_imports: [IMPORT_ROW],
    });

    const sheet = await loadPlannedFahrtenbuch(PLAN, { client, generatedAt: META.generatedAt });

    const byTable = new Map(requests.map(request => [request.table, request] as const));
    expect(byTable.get('monthly_plan_blocks')).toMatchObject({ column: 'plan_id', value: 'plan-1' });
    expect(byTable.get('monthly_plan_block_trips')).toMatchObject({ column: 'plan_id', value: 'plan-1' });
    expect(byTable.get('fahrtenbuch_trips')).toMatchObject({ column: 'import_id', value: 'import-1' });
    expect(byTable.get('fahrtenbuch_imports')).toMatchObject({ column: 'id', value: 'import-1' });
    expect(byTable.get('fahrtenbuch_trips')?.columns).toContain('raw_data_json');
    expect(byTable.get('fahrtenbuch_trips')?.columns).not.toContain('assigned_driver');

    // The headers and the tab label come from the import row, not from a constant.
    expect(sheet.headers).toEqual([...HEADERS]);
    expect(sheet.sheetName).toBe('Fahrten Oktober');
    expect(sheet.rows[0].cells[DRIVER_INDEX]).toBe('Geplanter Fahrer');
    expect(sheet.completeness.complete).toBe(true);
    expect(sheet.fileName).toBe('Fahrtenbuch_PLANUNG_2026-10.xlsx');
  });

  it('refuses when the import row itself could not be read', async () => {
    // Its `source_columns_json` is where the headers come from, so a missing
    // import row is `no_columns` rather than a sheet with invented headers.
    const { client } = fakeClient({
      monthly_plan_blocks: [block({ id: 'b1' })],
      monthly_plan_block_trips: [{ id: 'l1', ...link('b1', 't1') }],
      fahrtenbuch_trips: [trip({ id: 't1' })],
      fahrtenbuch_imports: [],
    });
    await expect(loadPlannedFahrtenbuch(PLAN, { client })).rejects.toMatchObject({
      reason: 'no_columns',
    });
  });

  it('throws out of a failed page instead of treating it as the end of the list', async () => {
    // PostgREST caps a response at 1000 rows and reports no error when it
    // truncates, so a page that fails must not read as "the list ended". A
    // truncated month would export a short Fahrtenbuch in which every figure is
    // plausible and wrong.
    const client: MonthlyPlanExportClient = {
      from(table: string) {
        return {
          select() {
            return {
              eq() {
                return {
                  order() {
                    return {
                      range() {
                        return Promise.resolve(
                          table === 'fahrtenbuch_trips'
                            ? { data: null, error: { message: 'connection lost' } }
                            : { data: [], error: null },
                        );
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
    await expect(loadPlannedFahrtenbuch(PLAN, { client })).rejects.toThrow(/connection lost/);
  });

  it('pages every read through the one shared paginator', () => {
    expect(CODE_ONLY).toContain('fetchAllPaginated');
    // Four reads, one code path: the only `.range(` in the module is the
    // paginator's. A fifth read added with a bare `.select()` would be capped at
    // 1000 rows with no error, which is the defect the paginator exists for.
    expect(CODE_ONLY.match(/\.range\(/g) ?? []).toHaveLength(1);
    // Five: the generic declaration plus its four call sites.
    expect(CODE_ONLY.match(/loadPaged</g) ?? []).toHaveLength(5);
  });
});
