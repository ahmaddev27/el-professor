/**
 * The earnings leg of the one-button import: every day Uber holds for the fleet,
 * from its first earnings to the last completed operating day, one income row
 * set per driver per day.
 *
 * ## Why it runs in the browser, in small pieces
 *
 * The edge runtime ends a worker at 60 s (`workerTimeoutMs`, main/index.ts), and
 * roughly 190 days of Uber data is hundreds of calls. So no single request tries:
 * each asks `uber-earnings-pull` for at most three days (`MAX_DAY_MODE_DAYS`) and
 * writes them with `income_import_uber` in the caller's own session, exactly as
 * the Umsätze dialog does. Pieces are sequential, with a pause between them.
 *
 * ## Resume without a progress table
 *
 * Every piece is one all-or-nothing transaction, so the income table itself is
 * the progress record: the newest `source_period_end` of an `uber` row is the
 * last day done, and the next click starts the day after it. Nothing is stored
 * that could disagree with the rows. A day with no earnings writes no row, so a
 * stretch of such days at the very end is asked about again; that costs a call
 * and never a duplicate row.
 *
 * ## Where "the beginning" comes from
 *
 * It is found, not assumed: whole weeks are probed backwards from the last
 * completed day until `PROBE_EMPTY_WEEKS` weeks in a row hold nothing, and the
 * Monday of the oldest week that held something is the start. Data older than a
 * gap that long is not found; the limit is stated so it can be changed.
 *
 * ## What it never does
 *
 * It never replaces (`p_replace` is not sent), so the unique index and the
 * overlap check stay the only judges of a duplicate. It does not start when the
 * company already has hand-typed income, because the import does not refuse
 * those and both sets would then stand, doubling the salary basis.
 *
 * ## An earner nobody linked gets a named home; an earner Reidey cannot place does not
 *
 * Two causes used to stop the import alike, and they are different things:
 *
 * - `unlinked_here`: Reidey sent the earner's money under its own driver id and
 *   we hold no link for that id (typically a driver who left the fleet and so is
 *   not in the roster the driver import reads, which can therefore never link
 *   them). The money exists and has an address. `deps.resolve` links the driver
 *   of the company with the same name, or creates an INACTIVE one, and the
 *   import goes on; every driver it created is reported on the outcome.
 * - `unmatched_at_reidey`: Reidey could not resolve the Uber earner to any
 *   driver of its own, so it sends NO money and no id for them. There is
 *   nothing to attach to a driver, and creating one would only hide that the
 *   earnings are missing. They used to stop the run, which protected nothing
 *   (no money was ever in play for them) and withheld every matched driver's
 *   history for good when the earner had left the fleet. Owner, 16.10.2026:
 *   the earnings must be pulled. So the run imports what Reidey sent and the
 *   outcome carries these earners (`unmatched`, with their trip counts) and the
 *   status `gap`, which is never a clean success: the money for them did not
 *   arrive and the operator is told so by name. Like the created drivers, the
 *   list survives a later piece failing.
 *
 * A gap is reported by the run that met it. Resume has no state, so a later
 * click that starts after those days does not see the earner again.
 */
import type { TranslationKey } from '../i18n';
import {
  addDaysIso,
  mondayOf,
  type UnmatchedEarner,
} from '../../supabase/functions/_shared/uber-earnings-core';
import { completedOperatingDay } from '../../supabase/functions/_shared/uber-pull-core';
import {
  buildImportRows,
  findUnlinked,
  type DriverLinks,
  type IncomeImportRow,
  type UnlinkedDriver,
  type WeekEarnings,
} from '../utils/uberEarningsImport';

/** Weeks in a row with no earnings that end the backward search. */
export const PROBE_EMPTY_WEEKS = 8;
/** A stop, not a limit anyone should reach: ten years of weeks. */
export const MAX_PROBE_WEEKS = 520;
/** Days asked per request; equals `MAX_DAY_MODE_DAYS` in the shared core. */
export const DAYS_PER_PIECE = 3;

export type PullResult =
  | { ok: true; weeks: WeekEarnings[]; links: DriverLinks; unmatched: UnmatchedEarner[] }
  | { ok: false; reason: TranslationKey; detail?: string };

export type WriteResult =
  | { ok: true; inserted: number }
  | { ok: false; reason: TranslationKey; detail?: string };

