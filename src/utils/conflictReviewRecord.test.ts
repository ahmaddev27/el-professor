import { describe, expect, it, vi } from 'vitest';
import {
  CONFLICT_REVIEW_ON_CONFLICT,
  DETECTION_PAYLOAD_KEYS,
  anomalyFindingKey,
  detectionPayload,
  issueFindingKey,
  returnCheckFindingRows,
  reviewFinding,
  saveDetectedFindings,
  tripAnalysisFindingRows,
  type ConflictPeriod,
} from './conflictReviewRecord';
import type { Issue, TripAnalysisResult } from './tripAnalysis/types';
import type { ReturnCheckResult } from './returnCheck/types';

const PERIOD: ConflictPeriod = { companyId: 'co-a', year: 2026, month: 10 };
const AT = '2026-10-23T08:00:00.000Z';

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'driver_overlap:t1+t2',
    type: 'driver_overlap',
    severity: 'error',
    status: 'conflict',
    driverId: 'd1',
    tripIds: ['t1', 't2'],
    values: { overlapMinutes: 41 },
    explanation: 'Ein Fahrer in zwei Fahrten zugleich.',
    explanationKey: 'engine.analysis.driverOverlap',
    confidence: 'high',
    ...over,
  };
}

function analysis(issues: Issue[]): TripAnalysisResult {
  return {
    algorithmVersion: 'trip-analysis/1.0.0',
    settings: { blockGapMinutes: 60, travelMarginMinutes: 10 },
    travelEstimatorSource: 'none',
    counts: { rows: 0, byStatus: { completed: 0, cancelled: 0, unknown: 0 }, analysed: 0, needsReview: 0 },
    trips: [],
    blocks: [],
    drivers: [],
    issues,
    reviewTripIds: [],
    checks: {
      driverOverlap: { passed: 0, conflict: 0, unverifiable: 0 },
      vehicleOverlap: { passed: 0, conflict: 0, unverifiable: 0 },
      travelGap: { passed: 0, conflict: 0, unverifiable: 0 },
      shiftCoverage: { passed: 0, conflict: 0, unverifiable: 0 },
      budget: { passed: 0, conflict: 0, unverifiable: 0 },
    },
  };
}

// ── The key ──────────────────────────────────────────────────────────────────

describe('the finding key is the detector’s own identifier', () => {
  it('is the engine’s id verbatim, so a re-run lands on the row already on file', () => {
    expect(issueFindingKey(issue())).toBe('driver_overlap:t1+t2');
  });

  it('refuses an id that does not name its own kind, rather than letting the batch fail', () => {
    expect(() => issueFindingKey({ id: 'vehicle_overlap:t1+t2', type: 'driver_overlap' })).toThrow(
      /does not name its own kind/,
    );
    expect(() => issueFindingKey({ id: 'driver_overlap:', type: 'driver_overlap' })).toThrow();
  });

  it('composes a returnCheck anomaly into the same kind:evidence shape', () => {
    expect(anomalyFindingKey({ type: 'same_street', rideId: 'r9' })).toBe('same_street:r9');
    expect(() => anomalyFindingKey({ type: 'same_street', rideId: '' })).toThrow(/names no ride/);
  });

  it('keys a driver-level finding on the driver and never on its evidence', () => {
    // driver_name_mismatch is the engine's own proof of the property this
    // table depends on: another misspelled row joins the evidence without
    // changing the key, so the decision made about it survives.
    const first = tripAnalysisFindingRows(
      analysis([issue({ id: 'driver_name_mismatch:d1', type: 'driver_name_mismatch', tripIds: ['t1'] })]),
      PERIOD,
      AT,
    );
    const later = tripAnalysisFindingRows(
      analysis([
        issue({ id: 'driver_name_mismatch:d1', type: 'driver_name_mismatch', tripIds: ['t1', 't7'] }),
      ]),
      PERIOD,
      AT,
    );
    expect(later[0].finding_key).toBe(first[0].finding_key);
    expect(later[0].trip_ids).toEqual(['t1', 't7']);
  });
});

