/**
 * Filing a detected conflict and recording a review of it
 * (migration 20261023200000, table `public.conflict_reviews`).
 *
 * ## Why this is not in `tripAnalysis/` or `returnCheck/`
 *
 * Both folders are pure on purpose and both have a `boundary.test.ts` that
 * fails them for naming a table, reading the clock or importing outside a
 * short allow-list. This module is the other side of that line, as
 * `vehicleDayPlanPersistence.ts` is for `shiftRecommendation/`: it takes what
 * a detector produced and moves it to and from the database. It imports the
 * engines' **types** and nothing else from them.
 *
 * ## The key, and why a re-run writes no second row
 *
 * The unique key is `(company_id, detector, period_year, period_month,
 * finding_key)`, and `finding_key` is the detector's own identifier for the
 * finding. `tripAnalysis` already builds one — `Issue.id`, which names the
 * *subject* of the finding (a pair of trips, a trip, a shift, a driver) and
 * never its measurement or its evidence set. `driver_name_mismatch` is the
 * proof: its id is `driver_name_mismatch:<driverId>` and not the list of
 * misspelled rows, so a new misspelled row updates that finding instead of
 * filing a second one.
 *
 * `returnCheck` has no `id` field, but `RideAnomaly` carries `(type, rideId)`,
 * which is the same identity in two fields. `anomalyFindingKey` composes it
 * into the same `kind:evidence` shape, in one place, so the composition cannot
 * drift between callers.
 *
 * ## What a re-detection may write, and what it must not
 *
 * `detectionPayload` returns the columns a re-run owns — the measurement, the
 * evidence, the wording, `last_detected_*` — and **never** `status`,
 * `review_note`, `reviewed_by`, `reviewed_at` or `decided_values`. That is not
 * a convention this file is free to drop: PostgREST builds an upsert's
 * `ON CONFLICT DO UPDATE SET` list from the payload's keys, so a payload
 * carrying `status: 'open'` would try to reopen every decided finding in the
 * month. The database refuses that (`decision_is_a_record`) and the whole
 * upsert fails, which is the right failure — loud — but the payload is what
 * keeps it from happening at all. `conflictReviewRecord.test.ts` reads the key
 * set and fails if one of the five appears.
 *
 * `first_detected_at` is **not** in the payload: the column defaults to
 * `now()` on insert and the guard pins it to the first sighting on every
 * update, so sending it could only ever be ignored.
 *
 * `first_detected_version` **is**, and the asymmetry is not an oversight -
 * the column is `NOT NULL` with no default, so an insert has to supply it or
 * it fails `23502`. On the update half of the same upsert the guard pins it
 * back to the first sighting, which `tests/rls/conflict-review-record.sql`
 * probe 4c measures: a re-run under `cr/2.0.0` leaves the row's
 * `first_detected_version` at `cr/1.0.0`. So do not "tidy" it out of
 * `DETECTION_PAYLOAD_KEYS` on the grounds that the guard overwrites it -
 * the guard overwrites it only when there is an older row to pin it to, and
 * on a first sighting there is not.
 *
 * ## A finding is a list to review, never a verdict
 *
 * No German is written here. A `tripAnalysis` finding carries the engine's own
 * `explanation` and `explanationKey`; a `returnCheck` anomaly carries the
 * panel's own `returncheck.anomaly.<type>` key and the German text out of the
 * canonical dictionary, so the stored sentence is the one the operator read on
 * screen. The storage layer invents no vocabulary, and `detector_status` keeps
 * the engines' distinction between "checked and not fine" and "could not be
 * checked" — the panel's "zu prüfen" and "nicht belegt".
 *
 * ## Not wired to a screen yet
 *
 * Nothing imports this file. A screen that calls `saveDetectedFindings` must
 * ask `useCompanyScope().can('documents', 'edit')` — the page all three write
 * policies gate on — and `reviewFinding` goes through `updateChecked`, because
 * an UPDATE a policy hides changes nothing and PostgREST answers 200.
 */

import type { Issue, TripAnalysisResult } from './tripAnalysis/types';
import type { AnomalyType, ReturnCheckResult, RideAnomaly } from './returnCheck/types';
import { de } from '../i18n/de';

/** The two detectors `conflict_reviews.detector` admits. */
export type ConflictDetector = 'trip_analysis' | 'return_check';

/** `conflict_reviews.detector_status`: the engines' IssueStatus, minus 'passed'. */
export type ConflictDetectorStatus = 'conflict' | 'unverifiable';

/** `conflict_reviews.status`. The reviewer's words, not the detector's. */
export type ConflictReviewStatus = 'open' | 'acknowledged' | 'dismissed';

