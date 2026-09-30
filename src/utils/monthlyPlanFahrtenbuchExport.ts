/**
 * §10 — the Fahrtenbuch the monthly plan **proposes**.
 *
 * ── THE RULE THIS PRESERVES, AND IT IS `buildOriginalSheet`'s ──────────────
 *
 * §10: "Create a new Fahrtenbuch from the original data. Keep the times, the
 * vehicles, the distances and the destinations. Fill the driver from the plan's
 * result. Keep the original driver internally."
 *
 * So every cell is written **verbatim from `raw_data_json`** and exactly one
 * column may differ from what was imported: the Fahrername. That is
 * `monatsplanungXlsxExport.buildOriginalSheet`'s rule, and it is the whole
 * reason either export is trustworthy —
 *
 *     const row = headers.map(h => cellValue(raw[h]));
 *     if (!t.is_canceled && driverColumn && t.assigned_driver_name) { … }
 *
 * — and it is preserved here character for character in intent: the same
 * `headers.map(cellValue)`, the same "cancelled rides are never touched", the
 * same single-cell replacement. Nothing in this module computes a time, a
 * distance, a price or a total, and nothing reformats a cell. There is no
 * arithmetic here at all, which is why `utils/money.ts` is deliberately absent:
 * a money cell that went through a formatter would no longer be the imported
 * value, and §10 asks for the imported value.
 *
 * ── THE TWO DIFFERENCES FROM THAT MODULE ─────────────────────────────────
 *
 * 1. **The driver comes from the plan, not from `fahrtenbuch_trips`.** The join
 *    is `monthly_plan_block_trips.trip_id` → `.block_id` →
 *    `monthly_plan_blocks.driver_name`. The legacy applied-run pipeline's own
 *    driver column on the trip row is never read — it would be a second source
 *    for one figure, which is the defect this whole feature exists to avoid. A
 *    ride in no block keeps its original driver, and the workbook says how many
 *    did. The test asserts that column's name appears nowhere in this file, so
 *    do not name it in a comment either.
 *
 *    The name written is the **plan's stored** `driver_name`, not
 *    `drivers.name` as it reads today. That is §13's snapshot rule: a renamed or
 *    deleted driver must not re-label a plan that was already made.
 *
 * 2. **This is a proposal, and the file says so before anything else.** The
 *    sheet's first row is `PLANUNG / VORSCHAU — kein Arbeitszeitnachweis` with
 *    the date it was generated, the headers move to row 2, the filename carries
 *    `_PLANUNG_`, and a second sheet repeats it with the figures.
 *
 *    **The banner row is not decoration; it is what makes the file
 *    unimportable.** `FahrtenbuchImportModal` reads a workbook with the first
 *    row as its header set. Without the banner, this file would import cleanly
 *    and a *proposal for a month that has not happened* would become stored
 *    trip data — the one outcome the owner's decision forbids. With it, the
 *    importer finds no "Datum der Fahrt" and stores nothing (a row with neither
 *    that column nor a dated start cannot be stored at all, `trip_date` being
 *    NOT NULL). Do not "tidy" the banner into a separate sheet on the grounds
 *    that a tab is cleaner: a tab can be deleted and a filename renamed, and
 *    then only the row order stands between a plan and the ride log.
 *
 *    Nothing here writes anything. This module has no INSERT, no UPDATE and no
 *    RPC; it reads four tables and builds a file.
 *
 * ── WHY THE BUILDER IS PURE AND THE DOWNLOAD IS THIN ─────────────────────
 *
 * `buildPlannedFahrtenbuch` takes rows and returns a sheet; it touches no
 * network, no clock (the generation instant is an argument) and no DOM. It is
 * the deliverable that makes the document checkable, which is the answer to the
 * two independent Stundennachweis builders that disagree today: one function,
 * one set of rows, and the on-screen preview and the written cells come out of
 * the *same* array — `preview[i].cells` **is** the sheet's row `i`, so a table
 * and the file cannot drift.
 *
 * ── HOW AN INCOMPLETE PLAN IS REPORTED, AND WHY THAT WAY ─────────────────
 *
 * `exportAppliedRunXlsx` computes a validation and **two of its three call
 * sites discard the return value entirely** (`FinalizePlanningModal.tsx:934`,
 * `MonatsplanungStundennachweisPreview.tsx:1849`), so a file with missing
 * drivers is written with nobody told. The first of those two is worse than it
 * looks: on the `blocked` branch that function writes **no file at all** and the
 * modal still sets `xlsxDone`. A return value a caller may drop is therefore not
 * a report. This module splits the cases instead:
 *
 *   · **Refused, by `throw`** — the document could not be trusted as a whole:
 *     no rides, no columns, no Fahrername column (nothing could be replaced, so
 *     the file would be the import under a plan's name), a block reference that
 *     resolves to no block (the blocks read was truncated, and a truncated read
 *     is indistinguishable from "these rides are unassigned"), a ride in two
 *     blocks (§23: no ride is counted twice, and which driver won would be
 *     arbitrary). Thrown rather than returned for
 *     `FahrtenbuchExportBlockedError`'s own stated reason: a throw is what
 *     reaches the user through a caller's catch, and `reason` is the stable half
 *     to key a later translation off — never the wording.
 *
 *   · **Recorded, and written into the workbook** — states the requirement
 *     expects: a block §8 left unassigned, a ride §14 could not place, a
 *     cancelled ride. Refusing there would let one unplannable ride withhold a
 *     whole month's document, which is the mistake `20260930100000`'s header
 *     warns against in the same words ("One misconfigured driver therefore
 *     cannot block a whole month"). They are put **in the file**, on the PLANUNG
 *     sheet, and not only in the return value — so even a caller that discards
 *     the result ships a document that says how many rides kept their original
 *     driver. That is the structural fix for the defect above: make the report
 *     part of the artefact.
 *
 * ── SHEET NAMES ARE A LIVE CRASH ─────────────────────────────────────────
 *
 * `book_append_sheet` calls `check_ws_name`, which **throws** on five different
 * names, and the customer's own tab label reaches it verbatim. `safeSheetName`
 * is imported from `fahrtenbuchExport` for that; there is deliberately no
 * second copy here — the one in `monatsplanungXlsxExport` covers 2 of the 5
 * conditions, which is what a second copy does. Measured in the pinned library
 * (xlsx 0.20.3, `xlsx.js:27683`), `book_append_sheet` **also** throws
 * `"Worksheet with name |…| already exists!"` on a duplicate, comparing
 * case-sensitively — so a customer whose tab is called `PLANUNG` would crash the
 * second append. `distinctSheetName` is the guard, and it compares
 * case-insensitively because Excel's own uniqueness is.
 */

