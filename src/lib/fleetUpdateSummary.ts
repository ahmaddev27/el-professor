/**
 * The figures the update button reports after a run: what the partner's list
 * held and what the database did with it.
 *
 * Pure, and built only from what the two answers carried. A figure that is not
 * in the answer is left out rather than printed as 0, because "0 departed" is a
 * claim the partner's reply did not make.
 */
import type { TranslationKey } from '../i18n';
import type { ImportScope, LegOutcome } from './partnerFleetImport';

export interface UpdateFigure {
  key: TranslationKey;
  count: number;
}

type DoneLeg = Extract<LegOutcome, { status: 'done' }>;

function present(key: TranslationKey, count: number | null): UpdateFigure[] {
  return count === null ? [] : [{ key, count }];
}

/**
 * Drivers: seen, added, linked automatically, waiting for a decision, departed.
 * `created` are drivers the import added and linked; `linked` matched an
 * existing driver. Vehicles carry no decision step, so they show what was
 * skipped instead.
 */
export function updateFigures(scope: ImportScope, leg: DoneLeg): UpdateFigure[] {
  const { pull, result } = leg;
  const common = [
    ...present('import.update.seen', pull.seen),
    { key: 'import.update.created' as const, count: result.created },
    { key: 'import.update.linked' as const, count: result.linked },
  ];
  const tail = scope === 'drivers'
    ? present('import.update.pending', result.pending)
    : [{ key: 'import.update.skipped' as const, count: result.skipped.length }];
  return [...common, ...tail, ...present('import.update.departed', pull.departed)];
}
