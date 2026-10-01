/**
 * The three document builders of §10–§12, wired to screen 4's contract.
 *
 * The four pieces were built in parallel and could not import one another, so
 * `MonthlyPlanDocumentsStep` declared `MonthlyPlanDocumentBuilder` and shipped an
 * empty map — which renders nothing. This file is the join, and it is the only
 * place that knows both sides.
 *
 * ## What it does, and the one thing it must never do
 *
 * Each builder declared its **own** input type, and none of them is
 * `StoredMonthlyPlan`: the Stundennachweis wants the four tables in camelCase,
 * the payroll summary wants per-driver hour buckets in seconds, and the
 * Fahrtenbuch wants the *imported* rows, which are not part of a plan at all. So
 * this file renames fields, projects shapes and performs one database read.
 *
 * **It computes no figure.** Not one hour, not one total, not one minute is added
 * up here; every number reaches a document from the builder that owns it, and the
 * few strings written below are a builder's own formatter applied to a builder's
 * own value. That rule is §12's acceptance criterion 22 — the three documents'
 * totals must come from the same plan — and this product already carries the
 * counter-example twice over: two independent Stundennachweis builders that
 * disagree about holiday hours, the 30-minute minimum and the midnight split, and
 * one component whose toolbar total excludes the gap between merged shifts while
 * its own PDF includes it, so the two disagree for 92.5 % of driver-days. An
 * adapter that "helpfully" summed a column would be the third source.
 *
 * The one place that looks like an exception is the payroll summary's hour map,
 * and it is not one: the summary's buckets and the Stundennachweis's columns are
 * **different columns with different definitions** — the form's Grundlohn is the
 * day's whole worked time, Lohnart 1000 is 06:00–20:00 — so reusing one as the
 * other would print the wrong figure under the right heading. Both go through
 * `computeLohnartSeconds` and `getGermanNationalHolidays`, the golden-mastered
 * clean-engine pair, over the same stored blocks. Same engine, same plan, two
 * documents: that is what criterion 22 asks for.
 */

import {
  PROPOSAL_NOTICE,
  type DocumentPreview,
  type DocumentPreviewSection,
  type DocumentSubject,
  type MonthlyPlanDocumentBuilder,
  type MonthlyPlanDocumentBuilders,
  type MonthlyPlanDocumentRequest,
  type MonthlyPlanFile,
  type StoredMonthlyPlan,
} from './monthlyPlanDocuments';

import {
  buildMonthlyPlanStundennachweise,
  formatPlanHours,
  PLAN_STUNDENNACHWEIS_COLUMNS,
  type MonthlyPlanStundennachweis,
  type MonthlyPlanStundennachweisSet,
  type PlanDayHours,
  type StoredMonthlyPlan as SnPlan,
} from './monthlyPlanStundennachweis';

import {
  loadPlannedFahrtenbuch,
  buildPlannedFahrtenbuchWorkbook,
  MonthlyPlanFahrtenbuchBlockedError,
  type MonthlyPlanForExport,
  type PlannedFahrtenbuchSheet,
} from './monthlyPlanFahrtenbuchExport';

import {
  buildPayrollSummary,
  computePlanDriverHours,
  type PayrollSummary,
  type PayrollSummaryBlock,
  type PayrollSummaryDriver,
} from './monthlyPlanPayrollSummary';

import { buildTableWorkbook } from './excelExport';
import { styledWorkbookBlob } from './styledWorkbookDownload';

/** How many Von/Bis pairs the form has. `displayShifts` is already capped at it. */
const SHIFT_COLUMN_PAIRS = 3;

/** An empty preview cell. The screen renders null as blank and derives nothing. */
const EMPTY = null;

/**
 * Hours inside a sentence, where a blank is a hole rather than an empty cell.
 *
 * `formatPlanHours` answers `''` for zero on purpose: a Stundennachweis's
 * columns stay blank on an unworked day instead of printing `0,00` thirty times.
 * That is right for a cell and wrong for prose, so the sentence says `0,00`.
 */