// ── What a detection may write ───────────────────────────────────────────────

describe('a re-detection writes no review column', () => {
  it('the payload names none of the five a review owns', () => {
    // PostgREST builds an upsert's SET list from the payload's keys, so one of
    // these in the payload would try to reopen every decided finding in the
    // month. The database refuses it; this keeps it from being attempted.
    for (const owned of ['status', 'review_note', 'reviewed_by', 'reviewed_at', 'decided_values']) {
      expect(DETECTION_PAYLOAD_KEYS as readonly string[]).not.toContain(owned);
    }
    expect(Object.keys(detectionPayload(tripAnalysisFindingRows(analysis([issue()]), PERIOD, AT)[0]))).toEqual(
      [...DETECTION_PAYLOAD_KEYS],
    );
  });

  it('nor first_detected_at, which defaults on insert and is pinned on update', () => {
    expect(DETECTION_PAYLOAD_KEYS as readonly string[]).not.toContain('first_detected_at');
  });

  // The asymmetry with first_detected_at above is load-bearing rather than an
  // oversight, so it is pinned here: the column is NOT NULL with no default,
  // so an insert that omits it fails 23502 and every first sighting of every
  // finding is lost. The guard pins it back on the update half of the same
  // upsert, which is what makes sending it harmless -- but it can only pin it
  // to an older row, and on a first sighting there is none.
  it('but DOES carry first_detected_version, because the column is NOT NULL with no default', () => {
    expect(DETECTION_PAYLOAD_KEYS as readonly string[]).toContain('first_detected_version');
    const row = tripAnalysisFindingRows(analysis([issue()]), PERIOD, AT)[0];
    expect(detectionPayload(row)).toHaveProperty('first_detected_version');
    expect(row.first_detected_version).toBe(row.last_detected_version);
  });

  it('upserts on the five columns the unique index is built on, in order', () => {
    expect(CONFLICT_REVIEW_ON_CONFLICT).toBe(
      'company_id,detector,period_year,period_month,finding_key',
    );
  });
});

// ── Rows ─────────────────────────────────────────────────────────────────────

describe('the rows a trip analysis produces', () => {
  it('carries the engine’s own wording and its dictionary key, inventing none', () => {
    const [row] = tripAnalysisFindingRows(analysis([issue()]), PERIOD, AT);
    expect(row.explanation).toBe('Ein Fahrer in zwei Fahrten zugleich.');
    expect(row.explanation_key).toBe('engine.analysis.driverOverlap');
    expect(row.measured_values).toEqual({ overlapMinutes: 41 });
    expect(row.detector).toBe('trip_analysis');
    expect(row.last_detected_version).toBe('trip-analysis/1.0.0');
  });

  it('drops a passed check: a clean check is not a finding', () => {
    const rows = tripAnalysisFindingRows(
      analysis([issue({ status: 'passed' }), issue({ id: 'missing_end:t3', type: 'missing_end' })]),
      PERIOD,
      AT,
    );
    expect(rows.map(row => row.finding_type)).toEqual(['missing_end']);
  });

  it('keeps unverifiable, which is the panel’s “nicht belegt” and not a conflict', () => {
    const [row] = tripAnalysisFindingRows(
      analysis([
        issue({
          id: 'no_shift_records:d1',
          type: 'no_shift_records',
          status: 'unverifiable',
          severity: 'info',
          tripIds: [],
        }),
      ]),
      PERIOD,
      AT,
    );
    expect(row.detector_status).toBe('unverifiable');
    // An empty evidence list is NULL, so two rows cannot mean the same thing
    // in two different ways.
    expect(row.trip_ids).toBeNull();
    expect(row.shift_ids).toBeNull();
  });
});

