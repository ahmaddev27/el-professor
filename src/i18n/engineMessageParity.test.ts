/**
 * A German dictionary entry must render EXACTLY the text its engine produced.
 *
 * This is the invariant the whole pattern rests on. The German text stays in
 * the engine as the fallback; the key is what a screen renders. If the two
 * disagree, turning a key on silently rewords the German UI — a change nobody
 * asked for, invisible in review, and impossible to see in a screenshot of the
 * English one.
 *
 * `engineMessages.test.ts` proves every key exists. This one runs real engines
 * on small fixtures, walks whatever they returned, and compares
 * `translate('de', key, vars)` with the text beside it.
 */
import { describe, expect, it } from 'vitest';
import { translate } from './index';
import { isTranslationKey } from './engineMessage';
import { analyzeTrips } from '../utils/tripAnalysis';
import type { AnalysisShift, AnalysisTrip, TravelTimeEstimator } from '../utils/tripAnalysis/types';
import { validateDriverNotesForPlanStep } from '../utils/driverNoteValidation';
import type { StructuredNote } from '../utils/monatsplanungPhase3';
import { describeDatabaseError } from '../utils/errorHandler';
import { generateInsights } from '../utils/overviewHelpers';
import { categorizeWarnings } from '../utils/warningCategories';

/** The text field a bare `messageKey` belongs to, in the order engines use. */
const MESSAGE_TEXT_FIELDS = ['detail', 'message', 'explanation', 'text', 'reason'];

interface Found {
  key: string;
  text: string;
  vars?: Record<string, unknown>;
}

/** Resolve a var that is itself a key, exactly as engineText does. */
function germanVars(vars: Record<string, unknown> | undefined) {
  if (!vars) return undefined;
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(vars)) {
    out[name] =
      typeof value === 'string' && isTranslationKey(value)
        ? translate('de', value)
        : (value as string | number);
  }
  return out;
}

/**
 * Every `<field>Key` an engine wrote, with the text it sits beside.
 * `messageKey` pairs with the first of MESSAGE_TEXT_FIELDS the object carries;
 * every other `<field>Key` pairs with `<field>` by name.
 */
function collect(value: unknown, found: Found[] = [], seen = new Set<unknown>()): Found[] {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found, seen);
    return found;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  const record = value as Record<string, unknown>;

  for (const [name, keyValue] of Object.entries(record)) {
    if (!name.endsWith('Key') || typeof keyValue !== 'string' || !keyValue.startsWith('engine.')) continue;
    const prefix = name.slice(0, -'Key'.length);
    const text =
      prefix === 'message'
        ? MESSAGE_TEXT_FIELDS.map(f => record[f]).find(v => typeof v === 'string')
        : record[prefix];
    if (typeof text !== 'string') continue;
    found.push({ key: keyValue, text, vars: record[`${prefix}Vars`] as Record<string, unknown> | undefined });
  }

  for (const nested of Object.values(record)) collect(nested, found, seen);
  return found;
}

function expectGermanMatches(found: readonly Found[], atLeast: number) {
  expect(found.length).toBeGreaterThanOrEqual(atLeast);
  const wrong = found
    .filter(f => translate('de', f.key as never, germanVars(f.vars)) !== f.text)
    .map(f => `${f.key}\n  engine: ${f.text}\n  de.ts : ${translate('de', f.key as never, germanVars(f.vars))}`);
  expect(wrong).toEqual([]);
}

// ── Trip analysis ────────────────────────────────────────────────────────────

const DAY = '2026-08-03'; // a Monday
const at = (time: string, day = DAY) => new Date(`${day}T${time}:00`).getTime();

function trip(
  id: string,
  driver: string | null,
  vehicle: string | null,
  start: string | null,
  end: string | null,
  extra: Partial<AnalysisTrip> = {},
): AnalysisTrip {
  return {
    id,
    driver_id: driver,
    driver_name: driver === null ? null : `Fahrer ${driver}`,
    vehicle,
    start_ms: start === null ? null : at(start),
    end_ms: end === null ? null : at(end),
    status: 'completed',
    price: 10,
    currency: 'EUR',
    source_row: 7,
    pickup_address: null,
    dropoff_address: null,
    ...extra,
  };
}

const shift = (id: string, driver: string, start: string, end: string): AnalysisShift => ({
  id, driver_id: driver, start_ms: at(start), end_ms: at(end), source: 'test',
});

const estimator = (minutes: number): TravelTimeEstimator => ({
  source: 'test-table',
  estimate: () => ({ kind: 'estimated', minutes, source: 'test-table', confidence: 'medium' }),
});