function hoursInSentence(minutes: number): string {
  return formatPlanHours(minutes) || '0,00';
}

/**
 * `YYYY-MM-DD` as `DD.MM.YYYY`.
 *
 * A re-ordering of the builder's own `dateKey`, never a `Date` and never a
 * locale call: parsing the key into a `Date` and formatting it back would put a
 * timezone between the plan and the sheet, which is the class of defect the whole
 * engine is built to avoid. A key that is not three parts is printed as it came.
 */
function germanDay(dateKey: string): string {
  const parts = dateKey.split('-');
  if (parts.length !== 3) return dateKey;
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

/** The generation line, as a document header carries it. */
function generatedLine(at: Date): string {
  return `Erzeugt am ${germanDay(
    `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`,
  )}`;
}

// ── The projection into each builder's own vocabulary ────────────────────────

/**
 * `StoredMonthlyPlan` in the Stundennachweis module's camelCase.
 *
 * A rename and nothing else — every field on the right is the column on the
 * left. `personalnummer` is deliberately absent: `monthly_plan_drivers` has no
 * such column (the §13 snapshot stores §4's planning values and the name), the
 * builder treats it as optional, and the sheet simply has no Pers.-Nr. line
 * rather than printing an id in its place.
 */
function toStundennachweisPlan(plan: StoredMonthlyPlan): SnPlan {
  return {
    year: plan.year,
    month: plan.month,
    status: plan.status,
    drivers: plan.drivers.map(d => ({
      driverId: d.driver_id,
      driverName: d.driver_name,
      isOwner: d.is_owner,
      selected: d.selected,
    })),
    blocks: plan.blocks.map(b => ({
      blockKey: b.block_key,
      carId: b.car_id,
      carIdentifier: b.car_identifier,
      startsAt: b.starts_at,
      endsAt: b.ends_at,
      spanMinutes: b.span_minutes,
      rideMinutes: b.ride_minutes,
      driverId: b.driver_id,
      driverName: b.driver_name,
      trips: b.trips.map(t => ({
        tripId: t.trip_id,
        startsAt: t.starts_at,
        endsAt: t.ends_at,
        minutes: t.minutes,
      })),
    })),
  };
}

/**
 * The blocks as the payroll summary's hour computation takes them: absolute
 * instants in epoch milliseconds, which is the engine's premise throughout.
 *
 * A block whose stored text does not parse is **dropped from the hour figures**
 * rather than clamped to zero, because a zero would read as "this driver did not
 * work". It still reaches the summary as a driver row with blank cells, which is
 * §23's rule, and the Stundennachweis reports the same block as a problem on the
 * document that is actually about hours.
 */
function toPayrollBlocks(plan: StoredMonthlyPlan): PayrollSummaryBlock[] {
  const blocks: PayrollSummaryBlock[] = [];
  for (const b of plan.blocks) {
    const startMs = Date.parse(b.starts_at);
    const endMs = Date.parse(b.ends_at);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    blocks.push({ driverId: b.driver_id, startMs, endMs, rideMinutes: b.ride_minutes });
  }
  return blocks;
}

/**
 * The drivers as the summary takes them. `personalnummer` is null for the reason
 * given in `toStundennachweisPlan`: the snapshot has no such column, and the
 * builder's own contract says null prints blank and never an id.
 */
function toPayrollDrivers(plan: StoredMonthlyPlan): PayrollSummaryDriver[] {
  return plan.drivers.map(d => ({
    driverId: d.driver_id,
    driverName: d.driver_name,
    personalnummer: null,
  }));
}

/** The plan as the Fahrtenbuch loader takes it. A saved plan has an id; see below. */
function toExportPlan(plan: StoredMonthlyPlan): MonthlyPlanForExport {
  if (!plan.id) {
    throw new Error(
      'Das geplante Fahrtenbuch wird aus den Originaldaten des Imports gebaut. '
      + 'Dazu muss die Planung gespeichert sein.',
    );
  }
  return {
    id: plan.id,
    company_id: plan.company_id,
    year: plan.year,
    month: plan.month,
    status: plan.status,
    switch_minutes: plan.switch_minutes,
    generation: plan.generation,
    import_id: plan.import_id,
  };
}

// ── §11 — a Stundennachweis per driver ──────────────────────────────────────

function stundennachweisSet(
  plan: StoredMonthlyPlan,
  generatedAt: Date,
): MonthlyPlanStundennachweisSet {
  return buildMonthlyPlanStundennachweise(toStundennachweisPlan(plan), { generatedAt });
}

/**
 * The document for one driver, or the first exportable one when the screen has
 * not chosen yet.
 *
 * A driver the builder marked unexportable is **not** returned: its figures
 * carry a blocking problem, and the builder's own rule is that such a document is
 * neither shown nor exported. Throwing here is what the screen turns into a named
 * refusal, and it is also what withholds the download button.
 */
function stundennachweisFor(
  set: MonthlyPlanStundennachweisSet,
  subjectId: string | undefined,
): MonthlyPlanStundennachweis {
  if (set.withheld) {
    throw new Error(
      set.problems.map(p => p.detail).join(' ')
      || 'Die Daten dieser Planung sind unvollständig; es wird kein Dokument erzeugt.',
    );
  }
  const sheet = subjectId
    ? set.drivers.find(d => d.driverId === subjectId)
    : set.drivers[0];
  if (!sheet) {
    throw new Error('Für diesen Fahrer enthält die Planung keinen Block.');
  }
  if (!sheet.exportable) {
    throw new Error(
      sheet.problems.filter(p => p.blocking).map(p => p.detail).join(' ')
      || 'Die Zahlen dieses Fahrers sind unvollständig; das Dokument wird zurückgehalten.',
    );
  }
  return sheet;
}

/**
 * One row of the form, in the form's own column order: the date, the weekday,
 * three Von/Bis pairs, then the six Lohnart columns.
 *
 * Every hour cell is `formatPlanHours` applied to the builder's own minute
 * figure — the builder exports that function precisely so the preview and the
 * PDF print one unit, since the two older builders disagree there and a column
 * printed in two units cannot be added up by the accountant reading it.
 */
function stundennachweisRow(day: PlanDayHours, index: number): {
  id: string;
  cells: (string | null)[];
} {
  const cells: (string | null)[] = [germanDay(day.dateKey), day.weekday];

  for (let i = 0; i < SHIFT_COLUMN_PAIRS; i++) {
    const shift = day.displayShifts[i];
    cells.push(shift ? shift.startLabel : EMPTY, shift ? shift.endLabel : EMPTY);
  }

  // Minutes per column, in `PLAN_STUNDENNACHWEIS_COLUMNS`' order. The keys the
  // day carries are the totals' keys, so this map and the totals row below can
  // never fall out of step.
  const minutes: Record<string, number> = {
    grundlohn: day.workedMinutes,
    nachtarbeit: day.nachtarbeitMinutes,
    nachtarbeit04: day.nacht0bis4Minutes,
    sonntag: day.sonntagMinutes,
    feiertag: day.feiertagMinutes,
    weihnachten: day.weihnachtenMinutes,
  };
  for (const column of PLAN_STUNDENNACHWEIS_COLUMNS) {
    cells.push(formatPlanHours(minutes[column.key] ?? 0) || EMPTY);
  }

  return { id: `${day.dateKey}:${index}`, cells };
}

function stundennachweisSection(sheet: MonthlyPlanStundennachweis): DocumentPreviewSection {
  const columns = [
    { header: 'Datum' },
    { header: 'Tag' },
    ...Array.from({ length: SHIFT_COLUMN_PAIRS }).flatMap((_, i) => [
      { header: `Von ${i + 1}` },
      { header: `Bis ${i + 1}` },
    ]),
    ...PLAN_STUNDENNACHWEIS_COLUMNS.map(c => ({ header: c.label, numeric: true })),
  ];

  // The totals row: the builder's own `totals`, in minutes, through the builder's
  // own formatter. `samstag` has no column on the form and is not shown, exactly
  // as the builder notes — it is computed, and the form has no place for it.
  const totalMinutes: Record<string, number> = {
    grundlohn: sheet.totals.grundlohn,
    nachtarbeit: sheet.totals.nachtarbeit,
    nachtarbeit04: sheet.totals.nacht04,
    sonntag: sheet.totals.sonntag,
    feiertag: sheet.totals.feiertag,
    weihnachten: sheet.totals.weihnachten,
  };
  const totals: (string | null)[] = [
    'Summe',
    EMPTY,
    ...Array.from({ length: SHIFT_COLUMN_PAIRS * 2 }, () => EMPTY),
    ...PLAN_STUNDENNACHWEIS_COLUMNS.map(c => formatPlanHours(totalMinutes[c.key] ?? 0) || EMPTY),
  ];

  return {
    caption: sheet.driverName,
    columns,
    rows: sheet.days.map(stundennachweisRow),
    totals,
  };
}

/**
 * The lines below the sheet: the builder's own problem sentences, plus the two
 * facts a reader of a *planned* sheet needs and cannot see in the rows — the
 * periods that fall outside the month, and the days whose periods were merged
 * into three columns.
 *
 * The compression note is required by §11 ("no period above the third is
 * dropped") and by CLAUDE.md's rule that compression is display-only: the Von/Bis
 * columns show fewer pairs than the day has, while every hour column is the
 * uncompressed figure. Saying so is the difference between a merged column and a
 * lost shift.
 */
function stundennachweisFootnotes(
  sheet: MonthlyPlanStundennachweis,
  set: MonthlyPlanStundennachweisSet,
): string[] {
  const notes = sheet.problems.map(p => p.detail);

  // Who is NOT in the picker, said on the document rather than left to be
  // noticed. Filtering a driver out of the list without saying so turns one
  // false claim (an empty sheet) into another (a month with fewer drivers than
  // it has), and §14's rule is that every case appears as a named diagnostic.
  const withoutWork = set.drivers.filter(d => d.assignedBlockCount === 0);
  if (withoutWork.length > 0) {
    notes.push(
      `Für ${withoutWork.length} Fahrer der Planung entsteht kein Stundennachweis, `
      + 'weil ihnen kein Block zugeteilt wurde: '
      + `${withoutWork.map(d => d.driverName).join(', ')}.`,
    );
  }

  const compressed = sheet.days.filter(d => d.compressed).length;
  if (compressed > 0) {
    notes.push(
      `An ${compressed} Tag(en) hat der Fahrer mehr als ${SHIFT_COLUMN_PAIRS} Zeiträume; `
      + 'die Von/Bis-Spalten fassen sie zusammen. Die Stundenspalten enthalten alle Zeiträume.',
    );
  }
  if (sheet.carryOver.length > 0) {
    const minutes = sheet.carryOver.reduce((sum, c) => sum + c.minutes, 0);
    notes.push(
      `${sheet.carryOver.length} Zeitraum/Zeiträume (${formatPlanHours(minutes)} Std.) liegen `
      + 'außerhalb des geplanten Monats und erscheinen nicht in den Zeilen oben.',
    );
  }
  return notes;
}

const stundennachweisBuilder: MonthlyPlanDocumentBuilder = {
  kind: 'stundennachweis',

  /**
   * Who gets a sheet is the builder's answer, not the screen's: deriving the list
   * from the plan's blocks here would let the picker and the documents disagree
   * about who is in the month. A driver whose document is withheld is left out,
   * so the picker never offers a document that cannot be produced.
   *
   * The stamp is irrelevant to the list and a fixed epoch is passed rather than
   * reading a clock, which keeps this function pure and its result stable across
   * renders.
   */
  subjects(plan: StoredMonthlyPlan): DocumentSubject[] {
    const set = stundennachweisSet(plan, new Date(0));
    if (set.withheld) return [];
    // `exportable` answers "are this driver's figures trustworthy", not "does
    // this driver have any". A driver the plan gave no block is exportable by
    // that test and was offered a sheet of 31 empty days with a working
    // download — and **an empty Stundennachweis is a claim that the driver
    // worked no hours**, which is CLAUDE.md's own rule about an empty list and a
    // zero total. Measured on staging: two of six drivers, both excluded for a
    // configuration reason, both with a downloadable PDF.
    return set.drivers
      .filter(d => d.exportable && d.assignedBlockCount > 0)
      .map(d => ({ id: d.driverId, label: d.driverName }));
  },

  preview(request): DocumentPreview {
    const set = stundennachweisSet(request.plan, request.generatedAt);
    const sheet = stundennachweisFor(set, request.subjectId);
    const footnotes = stundennachweisFootnotes(sheet, set);

    return {
      header: [
        PROPOSAL_NOTICE,
        set.noticeLine,
        `${sheet.driverName} · ${set.monthLabel}`,
        // `formatPlanHours` answers an empty string for zero — deliberately, so a
        // sheet's cells stay blank rather than printing `0,00` on every unworked
        // day. In a sentence that reads as a hole: "0 Block/Blöcke · Std.
        // geplant, davon Std. Fahrzeit" is what a driver with no blocks got. A
        // sentence needs a number, so it gets one.
        `${sheet.assignedBlockCount} Block/Blöcke · `
        + `${hoursInSentence(sheet.planBlockMinutes)} Std. geplant, davon `
        + `${hoursInSentence(sheet.planRideMinutes)} Std. Fahrzeit`,
      ],
      sections: [stundennachweisSection(sheet)],
      footnotes: footnotes.length > 0 ? footnotes : undefined,
    };
  },

  async file(request): Promise<MonthlyPlanFile> {
    const set = stundennachweisSet(request.plan, request.generatedAt);
    const sheet = stundennachweisFor(set, request.subjectId);
    // Imported here rather than at the top: the renderer pulls in jsPDF, and the
    // pure half of this feature is tested in the `node` environment the whole
    // suite runs in. `exportData` is exactly what it takes — the builder says so.
    const { getStundennachweisBlob } = await import('./stundennachweisPdfExport');
    return { filename: `${sheet.filename}.pdf`, blob: getStundennachweisBlob(sheet.exportData) };
  },
};

// ── §10 — the planned Fahrtenbuch ───────────────────────────────────────────

/**
 * The Fahrtenbuch is the one document with a `load` step, and the reason is what
 * the document *is*: the imported sheet with the driver column overlaid. Its
 * headers are the import's own (`source_columns_json`) and every cell but the
 * driver is `raw_data_json` verbatim — which is the property that makes the
 * export trustworthy, and which no projection of a plan can reproduce.
 */
const fahrtenbuchBuilder: MonthlyPlanDocumentBuilder = {
  kind: 'fahrtenbuch',

  /**
   * `async`, and that is load-bearing rather than a style choice.
   *
   * `toExportPlan` throws for a plan that was never saved, and the screen calls
   * this as `load(...).then(...).catch(...)`. A method typed `Promise<T>` that
   * throws **synchronously** escapes that `.catch` altogether: the effect dies,
   * the tab stays on its loading notice for ever, and the failure surfaces as an
   * unhandled rejection in the console instead of as the sentence above. `async`
   * turns every throw in the body into the rejection the caller is written
   * against. The test for the unsaved plan is what found this.
   */
  async load(request): Promise<PlannedFahrtenbuchSheet> {
    return loadPlannedFahrtenbuch(toExportPlan(request.plan), {
      generatedAt: request.generatedAt,
    });
  },

  preview(request, loaded): DocumentPreview {
    const sheet = expectSheet(loaded);
    const c = sheet.completeness;

    // The banner row and the header row are the sheet's rows 1 and 2; the table
    // renders the data rows, whose header is row 2 and whose cells are the
    // imported values. `sheet.rows` and `sheet.sheetRows` hold the same cells —
    // the typed one is read, so a null is a blank and not the text "null".
    const rows = sheet.rows.map(row => ({
      id: row.tripId,
      cells: row.cells.map(cell =>
        cell === null || cell === '' ? EMPTY : typeof cell === 'string' ? cell : String(cell),
      ),
    }));

    const footnotes = [
      `${c.plannedRows} von ${c.totalRows} Zeilen tragen den geplanten Fahrer in der Spalte `
      + `„${c.driverColumn}“. Alle übrigen Spalten sind unverändert aus dem Import übernommen.`,
    ];
    if (c.keptOriginalRows > 0) {
      footnotes.push(
        `${c.keptOriginalRows} Zeile(n) behalten den importierten Fahrer: `
        + `${c.canceledRows} storniert, ${c.notInPlanRows} nicht in der Planung, `
        + `${c.unassignedBlockRows} in einem Block ohne Fahrer.`,
      );
    }
    if (c.canceledInPlanRows > 0) {
      footnotes.push(
        `${c.canceledInPlanRows} stornierte Fahrt(en) liegen in einem Block dieser Planung. `
        + 'Ihr Fahrer wird nicht ersetzt. Prüfen Sie, ob Planung und Import zum selben Monat gehören.',
      );
    }

    return {
      header: [PROPOSAL_NOTICE, sheet.banner, generatedLine(request.generatedAt)],
      sections: [{ columns: sheet.headers.map(h => ({ header: h })), rows }],
      footnotes,
    };
  },

  // The request is unused on purpose: everything this document says, the
  // generation date included, is already in the sheet `load` built from it.
  async file(_request, loaded): Promise<MonthlyPlanFile> {
    const sheet = expectSheet(loaded);
    const workbook = buildPlannedFahrtenbuchWorkbook(sheet);
    // `xlsx`, not `exceljs`: this document has to reproduce the imported sheet,
    // and the statutory writers stay on the library they were verified with.
    const XLSX = await import('xlsx');
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    return {
      filename: `${sheet.fileName}.xlsx`,
      blob: new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    };
  },
};

/**
 * The loaded sheet, or a refusal.
 *
 * A screen that called `preview` before `load` finished would otherwise render an
 * empty Fahrtenbuch, and an empty Fahrtenbuch is a claim that the month had no
 * rides. The message is the loader's own where it has one, so a missing import
 * still explains itself in the words §10 wrote for it.
 */
function expectSheet(loaded: unknown): PlannedFahrtenbuchSheet {
  if (loaded == null) {
    throw new Error('Die Originaldaten des Imports sind noch nicht geladen.');
  }
  if (loaded instanceof MonthlyPlanFahrtenbuchBlockedError) throw loaded;
  return loaded as PlannedFahrtenbuchSheet;
}

// ── §12 — the payroll hours summary ─────────────────────────────────

/**
 * `PAYROLL_SUMMARY_COLUMNS` is `{label, width}` — the Fahrerübersicht's own list,
 * which carries no key, because its consumers write cells positionally. The
 * generic exporter is keyed, so a key is synthesised from the position here and
 * nowhere else: it never reaches a document, and the cells stay in the builder's
 * order either way.
 */
function payrollColumnKey(index: number): string {
  return `c${index}`;
}

function payrollSummary(request: MonthlyPlanDocumentRequest): PayrollSummary {
  return buildPayrollSummary({
    month: request.plan.month,
    year: request.plan.year,
    // The company's own name, which a plan does not carry — the screen reads it
    // from `CompanySettingsContext` and passes it in. Without it the builder
    // printed `Unternehmen: —` on a document that goes to a Steuerberater, which
    // is honest but useless. It still prints the dash when the name is missing:
    // a uuid in that line would be read as the company's name by the one
    // recipient least able to tell, exactly as its own `personalnummer` note
    // says of the employee-number column.
    companyName: request.companyName ?? '',
    drivers: toPayrollDrivers(request.plan),
    hoursByDriverId: computePlanDriverHours(toPayrollBlocks(request.plan)),
    generatedAtMs: request.generatedAt.getTime(),
  });
}

/**
 * The document's own header lines, in the order it prints them.
 *
 * `PROPOSAL_NOTICE` is not repeated: `planungNotice` opens with that exact
 * sentence and adds the generation date, so printing both would say it twice.
 */
function payrollHeader(summary: PayrollSummary): string[] {
  return [summary.planungNotice, summary.title, summary.companyLine];
}

const payrollBuilder: MonthlyPlanDocumentBuilder = {
  kind: 'payroll_summary',

  preview(request): DocumentPreview {
    const summary = payrollSummary(request);

    const footnotes = [summary.footerNote];
    if (summary.driversWithoutWork > 0) {
      footnotes.push(
        `${summary.driversWithoutWork} Fahrer der Planung haben keinen zugeteilten Block. `
        + 'Ihre Zeile bleibt leer und wird nicht weggelassen.',
      );
    }

    return {
      header: payrollHeader(summary),
      sections: [{
        // A column is right-aligned when the builder wrote every one of its
        // non-empty cells as a number — read off the builder's own cell types, so
        // the alignment cannot claim something about a figure this file never saw.
        columns: summary.columns.map((column, i) => ({
          header: column.label,
          numeric: summary.rows.some(row => typeof row.cells[i] === 'number'),
        })),
        // The builder's own cells, in the builder's own column order — the same
        // array the workbook writes, so the preview and the file cannot differ.
        rows: summary.rows.map(row => ({
          id: row.driverId,
          cells: row.cells.map(cell => (cell === '' ? EMPTY : String(cell))),
        })),
      }],
      footnotes,
    };
  },

  async file(request): Promise<MonthlyPlanFile> {
    const summary = payrollSummary(request);

    /*
     * The generic table exporter, and deliberately so: §12 calls this document a
     * Vorschlag for the Steuerberater, not a statutory form, so — by this
     * repository's own rule — an `exportTableToExcel` dump is not on the list of
     * sheets whose German is prescribed, and it gets the same styled look as
     * every other table export.
     *
     * Two things it must carry, and both go in through the existing chrome rather
     * than through a new option: the PLANUNG banner, as the filter line's own
     * label, and the builder's footer sentence, as the footer label. **No
     * `totals`** — the footer sentence says in so many words that Samstag,
     * Sonntag, Feiertag and Weihnachten are surcharge kinds of the same hours and
     * must not be added, so a totals row would be a figure this document
     * explicitly refuses to state.
     *
     * The hour cells stay `'text'`: the builder formats them to German decimals
     * itself, and re-declaring a formatted string as a number column would write
     * a text cell that claims to be numeric. Which cells are numbers is the
     * builder's decision, and it is read, never overridden.
     */
    const columns = summary.columns.map((column, i) => ({
      key: payrollColumnKey(i),
      label: column.label,
      width: column.width,
      type: summary.rows.some(row => typeof row.cells[i] === 'number')
        ? ('number' as const)
        : ('text' as const),
    }));

    const rows = summary.rows.map(row => {
      const record: Record<string, unknown> = {};
      summary.columns.forEach((_, i) => { record[payrollColumnKey(i)] = row.cells[i] ?? ''; });
      return record;
    });

    const workbook = buildTableWorkbook({
      filename: summary.fileName,
      sheetTitle: summary.title,
      moduleName: 'Lohn-Stundenübersicht (Planung)',
      columns,
      rows,
      filterSummary: [summary.planungNotice, summary.periodLabel, summary.companyLine],
      labels: {
        activeFilters: `${PROPOSAL_NOTICE} ·`,
        footer: summary.footerNote,
        emptyState: 'Diese Planung enthält keinen Fahrer.',
      },
    });

    return { filename: `${summary.fileName}.xlsx`, blob: await styledWorkbookBlob(workbook) };
  },
};

export const MONTHLY_PLAN_DOCUMENT_BUILDERS: MonthlyPlanDocumentBuilders = {
  stundennachweis: stundennachweisBuilder,
  fahrtenbuch: fahrtenbuchBuilder,
  payroll_summary: payrollBuilder,
};