/** The analysis month, 1-indexed as `fahrtenbuch_imports.month` is. */
export interface ConflictPeriod {
  readonly companyId: string;
  readonly year: number;
  /** 1 = January. NOT `weekCalculations`' 0-indexed month. */
  readonly month: number;
}

/** One row of `conflict_reviews`, as a detection writes it. */
export interface ConflictDetectionRow {
  company_id: string;
  detector: ConflictDetector;
  finding_type: string;
  finding_key: string;
  period_year: number;
  period_month: number;
  detector_status: ConflictDetectorStatus;
  severity: 'error' | 'warning' | 'info';
  confidence: 'high' | 'medium' | 'low';
  subject_driver_id: string | null;
  subject_vehicle: string | null;
  trip_ids: string[] | null;
  shift_ids: string[] | null;
  measured_values: Record<string, unknown>;
  explanation: string;
  explanation_key: string | null;
  explanation_vars: Record<string, unknown> | null;
  last_detected_at: string;
  last_detected_version: string;
  first_detected_version: string;
}

/**
 * The columns a re-detection owns. Everything a review owns is absent, and a
 * test asserts it: see the header.
 */
export const DETECTION_PAYLOAD_KEYS: readonly (keyof ConflictDetectionRow)[] = [
  'company_id',
  'detector',
  'finding_type',
  'finding_key',
  'period_year',
  'period_month',
  'detector_status',
  'severity',
  'confidence',
  'subject_driver_id',
  'subject_vehicle',
  'trip_ids',
  'shift_ids',
  'measured_values',
  'explanation',
  'explanation_key',
  'explanation_vars',
  'last_detected_at',
  'last_detected_version',
  'first_detected_version',
];

/** The columns the unique index is built on, in order, for `onConflict`. */
export const CONFLICT_REVIEW_ON_CONFLICT =
  'company_id,detector,period_year,period_month,finding_key';

/**
 * `returnCheck` ranks nothing, so every anomaly is filed as a 'warning' — the
 * middle value — and ordering them is a product decision this slice does not
 * take. `position_invalid` is the one whose content is an absence, so it is
 * 'unverifiable': the panel's "nicht belegt".
 */
const ANOMALY_STATUS: Readonly<Record<AnomalyType, ConflictDetectorStatus>> = {
  same_address: 'conflict',
  same_street: 'conflict',
  implausible_speed: 'conflict',
  zero_distance: 'conflict',
  position_invalid: 'unverifiable',
  order_after_start: 'conflict',
};

/** An empty evidence list is stored as NULL, never as an empty array. */
function evidence(ids: readonly string[] | undefined): string[] | null {
  return ids && ids.length > 0 ? [...ids] : null;
}

/**
 * The detector's own identifier, verbatim. It is returned rather than rebuilt
 * so that the stored key is the engine's and not this file's reading of it;
 * what is checked is only that the engine kept its documented shape, because a
 * key that does not name its own kind is refused by the database anyway
 * (`conflict_reviews_finding_key_names_type`) and the refusal would arrive as
 * a failed batch with no indication of which finding caused it.
 */
export function issueFindingKey(issue: Pick<Issue, 'id' | 'type'>): string {
  const prefix = `${issue.type}:`;
  if (!issue.id.startsWith(prefix) || issue.id.length <= prefix.length) {
    throw new Error(`finding id ${issue.id} does not name its own kind ${issue.type}`);
  }
  return issue.id;
}

/** `returnCheck` has no id field; `(type, rideId)` is the same identity. */
export function anomalyFindingKey(anomaly: Pick<RideAnomaly, 'type' | 'rideId'>): string {
  if (anomaly.rideId === '') throw new Error(`anomaly ${anomaly.type} names no ride`);
  return `${anomaly.type}:${anomaly.rideId}`;
}

/**
 * One row per finding of a trip analysis. `'passed'` findings are dropped:
 * a clean check is not a finding, and the database refuses to hold one.
 */
export function tripAnalysisFindingRows(
  result: TripAnalysisResult,
  period: ConflictPeriod,
  detectedAt: string,
): ConflictDetectionRow[] {
  return result.issues
    .filter(issue => issue.status !== 'passed')
    .map(issue => ({
      company_id: period.companyId,
      detector: 'trip_analysis' as const,
      finding_type: issue.type,
      finding_key: issueFindingKey(issue),
      period_year: period.year,
      period_month: period.month,
      detector_status: issue.status as ConflictDetectorStatus,
      severity: issue.severity,
      confidence: issue.confidence,
      subject_driver_id: issue.driverId ?? null,
      subject_vehicle: issue.vehicle ?? null,
      trip_ids: evidence(issue.tripIds),
      shift_ids: evidence(issue.shiftIds),
      measured_values: { ...issue.values },
      explanation: issue.explanation,
      explanation_key: issue.explanationKey ?? null,
      explanation_vars: issue.explanationVars ? { ...issue.explanationVars } : null,
      last_detected_at: detectedAt,
      last_detected_version: result.algorithmVersion,
      first_detected_version: result.algorithmVersion,
    }));
}

