import { PICKUP_HANDLING_SECONDS } from './geo';
import type { GeneratorOptions } from './types';

/**
 * The empty drives of a simulated month (external audit round 6, the
 * repositioning engine).
 *
 * A passenger ride is A to B, the next one C to D. Between them the car drives
 * B to C with nobody in it: a Leerfahrt. It is **never a ride row** — the
 * Fahrtenbuch's columns describe passenger rides, and a row without a
 * passenger would enter its counts and its totals — and it is not hidden
 * either: every one is kept as a record of its own (`fullMonth.ts`,
 * `RepositioningLeg`) and printed in the operational report, never in the
 * passenger sheet.
 *
 * ## The scheduling rule, applied before a ride is accepted
 *
 *   next ride start >= previous ride end + road time + handling + safety margin
 *
 * `road time` is the travel model's own answer (a measured route, or the
 * labelled estimate). Nothing here shortens it: a 14-minute leg is given 14
 * minutes plus the margin, and when the window cannot hold that the candidate
 * is refused and another one is drawn. A pair the model has no route for is
 * never given zero; the candidate is refused.
 *
 * ## The margin
 *
 * Two engines never agree to the second: the round-4 audit measured our OSRM
 * against the auditor's Valhalla and found a median ratio of 1.18 with a long
 * tail where the two geocoders placed one address differently. The margin is
 * room for that disagreement, not a correction of either engine: a fixed part
 * (a car parks, waits at a light) plus a share of the road time (the longer
 * the drive, the more two engines can differ on it). Both are generator
 * options, printed with every month.
 */

/**
 * The legs a repositioning prefers, in seconds of road time: two to five
 * minutes. A preference, not a rule — the generator draws from the candidates
 * inside this window when there are any and from all of them when there are
 * none, and it never moves a point or speeds a car up to get there.
 */
export const PREFERRED_REPOSITIONING_SECONDS = { min: 120, max: 300 } as const;

export type MarginOptions = Pick<GeneratorOptions, 'repositioningMarginSeconds' | 'repositioningMarginPercent'>;

/** The safety margin on top of a leg of `roadSeconds`, whole seconds. */
export function safetyMarginSeconds(roadSeconds: number, opts: MarginOptions): number {
  return Math.max(0, Math.trunc(opts.repositioningMarginSeconds))
    + Math.ceil((Math.max(0, roadSeconds) * Math.max(0, opts.repositioningMarginPercent)) / 100);
}

/** An empty drive to a place that is not a pickup: road time and margin. */
export function emptyDriveSeconds(roadSeconds: number, opts: MarginOptions): number {
  return roadSeconds + safetyMarginSeconds(roadSeconds, opts);
}

/** An empty drive that ends at a pickup: road time, the customer found and seated, and the margin. */
export function pickupDriveSeconds(roadSeconds: number, opts: MarginOptions): number {
  return roadSeconds + PICKUP_HANDLING_SECONDS + safetyMarginSeconds(roadSeconds, opts);
}

/** True when `seconds` of road time lie inside the preferred window. */
export function isPreferredLeg(seconds: number): boolean {
  return seconds >= PREFERRED_REPOSITIONING_SECONDS.min && seconds <= PREFERRED_REPOSITIONING_SECONDS.max;
}

/** The problem with a margin setting, or null. Refused at the boundary rather than clamped inside. */
export function marginProblem(opts: MarginOptions): 'margin_seconds_invalid' | 'margin_percent_invalid' | null {
  const s = opts.repositioningMarginSeconds;
  const p = opts.repositioningMarginPercent;
  if (!Number.isInteger(s) || s < 0 || s > 900) return 'margin_seconds_invalid';
  if (!Number.isFinite(p) || p < 0 || p > 100) return 'margin_percent_invalid';
  return null;
}