import * as XLSX from 'xlsx';
import { applySourceCellFormats, findDriverColumn, safeSheetName } from './fahrtenbuchExport';
import { fetchAllPaginated } from './fetchAllPaginated';

/** A cell as `aoa_to_sheet` takes it. `null` writes no cell, as `buildOriginalSheet` does. */
export type PlannedFahrtenbuchCell = string | number | boolean | null;

/** The name of the second sheet. Also the reserved name `distinctSheetName` protects. */
export const PLANUNG_SHEET_NAME = 'PLANUNG';

/** The label every output of this feature carries, in both UI languages. */
export const PLANUNG_BANNER = 'PLANUNG / VORSCHAU — kein Arbeitszeitnachweis';

// ── the rows this module reads ──────────────────────────────────────────────

/** `public.monthly_plan_blocks`, the four columns the driver overlay needs. */
export interface PlanBlockRowForExport {
  id: string;
  block_key: string;
  driver_id: string | null;
  driver_name: string | null;
}

/** `public.monthly_plan_block_trips`: which ride is in which block. */
export interface PlanBlockTripRowForExport {
  block_id: string;
  trip_id: string;
}

/**
 * `public.fahrtenbuch_trips`, the original data. `raw_data_json` is the whole
 * imported row and is the only source of a cell's value; the sort columns carry
 * the file's own order (see `orderTrips`).
 */
export interface ImportedTripRowForExport {
  id: string;
  is_canceled: boolean | null;
  original_driver_name: string | null;
  raw_data_json: Record<string, unknown> | null;
  source_row_index: number | null;
  trip_date: string | null;
  start_time: string | null;
}

/** What the header line and the PLANUNG sheet print. */
export interface PlannedFahrtenbuchMeta {
  year: number;
  /** 1-based, as `monthly_plans.month` stores it. */
  month: number;
  /** `monthly_plans.status`. Printed in German; an unknown value prints as-is. */
  planStatus: string | null;
  /** `monthly_plans.switch_minutes`. 0 is a value, never "unset". */
  switchMinutes: number | null;
  /** `monthly_plans.generation` — the "Neu generieren" counter of §7 rule 9. */
  generation: number | null;
  /** `fahrtenbuch_imports.file_name`, named as lineage only. Never reused as the output name. */
  sourceFileName: string | null;
  /** `fahrtenbuch_imports.source_sheet_name`, the customer's own tab label. */
  sourceSheetName: string | null;
  /** When this document was produced. An argument, so the builder reads no clock. */
  generatedAt: Date;
}