/** One row per ride anomaly of a Rückkehrpflicht run. Placements are not findings. */
export function returnCheckFindingRows(
  result: ReturnCheckResult,
  period: ConflictPeriod,
  detectedAt: string,
): ConflictDetectionRow[] {
  if (result.status !== 'ok') return [];
  return result.anomalies.map(anomaly => ({
    company_id: period.companyId,
    detector: 'return_check' as const,
    finding_type: anomaly.type,
    finding_key: anomalyFindingKey(anomaly),
    period_year: period.year,
    period_month: period.month,
    detector_status: ANOMALY_STATUS[anomaly.type],
    // See ANOMALY_STATUS: the module ranks nothing.
    severity: 'warning' as const,
    // Every anomaly is read straight off the ride's own columns, with no
    // estimate in it, so none of them is a weaker reading than another.
    confidence: 'high' as const,
    subject_driver_id: null,
    subject_vehicle: null,
    trip_ids: [anomaly.rideId],
    shift_ids: null,
    measured_values: { ...anomaly.values },
    // The panel's own wording, out of the canonical dictionary, so the stored
    // sentence is the one the operator read.
    explanation: de[`returncheck.anomaly.${anomaly.type}` as const],
    explanation_key: `returncheck.anomaly.${anomaly.type}`,
    explanation_vars: null,
    last_detected_at: detectedAt,
    last_detected_version: result.algorithmVersion,
    first_detected_version: result.algorithmVersion,
  }));
}

/** The payload of one row, with every review column left out. */
export function detectionPayload(row: ConflictDetectionRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DETECTION_PAYLOAD_KEYS) out[key] = row[key];
  return out;
}

// ── The two calls ────────────────────────────────────────────────────────────

/** Just enough of supabase-js for this module, so a test needs no client. */
export interface ConflictReviewClient {
  from(table: string): {
    upsert(
      values: Record<string, unknown>[],
      options: { onConflict: string },
    ): Promise<{ error: { message: string } | null }>;
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): {
        select(columns: string): Promise<{ data: { id: string }[] | null; error: { message: string } | null }>;
      };
    };
  };
}

/**
 * File this run's findings. One upsert on the idempotency key, so a finding
 * already on file keeps its id, its first sighting and any decision made
 * about it.
 */
export async function saveDetectedFindings(
  client: ConflictReviewClient,
  rows: readonly ConflictDetectionRow[],
): Promise<{ ok: boolean; written: number; error?: string }> {
  if (rows.length === 0) return { ok: true, written: 0 };
  const { error } = await client
    .from('conflict_reviews')
    .upsert(rows.map(detectionPayload), { onConflict: CONFLICT_REVIEW_ON_CONFLICT });
  if (error) return { ok: false, written: 0, error: error.message };
  return { ok: true, written: rows.length };
}

/**
 * Record a review. `acknowledged` takes the finding on; `dismissed` says there
 * is nothing to act on and **must** carry a reason — the partner submissions'
 * rule, because a dismissal with no reason cannot be told apart from a finding
 * nobody examined. The reviewer and the time are the database's: they are
 * stamped by the guard and are not sent from here.
 *
 * The outcome is read from the rows the UPDATE touched, not from `error`: an
 * UPDATE a policy hides changes nothing and PostgREST answers 200, which a
 * screen reading only `error` reports as success.
 */
export async function reviewFinding(
  client: ConflictReviewClient,
  findingId: string,
  decision: 'acknowledged' | 'dismissed',
  note: string,
): Promise<{ ok: boolean; reason?: 'no_reason' | 'refused' | 'error'; error?: string }> {
  if (decision === 'dismissed' && note.trim() === '') {
    return { ok: false, reason: 'no_reason' };
  }
  const { data, error } = await client
    .from('conflict_reviews')
    .update({ status: decision, review_note: note.trim() === '' ? null : note.trim() })
    .eq('id', findingId)
    .select('id');
  if (error) return { ok: false, reason: 'error', error: error.message };
  if (!data || data.length === 0) return { ok: false, reason: 'refused' };
  return { ok: true };
}
