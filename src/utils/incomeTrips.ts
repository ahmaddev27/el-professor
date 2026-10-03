import type { Income } from '../types/receipt';

/**
 * The trips an income list stands for, and how many entries said nothing.
 *
 * The entry form writes the one "Number of trips" it was given onto EVERY row of
 * the batch (net fare, promotions, tip, cash), so adding the column up over all
 * four types counts each trip up to four times. The count belongs to the net
 * fare, so only `umsatz` rows are summed.
 *
 * A NULL count means nobody recorded one; it is not 0. `missing` says how many
 * net-fare entries carry none, so a screen can say the total is a lower bound
 * instead of printing a confident figure over rows it could not read.
 */
export interface TripTally {
  /** Sum of the recorded counts; null when no net-fare entry carries one. */
  trips: number | null;
  /** Net-fare entries with no recorded count. */
  missing: number;
}

export function tallyTrips(incomes: readonly Income[]): TripTally {
  let trips: number | null = null;
  let missing = 0;
  for (const income of incomes) {
    if (income.type !== 'umsatz') continue;
    if (income.trip_count == null) missing += 1;
    else trips = (trips ?? 0) + income.trip_count;
  }
  return { trips, missing };
}
