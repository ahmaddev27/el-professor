import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toCents } from '../src/utils/money';

/**
 * The verifier reads a month back in Python and must round a figure to
 * hundredths exactly as the workbook did, or it reports a right total as wrong.
 * The workbook rounds half away from zero: kilometres with `Math.round(km * 100)`
 * (`monthClosing.ts`, never negative) and money with `toCents`. Python's own
 * `round()` goes half to even, so a drive of 7.185 km — 718.5 hundredths as a
 * double — read 718 in the verifier and 719 in the workbook, and check 5 failed
 * three shifts of October 2026 whose totals were right (28.11.2026).
 *
 * The values are rounded in both languages from the same doubles: every
 * three-decimal amount up to 50 and every four-decimal one up to 6, each also
 * negative. The verifier needs no workbook (and no openpyxl) for this.
 */

const VERIFIER = path.resolve(import.meta.dirname, 'fleetbook-report-verify.py');

function verifierCents(values: number[]): number[] {
  const run = spawnSync('python3', ['-I', VERIFIER, '--cents'], { input: JSON.stringify(values), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw new Error(`python3 could not be started: ${run.error.message}`);
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as number[];
}

const values: number[] = [];
for (let k = 0; k <= 50_000; k++) values.push(k / 1000, -k / 1000);
for (let k = 0; k <= 60_000; k++) values.push(k / 10_000, -k / 10_000);

describe('the verifier rounds to hundredths as the workbook does', () => {
  const python = verifierCents(values);

  it('agrees with the product on every value, ties included', () => {
    expect(python).toHaveLength(values.length);
    const differ = values.map((v, i) => ({ v, js: toCents(v), py: python[i] })).filter(x => x.js !== x.py);
    expect(differ.slice(0, 10)).toEqual([]);
  });

  it('reads the drive that failed October as the workbook wrote it', () => {
    const [drive, negative, belowHalf] = verifierCents([7.185, -7.185, 1.005]);
    expect(drive).toBe(719);
    expect(negative).toBe(-719);
    // 1.005 × 100 is 100.49999999999999 as a double: below the half, as Math.round sees it,
    // so rounding the decimal text instead would read 101 where the file wrote 100.
    expect(belowHalf).toBe(100);
  });
});
