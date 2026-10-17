/**
 * Which columns of a generic list export end up in the file, and in what order.
 *
 * Pure: no React, no DOM beyond an injected `Storage`. The dialog in
 * `components/export/` draws it; `applyColumnSelection` is the only thing that
 * reaches the writer, and it hands `exportTableToExcel` the same `ExportOptions`
 * it always took, with fewer columns. The writer stays a dumb writer.
 *
 * THE BOUNDARY. This module is for `exportTableToExcel` / `exportSheetsToExcel`
 * dumps only. Statutory documents (Stundennachweis PDF, the Fahrtenbuch XLSX with
 * its byte-for-byte `'original'` mode, the Quittungen, the Mietwagenauftrag, the
 * legal pages) must never be offered a picker: their content is fixed by law.
 * `exportColumnPickerBoundary.test.ts` reads the source and fails if one of
 * their builders touches this module.
 */
import type { ExportColumn, ExportOptions } from './excelExport';

/** What a user said last time for one table. `known` is what they could see. */
export interface RememberedChoice {
  /** The chosen keys, in the chosen order. */
  selected: string[];
  /** Every key on offer when the choice was saved; tells "unticked" from "new". */
  known: string[];
}

export type SelectionProblem = 'empty';

export const STORAGE_PREFIX = 'exportColumns:v1:';

/**
 * The selection a dialog opens with.
 *
 * - no memory: every column, in the table's own order;
 * - a remembered key the table no longer offers is ignored;
 * - a key the memory has never seen (not in `known`) is INCLUDED — a column
 *   nobody has looked at yet must not vanish from an export — and goes where
 *   the table puts it, after the columns that precede it in the table order.
 */
export function resolveInitialSelection(available: readonly string[], remembered: RememberedChoice | null): string[] {
  if (!remembered) return [...available];
  const offered = new Set(available);
  const known = new Set(remembered.known);
  const kept = remembered.selected.filter((key, i, all) => offered.has(key) && all.indexOf(key) === i);
  const fresh = available.filter(key => !known.has(key));
  // A remembered choice that now matches nothing at all would open an empty,
  // refused dialog; fall back to everything rather than strand the user.
  const merged = [...kept, ...fresh];
  return merged.length > 0 ? merged : [...available];
}

export function validateSelection(selected: readonly string[]): SelectionProblem | null {
  return selected.length === 0 ? 'empty' : null;
}

/**
 * The options the writer receives for a chosen set of columns.
 *
 * Totals are reduced to the columns that are in the file. The writer refuses a
 * figure keyed to the FIRST column (that cell is the row's label), and a column
 * can become first by what is left of the others; its figure is dropped rather
 * than throwing on a click — the label stays, the figure is absent, never wrong.
 */
export function applyColumnSelection(opts: ExportOptions, selected: readonly string[]): ExportOptions {
  const byKey = new Map(opts.columns.map(col => [col.key, col] as const));
  const columns = selected.flatMap(key => {
    const col = byKey.get(key);
    return col ? [col] : [];
  });
  if (columns.length === 0) throw new Error('applyColumnSelection: no column selected');
  return { ...opts, columns, totals: opts.totals ? reduceTotals(opts.totals, columns) : opts.totals };
}

function reduceTotals(totals: Record<string, string | number>, columns: ExportColumn[]): Record<string, string | number> {
  const first = columns[0].key;
  const present = new Set(columns.map(col => col.key));
  return Object.fromEntries(Object.entries(totals).filter(([key]) => present.has(key) && key !== first));
}

/** Moves one entry by `delta` places, clamped; returns a new array. */
export function moveKey(keys: readonly string[], key: string, delta: -1 | 1): string[] {
  const from = keys.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= keys.length) return [...keys];
  const next = [...keys];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * The full list the dialog shows: chosen columns first, in order, then the ones
 * left out in the table's own order — so a ticked column can be moved and an
 * unticked one is still there to tick again.
 */
export function orderForDisplay(available: readonly string[], selected: readonly string[]): string[] {
  const chosen = new Set(selected);
  return [...selected, ...available.filter(key => !chosen.has(key))];
}

// ── Memory ───────────────────────────────────────────────────────────────────

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function loadRemembered(tableId: string, storage: Storage | null = storageOrNull()): RememberedChoice | null {
  try {
    const raw = storage?.getItem(STORAGE_PREFIX + tableId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { selected, known } = parsed as Partial<RememberedChoice>;
    return isStringArray(selected) && isStringArray(known) ? { selected, known } : null;
  } catch {
    return null;
  }
}

/** Best effort: a refused write must never stop the export itself. */
export function saveRemembered(
  tableId: string,
  choice: RememberedChoice,
  storage: Storage | null = storageOrNull(),
): void {
  try {
    storage?.setItem(STORAGE_PREFIX + tableId, JSON.stringify(choice));
  } catch {
    /* private window, blocked site data, quota: the choice just is not kept */
  }
}