describe('the German entry reproduces the engine text', () => {
  it('trip analysis — overlaps, row quality, shifts, travel and budget', () => {
    const result = analyzeTrips({
      settings: { blockGapMinutes: 30, travelMarginMinutes: 5 },
      trips: [
        // one driver in two trips at once, on two vehicles
        trip('t1', 'd1', 'X', '08:00', '09:00'),
        trip('t2', 'd1', 'Y', '08:30', '09:30'),
        // one vehicle, two drivers
        trip('t3', 'd2', 'Z', '10:00', '11:00'),
        trip('t4', 'd3', 'Z', '10:30', '11:30'),
        // row quality, one of each the adapter can produce here
        trip('t5', null, 'X', '12:00', '12:30'),
        trip('t6', 'd1', null, '13:00', '13:30'),
        trip('t7', 'd1', 'X', null, '14:00'),
        trip('t8', 'd1', 'X', '15:00', null),
        trip('t9', 'd1', 'X', '17:00', '16:00'),
        trip('t10', 'd1', 'X', '18:00', '18:30', { status: 'unknown' }),
        // the same id under a second spelling
        trip('t11', 'd2', 'Z', '19:00', '19:30', { driver_name: 'Fahrer D2' }),
        // a pair far enough apart for the travel check, with addresses
        trip('t12', 'd4', 'Q', '08:00', '08:30', { dropoff_address: 'A-Stadt 1' }),
        trip('t13', 'd4', 'Q', '09:00', '09:30', { pickup_address: 'B-Stadt 2' }),
      ],
      shifts: [
        shift('s1', 'd1', '07:00', '07:30'),   // a shift no trip touches
        shift('s2', 'd2', '00:00', '23:59'),
        shift('s3', 'd2', '09:00', '12:00'),   // overlaps s2
        { id: 's4', driver_id: '  ', start_ms: at('08:00'), end_ms: at('09:00'), source: 'test' },
      ],
      budgets: {
        d1: { salaryMin: 1000, salaryMax: 1200, hourlyRate: 13.9, reservedHours: 80 },
        d2: { salaryMin: 'x', hourlyRate: 0 },
        // a tiny budget so the past activity is over it
        d4: { salaryMin: 1, salaryMax: 2, hourlyRate: 100, reservedHours: 0 },
      },
      travelEstimator: estimator(40),
    });

    expectGermanMatches(collect(result.issues), 15);
  });

  it('trip analysis — travel with no routing service and a missing address', () => {
    const result = analyzeTrips({
      settings: { blockGapMinutes: 30, travelMarginMinutes: 90 },
      trips: [
        trip('a1', 'd1', 'X', '08:00', '08:30', { dropoff_address: 'A-Stadt 1' }),
        trip('a2', 'd1', 'X', '08:40', '09:10', { pickup_address: 'B-Stadt 2' }),
        trip('a3', 'd1', 'X', '09:20', '09:50'),
      ],
    });

    expectGermanMatches(collect(result.issues), 2);
  });

  // ── Driver notes ───────────────────────────────────────────────────────────

  it('driver-note violations — empty name, "Nicht zugewiesen", and an excluding note', () => {
    const note = (extra: Partial<StructuredNote>): StructuredNote => ({
      id: 'n1',
      driver_id: 'd1',
      note_type: 'sick',
      note_text: 'krank',
      note_planning_behavior: 'exclude_from_plan',
      is_full_day: true,
      start_date: DAY,
      end_date: DAY,
      note_date: null,
      start_time: null,
      end_time: null,
      ...extra,
    });

    const result = validateDriverNotesForPlanStep({
      stepName: 'test',
      driverNotesMap: new Map([
        ['d1', [note({})]],
        ['d2', [note({ id: 'n2', driver_id: 'd2', note_type: 'vacation', is_full_day: false, start_time: '06:00', end_time: '12:00' })]],
        ['d3', [note({ id: 'n3', driver_id: 'd3', note_type: 'not_a_known_type' })]],
      ]),
      rides: [
        { blockId: 'b1', vehicleIdentifier: 'X', driverId: 'd1', driverName: 'Fahrer 1', startMs: at('09:00'), endMs: at('10:00') },
        { blockId: 'b2', vehicleIdentifier: 'X', driverId: 'd2', driverName: 'Fahrer 2', startMs: at('09:00'), endMs: at('10:00') },
        { blockId: 'b3', vehicleIdentifier: 'X', driverId: 'd3', driverName: 'Fahrer 3', startMs: at('09:00'), endMs: at('10:00') },
        { blockId: 'b4', vehicleIdentifier: 'X', driverId: '', driverName: '', startMs: at('09:00'), endMs: at('10:00') },
        { blockId: 'b5', vehicleIdentifier: 'X', driverId: '', driverName: 'Nicht zugewiesen', startMs: at('09:00'), endMs: at('10:00') },
      ],
    });

    expect(result.violations).toHaveLength(5);
    expectGermanMatches(collect(result.violations), 10);
  });

  // ── Database errors ────────────────────────────────────────────────────────

  it('database errors', () => {
    const cases = [
      describeDatabaseError(null),
      describeDatabaseError({ code: '42501' }),
      describeDatabaseError({ code: '23503' }),
      describeDatabaseError({ code: '23505' }),
      describeDatabaseError({ message: 'not found' }),
      describeDatabaseError({ message: '' }),
    ];
    expectGermanMatches(collect(cases), 6);
  });

  // ── Overview insights and warning groups ───────────────────────────────────

  it('overview insights', () => {
    const metrics = (umsatz: number, profit: number, profitMargin: number) =>
      ({ umsatz, profit, profitMargin }) as Parameters<typeof generateInsights>[0];

    const insights = [
      ...generateInsights(
        metrics(200, -50, -25),
        metrics(100, 10, 10),
        [{ name: 'Fahrer 1', netContribution: 500 } as never, { name: 'Fahrer 2', netContribution: -20 } as never],
        [{ status: 'unpaid', remaining: 100 } as never],
        [{ status: 'negative' } as never],
      ),
      ...generateInsights(
        metrics(100, 90, 40),
        metrics(200, 10, 10),
        [],
        [{ status: 'partially_paid', remaining: 10 } as never],
        [{ status: 'negative' } as never, { status: 'negative' } as never],
      ),
    ];

    expectGermanMatches(collect(insights), 10);
  });

  it('warning group labels', () => {
    const groups = categorizeWarnings([
      'Ueberlappende Fahrten (negativer Transfer)',
      'Knapper Transfer: 3 Min. zwischen verschiedenen Adressen',
      'Schicht laenger als 7 Std. ohne Pause.',
      'Zielgehalt nicht vollstaendig erreichbar (80% erreicht)',
      'Bestehender Stundennachweis wird nicht ueberschrieben',
    ]);
    expect(groups).toHaveLength(5);
    expectGermanMatches(collect(groups), 5);
  });
});