/** What `partner_earners_resolve` did for the earners it was given. */
export type ResolveResult =
  | {
    ok: true;
    /** Drivers the call created (inactive), by the name now stored. */
    created: string[];
    /** Drivers of the company the earners were linked to by name. */
    linked: string[];
    /** Earners it could not place, with the name the partner gave. */
    skipped: string[];
  }
  | { ok: false; reason: TranslationKey; detail?: string };

/** The drivers an import made or matched on its own, for the operator to check. */
/** An Uber earner Reidey could not place: no earnings arrived for them. */
export interface UnmatchedGap {
  name: string;
  uberDriverUuid: string | null;
  /** Summed over the pieces that named them; null when Reidey sent no count. */
  trips: number | null;
}

export interface Findings {
  /** Earners for whom no earnings were imported. */
  unmatched: UnmatchedGap[];
  created: string[];
  linked: string[];
}

export interface BackfillState {
  /** Newest `source_period_end` of an Uber row, or null for none. */
  latestEnd: string | null;
  /** Income rows somebody typed (`source IS NULL`). */
  manualRows: number;
}

export interface BackfillDeps {
  now(): Date;
  /** null when the income table could not be read: never treated as "empty". */
  readState(): Promise<BackfillState | null>;
  pull(from: string, to: string, granularity: 'week' | 'day'): Promise<PullResult>;
  write(rows: IncomeImportRow[]): Promise<WriteResult>;
  resolve(earners: UnlinkedDriver[]): Promise<ResolveResult>;
  sleep(ms: number): Promise<void>;
  shouldStop(): boolean;
}

export type BackfillProgress =
  | { phase: 'looking'; weeksChecked: number }
  | { phase: 'importing'; day: string; last: string; rows: number };

export type EarningsOutcome =
  | ({ status: 'done'; from: string; to: string; days: number; rows: number; resumed: boolean } & Findings)
  /** Everything Reidey sent is imported, and at least one earner had nothing to import: not a clean success. */
  | ({ status: 'gap'; from: string; to: string; days: number; rows: number; resumed: boolean } & Findings)
  | { status: 'nothing' }
  /** Not started, on purpose: the company has income of its own. */
  | { status: 'unavailable'; reason: TranslationKey }
  | ({ status: 'stopped'; through: string | null; rows: number } & Findings)
  | ({
    status: 'failed'; reason: TranslationKey; detail?: string;
    /** Last day that is safely in the table, or null when nothing was written. */
    through: string | null; rows: number;
  } & Findings);

const NONE: Findings = { created: [], linked: [], unmatched: [] };

const sameEarner = (a: UnmatchedGap, b: UnmatchedEarner) =>
  a.uberDriverUuid !== null && b.uberDriverUuid !== null ? a.uberDriverUuid === b.uberDriverUuid : a.name === b.name;

/** Adds one piece's unmatched earners; an earner met again has their trips summed. */
function noteUnmatched(findings: Findings, earners: readonly UnmatchedEarner[]): void {
  for (const earner of earners) {
    const known = findings.unmatched.find(g => sameEarner(g, earner));
    if (!known) {
      findings.unmatched.push({ name: earner.name, uberDriverUuid: earner.uberDriverUuid, trips: earner.trips });
    } else if (earner.trips !== null) {
      known.trips = (known.trips ?? 0) + earner.trips;
    }
  }
}

const PAUSE_MS = 300;

const hasEarnings = (weeks: readonly WeekEarnings[], unmatched: readonly UnmatchedEarner[]) =>
  unmatched.length > 0 || buildImportRows(weeks).length > 0;

type Found = { ok: true; start: string | null } | { ok: false; outcome: EarningsOutcome };

async function findStart(
  deps: BackfillDeps, through: string, report: (p: BackfillProgress) => void,
): Promise<Found> {
  let monday = mondayOf(through);
  let earliest: string | null = null;
  let empty = 0;
  for (let checked = 0; empty < PROBE_EMPTY_WEEKS && checked < MAX_PROBE_WEEKS; checked++) {
    if (deps.shouldStop()) return { ok: false, outcome: { status: 'stopped', through: null, rows: 0, ...NONE } };
    report({ phase: 'looking', weeksChecked: checked });
    const sunday = addDaysIso(monday, 6);
    const pulled = await deps.pull(monday, sunday > through ? through : sunday, 'week');
    if (!pulled.ok) {
      return { ok: false, outcome: { status: 'failed', reason: pulled.reason, detail: pulled.detail, through: null, rows: 0, ...NONE } };
    }
    if (hasEarnings(pulled.weeks, pulled.unmatched)) { earliest = monday; empty = 0; } else empty++;
    monday = addDaysIso(monday, -7);
    await deps.sleep(PAUSE_MS);
  }
  return { ok: true, start: earliest };
}

