/**
 * Price sums for display. A trip's own price and currency are never changed,
 * rounded in place or moved to another trip; the sums are derived in integer
 * cents (utils/money) so no float drift reaches a total. Amounts in different
 * currencies, and of different statuses, are never added together.
 */
import { toCents } from '../money';
import { compareIds } from './intervals';
import type { AnalysisTrip, PriceSummary, PriceTotal, TripStatus } from './types';

const STATUS_ORDER: Readonly<Record<TripStatus, number>> = { completed: 0, cancelled: 1, unknown: 2 };

/** Integer cents, or null for a missing price or one that is not a decimal amount. */
function centsOf(price: AnalysisTrip['price']): number | null {
  if (price === null || price === undefined) return null;
  if (typeof price === 'string' && price.trim() === '') return null;
  try {
    return toCents(price);
  } catch {
    return null;
  }
}

export function priceSummary(trips: readonly AnalysisTrip[]): PriceSummary {
  const totals = new Map<string, { currency: string | null; status: TripStatus; totalCents: number; tripCount: number }>();
  const unpricedTripIds: string[] = [];
  for (const trip of trips) {
    const cents = centsOf(trip.price);
    if (cents === null) {
      unpricedTripIds.push(trip.id);
      continue;
    }
    const key = JSON.stringify([trip.currency, trip.status]);
    const total = totals.get(key);
    if (total) {
      total.totalCents += cents;
      total.tripCount += 1;
    } else {
      totals.set(key, { currency: trip.currency, status: trip.status, totalCents: cents, tripCount: 1 });
    }
  }
  const sorted: PriceTotal[] = [...totals.values()].sort(
    (a, b) => compareIds(a.currency ?? '', b.currency ?? '') || STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  );
  return { totals: sorted, unpricedTripIds: unpricedTripIds.sort(compareIds) };
}