describe('the rows a Rückkehrpflicht run produces', () => {
  const result = (over: Partial<ReturnCheckResult> = {}): ReturnCheckResult => ({
    algorithmVersion: 'return-check/1.0.0',
    settings: { base: null, baseRadiusKm: 1, blockGapMinutes: 60, maxSpeedKmh: 160 },
    status: 'ok',
    rides: 2,
    checkedRides: 2,
    orders: [],
    anomalies: [
      { rideId: 'r1', type: 'same_address', values: {} },
      { rideId: 'r2', type: 'position_invalid', values: { problem: 'unparsed' } },
    ],
    counts: {
      byPlacement: {
        during_previous: 0, at_base: 0, away_from_base: 0,
        block_start_at_base: 0, block_start_away: 0, unverifiable: 0,
      },
      byAnomaly: {
        same_address: 1, same_street: 0, implausible_speed: 0,
        zero_distance: 0, position_invalid: 1, order_after_start: 0,
      },
    },
    ...over,
  });

  it('files the anomalies and no placement', () => {
    const rows = returnCheckFindingRows(result(), PERIOD, AT);
    expect(rows.map(row => row.finding_key)).toEqual(['same_address:r1', 'position_invalid:r2']);
    expect(rows.every(row => row.detector === 'return_check')).toBe(true);
  });

  it('reports an absence as unverifiable and everything else as a conflict', () => {
    const rows = returnCheckFindingRows(result(), PERIOD, AT);
    expect(rows.map(row => row.detector_status)).toEqual(['conflict', 'unverifiable']);
  });

  it('stores the panel’s own German, through the key the panel renders', () => {
    const [row] = returnCheckFindingRows(result(), PERIOD, AT);
    expect(row.explanation_key).toBe('returncheck.anomaly.same_address');
    expect(row.explanation).toBe('Abholung und Ziel gleich');
  });

  it('files nothing at all when the settings were out of range: nothing was checked', () => {
    expect(returnCheckFindingRows(result({ status: 'invalid_settings' }), PERIOD, AT)).toEqual([]);
  });
});

// ── The two calls ────────────────────────────────────────────────────────────

describe('saving and reviewing', () => {
  it('sends one upsert on the idempotency key', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const client = { from: () => ({ upsert }) } as never;
    const rows = tripAnalysisFindingRows(analysis([issue()]), PERIOD, AT);

    expect(await saveDetectedFindings(client, rows)).toEqual({ ok: true, written: 1 });
    expect(upsert).toHaveBeenCalledWith(
      [detectionPayload(rows[0])],
      { onConflict: CONFLICT_REVIEW_ON_CONFLICT },
    );
  });

  it('issues no request for an empty run', async () => {
    const upsert = vi.fn();
    expect(await saveDetectedFindings({ from: () => ({ upsert }) } as never, [])).toEqual({
      ok: true,
      written: 0,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a dismissal with no reason before it reaches the network', async () => {
    const update = vi.fn();
    const out = await reviewFinding({ from: () => ({ update }) } as never, 'f1', 'dismissed', '   ');
    expect(out).toEqual({ ok: false, reason: 'no_reason' });
    expect(update).not.toHaveBeenCalled();
  });

  it('sends the decision and the note, and never a reviewer or a time', async () => {
    const select = vi.fn().mockResolvedValue({ data: [{ id: 'f1' }], error: null });
    const update = vi.fn().mockReturnValue({ eq: () => ({ select }) });
    const out = await reviewFinding(
      { from: () => ({ update }) } as never, 'f1', 'dismissed', ' Mit dem Fahrer geklärt. ',
    );
    expect(out).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith({
      status: 'dismissed',
      review_note: 'Mit dem Fahrer geklärt.',
    });
  });

  it('reads the refusal off the touched rows, not off `error`', async () => {
    // An UPDATE a policy hides changes nothing and PostgREST answers 200.
    const select = vi.fn().mockResolvedValue({ data: [], error: null });
    const update = vi.fn().mockReturnValue({ eq: () => ({ select }) });
    expect(
      await reviewFinding({ from: () => ({ update }) } as never, 'f1', 'acknowledged', ''),
    ).toEqual({ ok: false, reason: 'refused' });
  });
});