export async function runEarningsBackfill(
  deps: BackfillDeps, report: (p: BackfillProgress) => void = () => {},
): Promise<EarningsOutcome> {
  const state = await deps.readState();
  if (!state) return { status: 'failed', reason: 'import.earnings.stateUnreadable', through: null, rows: 0, ...NONE };
  const through = completedOperatingDay(deps.now());
  const resumed = state.latestEnd !== null;
  let start: string | null;
  if (resumed) {
    start = addDaysIso(state.latestEnd as string, 1);
  } else {
    if (state.manualRows > 0) return { status: 'unavailable', reason: 'import.earnings.manualExists' };
    const found = await findStart(deps, through, report);
    if (!found.ok) return found.outcome;
    start = found.start;
    if (start === null) return { status: 'nothing' };
  }
  if (start > through) return { status: 'done', from: through, to: through, days: 0, rows: 0, resumed, ...NONE };
  return importDays(deps, start, through, resumed, report);
}

async function importDays(
  deps: BackfillDeps, start: string, through: string, resumed: boolean,
  report: (p: BackfillProgress) => void,
): Promise<EarningsOutcome> {
  let done: string | null = null;
  let rowCount = 0;
  let days = 0;
  const drivers: Findings = { created: [], linked: [], unmatched: [] };
  for (let day = start; day <= through; day = addDaysIso(day, DAYS_PER_PIECE)) {
    if (deps.shouldStop()) return { status: 'stopped', through: done, rows: rowCount, ...drivers };
    const reach = addDaysIso(day, DAYS_PER_PIECE - 1);
    const last = reach > through ? through : reach;
    report({ phase: 'importing', day, last, rows: rowCount });
    const piece = await importPiece(deps, day, last, drivers);
    if (!piece.ok) {
      return { status: 'failed', reason: piece.reason, detail: piece.detail, through: done, rows: rowCount, ...drivers };
    }
    rowCount += piece.rows;
    days += piece.days;
    done = last;
    await deps.sleep(PAUSE_MS);
  }
  const status = drivers.unmatched.length > 0 ? 'gap' : 'done';
  return { status, from: start, to: through, days, rows: rowCount, resumed, ...drivers };
}

type Piece =
  | { ok: true; rows: number; days: number }
  | { ok: false; reason: TranslationKey; detail?: string };

/**
 * Gives the earners with no link a driver and records what that made. A driver
 * created here stays created even when a later piece fails, so it is added to
 * `drivers` the moment the database answers.
 */
async function placeUnlinked(
  deps: BackfillDeps, unlinked: UnlinkedDriver[], drivers: Findings,
): Promise<Extract<Piece, { ok: false }> | null> {
  const resolved = await deps.resolve(unlinked);
  if (!resolved.ok) return resolved;
  drivers.created.push(...resolved.created);
  drivers.linked.push(...resolved.linked);
  if (resolved.skipped.length === 0) return null;
  return { ok: false, reason: 'import.earnings.unresolved', detail: resolved.skipped.join(', ') };
}

async function importPiece(
  deps: BackfillDeps, from: string, to: string, drivers: Findings,
): Promise<Piece> {
  const pulled = await deps.pull(from, to, 'day');
  if (!pulled.ok) return pulled;
  noteUnmatched(drivers, pulled.unmatched);
  const unlinked = findUnlinked(pulled.weeks, pulled.links);
  if (unlinked.length > 0) {
    const refused = await placeUnlinked(deps, unlinked, drivers);
    if (refused) return refused;
  }
  const rows = buildImportRows(pulled.weeks);
  const days = pulled.weeks.length;
  if (rows.length === 0) return { ok: true, rows: 0, days };
  const written = await deps.write(rows);
  return written.ok ? { ok: true, rows: written.inserted, days } : written;
}