export interface PlannedFahrtenbuchInput {
  /** `fahrtenbuch_imports.source_columns_json` — the imported headers, in order. */
  headers: readonly string[];
  trips: readonly ImportedTripRowForExport[];
  blocks: readonly PlanBlockRowForExport[];
  blockTrips: readonly PlanBlockTripRowForExport[];
  meta: PlannedFahrtenbuchMeta;
}

// ── what it produces ───────────────────────────────────────────────────────

/** Where the driver in a row came from. */
export type PlannedDriverSource = 'plan' | 'original';

/** Why a row kept its original driver. `null` when it did not. */
export type KeptOriginalReason =
  /** `is_canceled`. Never reassigned, never counted — the rule is repo-wide. */
  | 'canceled'
  /** In no block: `buildBlocks` rejected the ride, or it is outside the plan (§14). */
  | 'not_in_plan'
  /** In a block §8 left unassigned. */
  | 'block_unassigned';

/**
 * One row of the document, and the same array the sheet writes. A table renders
 * these; nothing recomputes them.
 */
export interface PlannedFahrtenbuchRow {
  tripId: string;
  /** The sheet's data row: every imported column, only the driver possibly replaced. */
  cells: PlannedFahrtenbuchCell[];
  /** What the Fahrername cell now holds. */
  driverName: string;
  driverSource: PlannedDriverSource;
  /** `original_driver_name`, kept for the record (§2 keeps it internally). */
  originalDriverName: string;
  keptOriginalReason: KeptOriginalReason | null;
  isCanceled: boolean;
  /** `monthly_plan_blocks.block_key`, or null when the ride is in no block. */
  blockKey: string | null;
}

/** How complete the overlay is. Every figure is a count of rows, never an estimate. */
export interface PlannedFahrtenbuchCompleteness {
  totalRows: number;
  /** Rows whose Fahrername was replaced from the plan. */
  plannedRows: number;
  /** Rows that kept the imported Fahrername, for any of the three reasons. */
  keptOriginalRows: number;
  canceledRows: number;
  notInPlanRows: number;
  unassignedBlockRows: number;
  /**
   * Cancelled rides that a block nevertheless contains. `buildBlocks` filters
   * cancelled rides, so this is zero for a plan the engine made; it is counted
   * rather than refused so a mismatched plan/import pairing is visible instead
   * of silent. Their driver is not replaced either way.
   */
  canceledInPlanRows: number;
  driverColumn: string;
  /** True when every ride that could carry a planned driver does. */
  complete: boolean;
}

/** The finished document, before it is written. */
export interface PlannedFahrtenbuchSheet {
  /** The imported headers, unchanged and in order. Sheet row 2. */
  headers: string[];
  /** One entry per imported ride, in the file's own order. */
  rows: PlannedFahrtenbuchRow[];
  /** The whole sheet: the banner row, the headers, then the data. */
  sheetRows: PlannedFahrtenbuchCell[][];
  /** The banner in row 1, and the same sentence the PLANUNG sheet opens with. */
  banner: string;
  /** The data sheet's tab label, already through `safeSheetName`. */
  sheetName: string;
  /** The PLANUNG sheet's tab label, guaranteed distinct from the above. */
  metaSheetName: string;
  /** The PLANUNG sheet's rows. */
  metaRows: PlannedFahrtenbuchCell[][];
  fileName: string;
  completeness: PlannedFahrtenbuchCompleteness;
}

// ── refusals ───────────────────────────────────────────────────────────────

/** Why no document was produced. The stable half of the refusal; never the wording. */
export type MonthlyPlanFahrtenbuchBlockedReason =
  | 'no_trips'
  | 'no_columns'
  | 'no_driver_column'
  | 'unknown_block'
  | 'trip_in_two_blocks'
  | 'no_import';

/**
 * The document could not be built, and says which condition stopped it.
 *
 * Thrown, not returned, and for the reason `FahrtenbuchExportBlockedError`
 * already records: a thrown message is what a caller's catch puts on screen,
 * while a returned flag is what two of three call sites of the legacy exporter
 * drop on the floor. The sentence is German because it is rendered as-is; key a
 * translation off `reason`.
 */
