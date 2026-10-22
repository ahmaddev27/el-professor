/**
 * The Brutto-Gehälter engine does not consult driver absence, and says so.
 *
 * `validateCoverage` and `enforceBlockCoverageInvariant` took a `blockedDates`
 * map (date -> reason) that nothing in the product ever filled: its only
 * caller, `GenerateStundennachweisModal`, was deleted in c3a8a8b (2026-09-09),
 * and the Brutto-Gehälter pipeline that still uses this engine
 * (`HistoricalReconciliationWizard`) never called either function. It reads
 * like a hook that pipeline forgot to fill, which is the reading that would
 * have someone wire absence into the figures an accountant receives.
 *
 * The pipeline reconciles gross pay for a month that has already been driven,
 * so who was available is not a question it asks. The parameter was removed,
 * the stance is written at the top of the engine, and this file keeps both
 * true:
 *
 *   - the two functions take no absence map,
 *   - the engine's code names none and writes no absence reason,
 *   - the stance is in the file (so deleting the explanation is a visible act),
 *   - and the claim the stance rests on, that the wizard reads no driver
 *     notes, is checked rather than trusted. If the wizard ever does read them,
 *     the header is no longer true and has to be rewritten, which this test
 *     forces.
 *
 * What it does not decide: whether absence SHOULD be respected there. That is a
 * product question about the accountant's figures. If the answer changes, build
 * the windows with `noteExclusionIntervals` (driverNoteValidation.ts), never a
 * new copy of the date arithmetic.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import {
  enforceBlockCoverageInvariant,
  normalizeTripServiceDate,
  validateCoverage,
  type NormalizedTrip,
  type Schicht,
} from './shiftBlockEngine';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) => readFileSync(join(SRC, relativePath), 'utf8');

/** The source with its comments removed, so a word in prose is not mistaken for code. */
function codeOnly(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
    } else if (c === "'" || c === '"' || c === '`') {
      const start = i;
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++;
      out += source.slice(start, i + 1);
    } else {
      out += c;
    }
  }
  return out;
}

describe('the helper this file reads the engine with', () => {
  it('drops prose and keeps code, including a // inside a string', () => {
    const stripped = codeOnly("const a = 1; // blockedDates\n/* blockedDates */ const b = 'x//y';");
    expect(stripped).not.toContain('blockedDates');
    expect(stripped).toContain("const a = 1;");
    expect(stripped).toContain("'x//y'");
  });
});

describe('the engine takes no absence map', () => {
  const engine = read('utils/shiftBlockEngine.ts');

  it('gives both coverage functions two parameters, not three', () => {
    expect(validateCoverage.length).toBe(2);
    expect(enforceBlockCoverageInvariant.length).toBe(2);
  });

  it('names no blockedDates and writes no absence reason in code', () => {
    const code = codeOnly(engine);
    expect(code).toContain('export function validateCoverage');
    expect(code).not.toContain('blockedDates');
    expect(code).not.toContain('Abwesenheit');
  });

  it('says why, at the top of the file, and points at the right tool', () => {
    expect(engine).toContain('Scope: this engine does not consult driver absence');
    expect(engine).toContain('noteExclusionIntervals');
  });
});

describe('what the two functions do now: judge a ride by the Schichten alone', () => {
  const trip = (id: string, start: string, end: string) =>
    ({ id, trip_date: '2026-03-05', start_time: start, end_time: end, raw_data_json: {} }) as unknown as FahrtenbuchTrip;

  const day = '2026-03-05';
  const segments: NormalizedTrip[] = [
    ...normalizeTripServiceDate(trip('inside', '10:00', '10:30')),
    ...normalizeTripServiceDate(trip('outside', '20:00', '20:30')),
  ];
  const tripsByDate = () => new Map([[day, segments]]);
  const morningShift = (): Schicht => ({ von: '09:00', bis: '12:00', blockIndex: 0 });

  it('covers the ride inside a Schicht and reports the one outside, on the same day', () => {
    const results = validateCoverage(tripsByDate(), new Map([[day, [morningShift()]]]));
    expect(results.map(r => [r.tripId, r.status])).toEqual([
      ['inside', 'fully_covered'],
      ['outside', 'uncovered'],
    ]);
    expect(results[1].reason).toBe('Fahrt 20:00-20:30 nicht von Schicht abgedeckt');
  });

  it('never reports an absence, whatever day it is', () => {
    const results = validateCoverage(tripsByDate(), new Map());
    expect(results.every(r => r.status === 'uncovered')).toBe(true);
    expect(results.some(r => r.reason.includes('Abwesenheit'))).toBe(false);
  });

  it('extends the nearest Schicht to hold the ride, with no day exempt', () => {
    const shifts = new Map([[day, [morningShift()]]]);
    const fixes = enforceBlockCoverageInvariant(shifts, tripsByDate());
    expect(fixes).toEqual(['2026-03-05: Schicht erweitert auf 09:00-20:30 (Fahrt 20:00-20:30 abdecken)']);
    expect(shifts.get(day)).toEqual([{ von: '09:00', bis: '20:30', blockIndex: 0 }]);
  });
});

describe('the pipeline the stance rests on', () => {
  it('HistoricalReconciliationWizard reads no driver notes, and so no absence', () => {
    // Code only: a comment saying so, which is a fine thing to write, must not trip it.
    const wizard = codeOnly(read('components/HistoricalReconciliationWizard.tsx'));
    expect(wizard.length).toBeGreaterThan(10000);
    expect(wizard).toContain("from('fahrtenbuch_trips')");
    for (const word of ['driver_notes', 'exclude_from_plan', 'note_planning_behavior']) {
      expect(wizard, word).not.toContain(word);
    }
  });
});
