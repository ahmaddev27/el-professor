/**
 * The finding kinds `conflict_reviews` accepts are the finding kinds the two
 * detectors produce, and the list is written twice — once as a TypeScript
 * union, once as a CHECK constraint — so the two have to move together.
 *
 * What each failure looks like, because neither says what happened:
 *
 *   - **A kind the engine produces and the database does not know** is refused
 *     as `23514 conflict_reviews_detector_type`. The whole upsert of that
 *     month's findings fails, so one new `IssueType` loses *every* finding of
 *     the run, not just its own.
 *   - **A kind the database knows and the engine does not** is a row nothing
 *     can ever write, and it reads as coverage that does not exist.
 *
 * This is `rolePageKeys.test.ts`'s rule for `PAGE_DEFINITIONS` /
 * `role_page_keys()`, and `planFeatures.test.ts`'s for `plan_features` /
 * `FeatureKey`, applied to the third list this codebase holds in both places.
 * The **newest** migration that defines the constraint is the live one — a
 * later release adding a kind replaces it — so it is found by name order, the
 * way the migration chain itself resolves, rather than named here.
 *
 * The TypeScript side is a `Record<IssueType, true>` and not an array, so the
 * compiler is what proves it exhaustive: a kind added to the union and not to
 * the map fails `tsc` rather than passing this test with a short list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { IssueType } from './tripAnalysis/types';
import type { AnomalyType } from './returnCheck/types';

/* Every tripAnalysis finding kind. A missing key is a compile error. */
const TRIP_ANALYSIS_KINDS: Record<IssueType, true> = {
  driver_overlap: true,
  vehicle_overlap: true,
  travel_gap: true,
  activity_outside_shift: true,
  shift_without_activity: true,
  shift_overlap: true,
  shift_invalid: true,
  no_shift_records: true,
  missing_driver: true,
  missing_vehicle: true,
  missing_start: true,
  missing_end: true,
  end_before_start: true,
  status_unknown: true,
  ambiguous_local_time: true,
  driver_name_mismatch: true,
  activity_over_budget: true,
  shifts_over_budget: true,
  budget_not_computable: true,
  cap_below_hours_min: true,
};

/* Every returnCheck anomaly kind. `OrderPlacement` is deliberately absent:
   a placement is produced for every completed ride and is not a finding, and
   the two placements that read as reviewable are the ones the module says the
   file cannot decide. See the migration header. */
const RETURN_CHECK_KINDS: Record<AnomalyType, true> = {
  same_address: true,
  same_street: true,
  implausible_speed: true,
  zero_distance: true,
  position_invalid: true,
  order_after_start: true,
};

const CONSTRAINT = /CONSTRAINT conflict_reviews_detector_type CHECK/;

/** The quoted kinds of one detector's `finding_type IN (…)` list. */
function kindsInMigration(detector: string): string[] {
  const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  const defining = readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => readFileSync(dir + file, 'utf8'))
    .filter(sql => CONSTRAINT.test(sql));

  if (defining.length === 0) {
    throw new Error('no migration defines the conflict_reviews_detector_type constraint');
  }
  const live = defining[defining.length - 1];
  // Anchored on the detector's own equality test, so the other detector's list
  // in the same constraint cannot be read as this one's.
  const list = live.match(
    new RegExp(`detector = '${detector}' AND finding_type IN \\(([\\s\\S]*?)\\)`),
  );
  if (!list) throw new Error(`the live constraint names no list for detector ${detector}`);
  return [...list[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map(match => match[1]);
}

describe('the finding kinds the database accepts are the ones the detectors produce', () => {
  it('trip_analysis names exactly the twenty IssueTypes', () => {
    expect(kindsInMigration('trip_analysis').sort()).toEqual(Object.keys(TRIP_ANALYSIS_KINDS).sort());
  });

  it('return_check names exactly the six AnomalyTypes', () => {
    expect(kindsInMigration('return_check').sort()).toEqual(Object.keys(RETURN_CHECK_KINDS).sort());
  });

  it('and no kind is claimed by both detectors, so one key cannot mean two things', () => {
    const shared = kindsInMigration('trip_analysis').filter(kind =>
      kindsInMigration('return_check').includes(kind),
    );
    expect(shared).toEqual([]);
  });

  it('names no kind twice in either list', () => {
    for (const detector of ['trip_analysis', 'return_check']) {
      const kinds = kindsInMigration(detector);
      expect(new Set(kinds).size).toBe(kinds.length);
    }
  });
});