export class MonthlyPlanFahrtenbuchBlockedError extends Error {
  readonly reason: MonthlyPlanFahrtenbuchBlockedReason;

  constructor(reason: MonthlyPlanFahrtenbuchBlockedReason, message: string) {
    super(message);
    this.name = 'MonthlyPlanFahrtenbuchBlockedError';
    this.reason = reason;
  }
}

// ── small pure helpers ─────────────────────────────────────────────────────

/**
 * `buildOriginalSheet`'s `cellValue`, and the same choice of `null` over `''`:
 * `aoa_to_sheet` writes no cell for null, which is what reproduces an empty
 * source cell. A third site of this four-line normaliser is not wanted — it is
 * duplicated here only because the other copy lives in a module that imports the
 * Supabase client, and importing that would make this file's test unloadable in
 * the `node` environment the suite runs in (`backup.ts` records the same trap).
 */
function cellValue(value: unknown): PlannedFahrtenbuchCell {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  return String(value);
}

/** Days in a 1-based month, by UTC arithmetic so no DST transition can shift it. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `DD.MM.YYYY HH:MM` in the operator's own zone.
 *
 * Written out rather than `toLocaleString('de-DE')`, which zero-pads neither the
 * day nor the month in every runtime and would print `30.9.2026` — and the
 * product's rule is `DD.MM.YYYY`, never a US order and never a short form. This
 * is a generated document's own German text, which is why it lives in an export
 * module and not in the dictionaries.
 */
