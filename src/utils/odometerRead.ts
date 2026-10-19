/**
 * Reading a car's odometer out of the text OCR found on a photo of its cluster.
 * This is the driver app's rule (its `odometer-read.ts`), restated because that
 * repository cannot be imported. The photo is read and dropped, never stored.
 *
 * The abstention is the feature. On 59 real cluster photos a vision model
 * answered all 59 and abstained zero times; this rule answered 35 and refused
 * 24, and 34 of the 35 were plausible. An odometer goes into a record, so a
 * refusal the person can correct beats a confident wrong number. Do not turn
 * it into a best guess: not by lowering ODOMETER_MIN, and not by falling back to
 * the largest number on the image when no bare `km` is found.
 *
 * What a cluster shows: `0 km/h` (speed, the unit has a slash), `4.6 L/100km`
 * (km inside L/100km), `14 °C` and `4:24` (not km), `277 km` (the range: bare
 * km but small) and `25382 km` (the odometer: bare km and large). So: a run of
 * digits followed by a bare `km`, the largest wins, at least five digits.
 */

export type OdometerProblem = 'no_text' | 'no_km_value' | 'too_small';

export interface OdometerReading {
  /** Total distance, or null when the rule would have had to guess. */
  odometerKm: number | null;
  /** Remaining range in km, or null. */
  rangeKm: number | null;
  /** Present only when `odometerKm` is null; names which case it was. */
  problem?: OdometerProblem;
}

/** Digits followed by `km` that is not part of `km/h` or `L/100km`. */
const BARE_KM = /(^|[^/\d])(\d{2,7})\s*km(?![/\w])/gi;

/** Below this a number is a range, a trip meter or noise - never a total. */
const ODOMETER_MIN = 10000;

/** A range above this is not a range; a car does not hold it. */
const RANGE_MAX = 2000;
const RANGE_MIN = 10;

function kmValues(lines: string[]): number[] {
  const found: number[] = [];
  for (const line of lines) {
    // A fresh matcher per line: a shared /g regex carries lastIndex over.
    const re = new RegExp(BARE_KM.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) found.push(Number(match[2]));
  }
  return found.sort((a, b) => b - a);
}

function rangeBelow(values: number[], odometer: number | null): number | null {
  const limit = odometer ?? Infinity;
  const candidates = values.filter(v => v < limit && v >= RANGE_MIN && v <= RANGE_MAX);
  return candidates.length > 0 ? candidates[0] : null;
}

/** The odometer and the range, or which of them could not be read. */
export function readOdometer(lines: string[]): OdometerReading {
  const kept = lines.filter(line => line.trim() !== '');
  if (kept.length === 0) return { odometerKm: null, rangeKm: null, problem: 'no_text' };

  const values = kmValues(kept);
  if (values.length === 0) return { odometerKm: null, rangeKm: null, problem: 'no_km_value' };

  const odometer = values.find(v => v >= ODOMETER_MIN) ?? null;
  const rangeKm = rangeBelow(values, odometer);
  if (odometer === null) return { odometerKm: null, rangeKm, problem: 'too_small' };
  return { odometerKm: odometer, rangeKm };
}
