/**
 * The Abrechnung's hand-over record, read in integer cents.
 *
 * **A record only.** What a driver handed back never reaches the Bargeldbestand:
 * `cashLedger.ts` counts a driver's cash as in the till from the day its
 * `income.type = 'bargeld'` row is dated, so booking the hand-over would count
 * the same cash twice. Nothing here imports the ledger, and
 * `abrechnungHandover.boundary.test.ts` fails if that changes.
 *
 * **The amount is stored, the status is derived.** The table holds one number,
 * what was handed over. "Given / partial / still with the driver" is computed
 * here from that number and the week's Difference (`bar_zuruck`), so no stored
 * word can contradict the figures after a week is corrected.
 *
 * The owner named two states; his own example (the driver owes 50 and has 30)
 * makes a third by necessity, so there are three, plus one for a row that owes
 * nothing:
 *
 *   given     handed over at least what is due (more is shown as an excess)
 *   partial   handed over something, but less than is due; the rest is shown
 *   open      nothing handed over: no record, or a record of 0
 *   none_due  the Difference is zero or negative (the company owes the driver,
 *             or the books are even), so there is nothing to hand over
 *
 * "No record" and "a record of 0" are different answers, and `recorded` keeps
 * them apart: the second is somebody confirming that nothing came back. Both
 * derive `open`.
 */
import { toCents } from './money';

export type HandoverStatus = 'given' | 'partial' | 'open' | 'none_due';

export interface HandoverState {
  status: HandoverStatus;
  /** What is still outstanding, in cents; 0 unless the status is partial or open. */
  remainingCents: number;
  /** What was handed over beyond what was due, in cents. */
  excessCents: number;
  /** A record exists (a hand-over of 0 counts). */
  recorded: boolean;
  givenCents: number;
  dueCents: number;
}

/**
 * The state of one row.
 *
 * @param dueCents   the row's Difference (`bar_zuruck`) in cents, negative allowed
 * @param givenCents what was recorded as handed over, or `null` for no record
 */
export function deriveHandover(dueCents: number, givenCents: number | null): HandoverState {
  const recorded = givenCents !== null;
  const given = givenCents ?? 0;
  const owed = Math.max(dueCents, 0);
  const base = { recorded, givenCents: given, dueCents };

  if (owed === 0) {
    return { ...base, status: given > 0 ? 'given' : 'none_due', remainingCents: 0, excessCents: given };
  }
  if (given >= owed) return { ...base, status: 'given', remainingCents: 0, excessCents: given - owed };
  if (given > 0) return { ...base, status: 'partial', remainingCents: owed - given, excessCents: 0 };
  return { ...base, status: 'open', remainingCents: owed, excessCents: 0 };
}

/** What the popup offers first: the whole Difference, never a negative amount. */
export function defaultHandoverCents(dueCents: number): number {
  return Math.max(dueCents, 0);
}

/** The identity of a weekly row, as the Abrechnung itself identifies it. */
export interface HandoverKey {
  year: number;
  month: number;
  week_number: number;
  driver_name: string;
}

export interface HandoverRecord extends HandoverKey {
  amount: number | string;
}

const keyOf = (k: HandoverKey) => `${k.year}|${k.month}|${k.week_number}|${k.driver_name}`;

/** Weekly records by row identity, amounts in cents. */
export function indexWeeklyHandovers(records: HandoverRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) out.set(keyOf(r), toCents(r.amount));
  return out;
}

/** The recorded cents of a weekly row, or null when nobody confirmed it. */
export function weeklyGivenCents(index: Map<string, number>, key: HandoverKey): number | null {
  return index.get(keyOf(key)) ?? null;
}

/**
 * A driver's hand-overs summed over the month, or null when the driver has no
 * weekly record at all. Any record, a 0 included, makes the month "recorded".
 */
export function monthlyGivenCents(
  records: HandoverRecord[],
  year: number,
  month: number,
  driverName: string,
): number | null {
  let total: number | null = null;
  for (const r of records) {
    if (r.year !== year || r.month !== month || r.driver_name !== driverName) continue;
    total = (total ?? 0) + toCents(r.amount);
  }
  return total;
}

/** The sum over a set of states, for a totals row. */
export function sumGivenCents(states: HandoverState[]): number {
  return states.reduce((sum, s) => sum + s.givenCents, 0);
}