export function formatPlanungTimestamp(when: Date): string {
  const day = pad2(when.getDate());
  const month = pad2(when.getMonth() + 1);
  return `${day}.${month}.${when.getFullYear()} ${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
}

/**
 * `01.10.2026 – 31.10.2026`.
 *
 * A date range rather than a month name, so this module needs no fifth copy of a
 * German month-name list, and the reader is told exactly which days the plan
 * covers. `DD.MM.YYYY` on both ends, never a US order.
 */
export function formatPlanungPeriod(year: number, month: number): string {
  return `01.${pad2(month)}.${year} – ${pad2(daysInMonth(year, month))}.${pad2(month)}.${year}`;
}

/** `monthly_plans.status` in German. An unknown value is printed, never dropped. */
export function planStatusLabel(status: string | null): string {
  if (status === 'draft') return 'Entwurf';
  if (status === 'confirmed') return 'Bestätigt';
  if (status === 'superseded') return 'Ersetzt';
  return status && status.trim().length > 0 ? status : 'Unbekannt';
}

/**
 * A tab label that is safe *and* not already taken.
 *
 * `book_append_sheet` throws on a duplicate (xlsx 0.20.3, `xlsx.js:27683`). Its
 * own comparison is case-sensitive; Excel's uniqueness is not, so this compares
 * folded and a `Planung` tab still forces a rename. The suffix is applied before
 * `safeSheetName` runs again, so the 31-character cap still holds.
 */
export function distinctSheetName(desired: string, taken: readonly string[]): string {
  const used = new Set(taken.map(name => name.toLowerCase()));
  let candidate = safeSheetName(desired);
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = `_${n}`;
    candidate = safeSheetName(candidate.slice(0, 31 - suffix.length) + suffix);
  }
  return candidate;
}

/**
 * The file's own order: `source_row_index`, then the ride's day and start, then
 * the id so the sort is total. The same order the legacy exporter reads its trips
 * in — but decided *here*, because a pure builder's output must be determined by
 * its input and not by the order a query happened to return.
 */
function orderTrips(trips: readonly ImportedTripRowForExport[]): ImportedTripRowForExport[] {
  return [...trips].sort((a, b) => {
    const ai = a.source_row_index;
    const bi = b.source_row_index;
    if (ai !== null && bi !== null && ai !== bi) return ai - bi;
    // A row without a source index sorts after every row that has one.
    if (ai !== null && bi === null) return -1;
    if (ai === null && bi !== null) return 1;
    const ad = a.trip_date ?? '';
    const bd = b.trip_date ?? '';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const as = a.start_time ?? '';
    const bs = b.start_time ?? '';
    if (as !== bs) return as < bs ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ── the builder ────────────────────────────────────────────────────────────

/**
 * The document, from the plan's rows and the import's original data.
 *
 * Pure: no network, no DOM, no clock. Every refusal is a
 * `MonthlyPlanFahrtenbuchBlockedError`; everything the requirement expects to be
 * incomplete comes back in `completeness` and is written onto the PLANUNG sheet.
 */
export function buildPlannedFahrtenbuch(input: PlannedFahrtenbuchInput): PlannedFahrtenbuchSheet {
  const { meta } = input;

  const headers = input.headers.filter(h => typeof h === 'string' && h.length > 0);
  if (headers.length === 0) {
    throw new MonthlyPlanFahrtenbuchBlockedError(
      'no_columns',
      'Die Spalten der Originaldatei konnten nicht ermittelt werden. Es wurde kein geplantes Fahrtenbuch erstellt.',
    );
  }

  const trips = orderTrips(input.trips);
  if (trips.length === 0) {
    throw new MonthlyPlanFahrtenbuchBlockedError(
      'no_trips',
      'Der gewählte Import enthält keine Fahrten. Es wurde kein geplantes Fahrtenbuch erstellt.',
    );
  }

  const driverColumn = findDriverColumn([...headers]);
  if (!driverColumn) {
    // Without this column nothing can be replaced, so the file would be the
    // import itself under a PLANUNG name — a document that claims to be a plan
    // and is not. The name matching is `fahrtenbuchExport`'s own, imported rather
    // than copied. Its value-matching fallback — comparing a cell against the
    // ride's original driver, which only `monatsplanungXlsxExport` has — is
    // deliberately not copied either: it would be a second site of that
    // heuristic, and all 13,959 rows measured on production and staging carry
    // `Fahrername` by name, so a refusal that says so beats a duplicated guess.
    throw new MonthlyPlanFahrtenbuchBlockedError(
      'no_driver_column',
      'In den Spalten der Originaldatei wurde keine Fahrername-Spalte gefunden. '
      + 'Ohne sie kann kein geplanter Fahrer eingetragen werden.',
    );
  }
  const driverColumnIndex = headers.indexOf(driverColumn);
  if (driverColumnIndex < 0) {
    // `findDriverColumn` returns an element of the array it was given, so this
    // is unreachable today. It is a refusal and not an `if (i >= 0)` around the
    // assignment on purpose: `cells[-1] = name` adds a property named "-1",
    // writes no cell, and would ship the import untouched under a PLANUNG name.
    throw new MonthlyPlanFahrtenbuchBlockedError(
      'no_driver_column',
      'Die Fahrername-Spalte konnte den Original-Spalten nicht zugeordnet werden. '
      + 'Es wurde kein geplantes Fahrtenbuch erstellt.',
    );
  }

  const blocksById = new Map<string, PlanBlockRowForExport>();
  for (const block of input.blocks) blocksById.set(block.id, block);

  // trip → its block. A ride in two blocks and a block that is not in the set
  // are both refusals: the first is §23, the second means the blocks read was
  // truncated, and a truncated read reads exactly like "these rides are
  // unassigned" — the one failure that must never be shown as a figure.
  const blockByTripId = new Map<string, PlanBlockRowForExport>();
  for (const link of input.blockTrips) {
    const block = blocksById.get(link.block_id);
    if (!block) {
      throw new MonthlyPlanFahrtenbuchBlockedError(
        'unknown_block',
        'Die Blöcke des Plans konnten nicht vollständig gelesen werden. '
        + 'Ein unvollständig gelesener Plan sieht wie ein Plan ohne Zuweisungen aus, deshalb wird kein Dokument erstellt.',
      );
    }
    const already = blockByTripId.get(link.trip_id);
    if (already && already.id !== block.id) {
      throw new MonthlyPlanFahrtenbuchBlockedError(
        'trip_in_two_blocks',
        'Eine Fahrt ist zwei Blöcken zugeordnet. Welcher Fahrer gelten soll, ist damit nicht bestimmt, '
        + 'deshalb wird kein Dokument erstellt.',
      );
    }
    blockByTripId.set(link.trip_id, block);
  }

  let plannedRows = 0;
  let canceledRows = 0;
  let notInPlanRows = 0;
  let unassignedBlockRows = 0;
  let canceledInPlanRows = 0;

  const rows: PlannedFahrtenbuchRow[] = trips.map(trip => {
    const raw = (trip.raw_data_json ?? {}) as Record<string, unknown>;
    // The rule: every column verbatim from the imported row. Only the cell
    // below may ever differ.
    const cells = headers.map(header => cellValue(raw[header]));

    const originalDriverName = trip.original_driver_name ?? '';
    const isCanceled = trip.is_canceled === true;
    const block = blockByTripId.get(trip.id) ?? null;

    if (isCanceled) canceledRows++;
    if (isCanceled && block) canceledInPlanRows++;

    // A cancelled ride is never reassigned and never counted. Same guard as
    // `buildOriginalSheet`, and it comes first so a cancelled ride inside a
    // block is recorded and still left alone.
    let keptOriginalReason: KeptOriginalReason | null = null;
    if (isCanceled) {
      keptOriginalReason = 'canceled';
    } else if (!block) {
      keptOriginalReason = 'not_in_plan';
      notInPlanRows++;
    } else if (!block.driver_id || !block.driver_name || block.driver_name.trim().length === 0) {
      // §8: a block may be left unassigned with a warning rather than break a
      // constraint. Its rides keep the imported driver.
      keptOriginalReason = 'block_unassigned';
      unassignedBlockRows++;
    }

    let driverName = originalDriverName;
    let driverSource: PlannedDriverSource = 'original';
    if (keptOriginalReason === null && block && block.driver_name) {
      driverName = block.driver_name;
      driverSource = 'plan';
      cells[driverColumnIndex] = driverName;
      plannedRows++;
    }

    return {
      tripId: trip.id,
      cells,
      driverName,
      driverSource,
      originalDriverName,
      keptOriginalReason,
      isCanceled,
      blockKey: block ? block.block_key : null,
    };
  });

  const completeness: PlannedFahrtenbuchCompleteness = {
    totalRows: rows.length,
    plannedRows,
    keptOriginalRows: rows.length - plannedRows,
    canceledRows,
    notInPlanRows,
    unassignedBlockRows,
    canceledInPlanRows,
    driverColumn,
    complete: notInPlanRows === 0 && unassignedBlockRows === 0 && canceledInPlanRows === 0,
  };

  const banner =
    `${PLANUNG_BANNER} · Zeitraum: ${formatPlanungPeriod(meta.year, meta.month)}`
    + ` · Erstellt am: ${formatPlanungTimestamp(meta.generatedAt)}`
    + ' · Vorschlag für einen Monat, der noch nicht stattgefunden hat. Keine Aufzeichnung.';

  const sheetName = safeSheetName(meta.sourceSheetName);
  const metaSheetName = distinctSheetName(PLANUNG_SHEET_NAME, [sheetName]);

  const sheetRows: PlannedFahrtenbuchCell[][] = [
    [banner],
    [...headers],
    ...rows.map(row => row.cells),
  ];

  return {
    headers: [...headers],
    rows,
    sheetRows,
    banner,
    sheetName,
    metaSheetName,
    metaRows: buildMetaRows(banner, meta, completeness),
    fileName: `Fahrtenbuch_PLANUNG_${meta.year}-${pad2(meta.month)}.xlsx`,
    completeness,
  };
}

/**
 * The PLANUNG sheet: the banner again, what the plan was made with, and the
 * completeness figures.
 *
 * These figures are written into the file and not only returned, so a caller
 * that drops the result — which is what two of three call sites of the legacy
 * exporter do — still ships a document that says how many rides kept their
 * original driver.
 */
function buildMetaRows(
  banner: string,
  meta: PlannedFahrtenbuchMeta,
  completeness: PlannedFahrtenbuchCompleteness,
): PlannedFahrtenbuchCell[][] {
  const rows: PlannedFahrtenbuchCell[][] = [
    [PLANUNG_BANNER],
    [banner],
    [],
    ['Zeitraum', formatPlanungPeriod(meta.year, meta.month)],
    ['Erstellt am', formatPlanungTimestamp(meta.generatedAt)],
    ['Status der Planung', planStatusLabel(meta.planStatus)],
    // `??` and never `||`: 0 is a legal switch duration and means "split at
    // every gap", which `buildBlocks` states in so many words. `||` would print
    // it as "nicht erfasst".
    ['Wechseldauer (Minuten)', meta.switchMinutes ?? 'nicht erfasst'],
    ['Variante (Neu generieren)', meta.generation ?? 'nicht erfasst'],
    ['Quelldatei des Imports', meta.sourceFileName ?? 'nicht erfasst'],
    ['Fahrername-Spalte', completeness.driverColumn],
    [],
    ['Zeilen insgesamt', completeness.totalRows],
    ['Davon mit geplantem Fahrer', completeness.plannedRows],
    ['Davon mit Originalfahrer', completeness.keptOriginalRows],
    ['  davon storniert (nie zugewiesen)', completeness.canceledRows],
    ['  davon keinem Block zugeordnet', completeness.notInPlanRows],
    ['  davon Block ohne Fahrer', completeness.unassignedBlockRows],
    [],
  ];

  if (completeness.canceledInPlanRows > 0) {
    rows.push([
      'Warnung',
      `${completeness.canceledInPlanRows} stornierte Fahrt(en) liegen in einem Block. `
      + 'Der Fahrer wurde dort nicht ersetzt. Bitte Plan und Import prüfen.',
    ]);
  }

  // The two reasons a *plannable* ride kept its original driver. A cancelled ride
  // inside a block makes the plan incomplete too, but it is not one of these, and
  // saying "0 Fahrten" beside a warning would read as a contradiction.
  const keptForPlanReasons = completeness.notInPlanRows + completeness.unassignedBlockRows;
  if (completeness.complete) {
    rows.push(['Vollständigkeit', 'Jede nicht stornierte Fahrt trägt einen geplanten Fahrer.']);
  } else if (keptForPlanReasons > 0) {
    rows.push([
      'Vollständigkeit',
      `${keptForPlanReasons} nicht stornierte Fahrt(en) tragen weiterhin den Originalfahrer, `
      + 'weil sie keinem Block oder einem Block ohne Fahrer angehören.',
    ]);
  } else {
    rows.push([
      'Vollständigkeit',
      'Jede nicht stornierte Fahrt trägt einen geplanten Fahrer. Die Warnung oben gilt trotzdem.',
    ]);
  }

  rows.push(
    [],
    [
      'Hinweis',
      'Erzeugt aus den Originaldaten des Imports. Alle Zeiten, Fahrzeuge, Kilometer, Orte und Beträge '
      + 'stehen unverändert wie importiert. Geändert wurde ausschließlich die Spalte '
      + `"${completeness.driverColumn}". Am Fahrtenbuch selbst wurde nichts gespeichert.`,
    ],
  );

  return rows;
}

// ── the thin download ──────────────────────────────────────────────────────

/** What the caller needs after the file was written. */
export interface PlannedFahrtenbuchExportResult {
  fileName: string;
  sheetName: string;
  completeness: PlannedFahrtenbuchCompleteness;
}

/** The plan the document is built from. `import_id` is nullable lineage. */
export interface MonthlyPlanForExport {
  id: string;
  company_id: string;
  year: number;
  month: number;
  status: string | null;
  switch_minutes: number | null;
  generation: number | null;
  import_id: string | null;
}

interface QueryAnswer {
  data: unknown[] | null;
  error: { message: string } | null;
}

/**
 * The reads this module makes. A hand-written surface, and a `client` argument,
 * for `backup.ts`'s stated reason: a static `import { supabase }` pulls in a
 * module that reads `window` at load time, and the whole vitest suite runs in the
 * `node` environment — so the file under test could not even be loaded.
 */
export interface MonthlyPlanExportClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        order(column: string, options: { ascending: boolean }): {
          range(from: number, to: number): PromiseLike<QueryAnswer>;
        };
      };
    };
  };
}

async function loadPaged<Row>(
  client: MonthlyPlanExportClient,
  table: string,
  columns: string,
  filterColumn: string,
  filterValue: string,
  label: string,
): Promise<Row[]> {
  return fetchAllPaginated<Row>(
    (from, to) =>
      client
        .from(table)
        .select(columns)
        .eq(filterColumn, filterValue)
        // Ordered by the primary key: paging without a unique sort can repeat or
        // skip rows across page boundaries. The document's own order is decided
        // in `orderTrips`, not here.
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
    { label },
  );
}

/**
 * Read the plan's rows and the import's original data, and build the document.
 *
 * Separate from the download because §1's fourth screen asks for a **preview**
 * as well, and no screen previews a corrected Fahrtenbuch today. A preview calls
 * this and renders `sheet.rows`; the download calls this and writes the workbook.
 * One load, one builder, one set of rows — so the table and the file cannot show
 * different drivers.
 *
 * Reads only. A failed page throws out of `fetchAllPaginated` rather than
 * counting as the end of the list, because a truncated month would produce a
 * document in which every figure is plausible and wrong.
 */
export async function loadPlannedFahrtenbuch(
  plan: MonthlyPlanForExport,
  options: { client?: MonthlyPlanExportClient; generatedAt?: Date } = {},
): Promise<PlannedFahrtenbuchSheet> {
  if (!plan.import_id) {
    throw new MonthlyPlanFahrtenbuchBlockedError(
      'no_import',
      'Zu diesem Plan ist kein Fahrtenbuch-Import hinterlegt. '
      + 'Ohne die Originaldaten kann kein geplantes Fahrtenbuch erstellt werden.',
    );
  }

  const client: MonthlyPlanExportClient =
    options.client
    ?? ((await import('../lib/supabase')).supabase as unknown as MonthlyPlanExportClient);

  const [blocks, blockTrips, trips, importRow] = await Promise.all([
    loadPaged<PlanBlockRowForExport>(
      client,
      'monthly_plan_blocks',
      'id, block_key, driver_id, driver_name',
      'plan_id',
      plan.id,
      'Blöcke',
    ),
    loadPaged<PlanBlockTripRowForExport>(
      client,
      'monthly_plan_block_trips',
      'id, block_id, trip_id',
      'plan_id',
      plan.id,
      'Fahrten der Blöcke',
    ),
    loadPaged<ImportedTripRowForExport>(
      client,
      'fahrtenbuch_trips',
      'id, is_canceled, original_driver_name, raw_data_json, source_row_index, trip_date, start_time',
      'import_id',
      plan.import_id,
      'Fahrten',
    ),
    loadPaged<{ id: string; file_name: string | null; source_columns_json: string[] | null; source_sheet_name: string | null }>(
      client,
      'fahrtenbuch_imports',
      'id, file_name, source_columns_json, source_sheet_name',
      'id',
      plan.import_id,
      'Import',
    ),
  ]);

  const source = importRow[0] ?? null;
  const headers = (source?.source_columns_json ?? []).filter(
    (header): header is string => typeof header === 'string' && header.length > 0,
  );

  return buildPlannedFahrtenbuch({
    headers,
    trips,
    blocks,
    blockTrips,
    meta: {
      year: plan.year,
      month: plan.month,
      planStatus: plan.status,
      switchMinutes: plan.switch_minutes,
      generation: plan.generation,
      sourceFileName: source?.file_name ?? null,
      sourceSheetName: source?.source_sheet_name ?? null,
      generatedAt: options.generatedAt ?? new Date(),
    },
  });
}

/** Read, build and hand the file to the browser. */
export async function downloadMonthlyPlanFahrtenbuch(
  plan: MonthlyPlanForExport,
  options: { client?: MonthlyPlanExportClient; generatedAt?: Date } = {},
): Promise<PlannedFahrtenbuchExportResult> {
  const sheet = await loadPlannedFahrtenbuch(plan, options);
  writePlannedFahrtenbuchWorkbook(sheet);
  return {
    fileName: sheet.fileName,
    sheetName: sheet.sheetName,
    completeness: sheet.completeness,
  };
}

/**
 * The workbook, from a built sheet.
 *
 * Separate from the write so a test can cover it: both `book_append_sheet`
 * calls, which throw on a name the library refuses and on a duplicate, and the
 * number-format offset below, which is the one arithmetic in this module that a
 * reviewer cannot check by reading.
 */
export function buildPlannedFahrtenbuchWorkbook(sheet: PlannedFahrtenbuchSheet): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  // The label a fourth time, in the file's own properties, where it survives a
  // renamed file and a deleted tab.
  wb.Props = { Title: `Fahrtenbuch — ${PLANUNG_BANNER}` };

  const ws = XLSX.utils.aoa_to_sheet(sheet.sheetRows);
  // A source cell Excel held as a date arrived as a serial (the importer reads
  // with `raw: true`) and would otherwise be delivered as that serial.
  // `applySourceCellFormats` skips exactly one row — its `r + 1` — so it is
  // handed `sheetRows` without the banner: index 0 is then the header row, whose
  // cells are strings and which the rule passes over anyway, and index 1 is the
  // first data row, at sheet row 2. The shared helper is not edited for the extra
  // offset; every other caller depends on its contract.
  applySourceCellFormats(ws, sheet.headers, sheet.sheetRows.slice(1));
  XLSX.utils.book_append_sheet(wb, ws, sheet.sheetName);

  const wsMeta = XLSX.utils.aoa_to_sheet(sheet.metaRows);
  wsMeta['!cols'] = [{ wch: 36 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, wsMeta, sheet.metaSheetName);

  return wb;
}

/** Build and hand the file to the browser. The one call a test cannot make. */
export function writePlannedFahrtenbuchWorkbook(sheet: PlannedFahrtenbuchSheet): void {
  XLSX.writeFile(buildPlannedFahrtenbuchWorkbook(sheet), sheet.fileName);
}
