/**
 * A capped `DataTable` contains its paint, and an uncapped one does not.
 *
 * ## Why this is a source test rather than a rendered one
 *
 * The defect is a layout measurement — `document.documentElement.scrollHeight`
 * reporting 8592 px for a table clipped to 1237 — and `vitest.config.ts` runs in
 * `environment: 'node'` with no DOM, so nothing here can measure a layout. The
 * measurement was made once, by hand, in Chrome 141 on the Fahrtenanalyse's 118
 * findings, and is recorded at the line this test guards.
 *
 * What a source test *can* do is keep the rule from being undone by someone who
 * never saw that measurement: the class has to be applied by `DataTable`, it has
 * to be tied to `scrollClassName`, and no caller may need to know. That is what
 * this asserts, and it is honest about being the weaker of the two checks.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

describe('DataTable contains its paint when it is capped', () => {
  const source = read('src/components/ui/DataTable.tsx');

  it('applies the containment itself', () => {
    expect(source).toContain('[contain:paint]');
  });

  it('applies it only when the caller caps the height', () => {
    // The condition is the defect's own: a table with no cap does not scroll, so
    // it has no sticky overflow to escape and nothing to contain. Applying it
    // unconditionally would clip at the edge of every table for no gain.
    expect(source).toMatch(/scrollClassName \?\s*'\[contain:paint\]'\s*:\s*undefined/);
  });

  /**
   * The point of the fold-in. Before it, one of four callers carried the class
   * and the other three were simply too short to show the defect — including
   * `SalariesManagement`, whose list grows with the company.
   */
  it('no caller carries the class itself any more', () => {
    for (const file of [
      'src/components/tripAnalysis/TripAnalysisIssues.tsx',
      'src/components/GehaltsquittungList.tsx',
      'src/components/SalariesManagement.tsx',
      'src/components/MonthlyPlanDocumentsStep.tsx',
    ]) {
      expect(read(file), `${file} still spells out the containment`)
        .not.toContain('[contain:paint]');
    }
  });

  // SalariesManagement is not here: its only capped table was the revenue-details
  // dialog, removed when the row's four buttons went; its own list is uncapped.
  it('and the three that cap their height still do, so they stay covered', () => {
    for (const file of [
      'src/components/tripAnalysis/TripAnalysisIssues.tsx',
      'src/components/GehaltsquittungList.tsx',
      'src/components/MonthlyPlanDocumentsStep.tsx',
    ]) {
      expect(read(file), `${file} no longer passes scrollClassName`)
        .toMatch(/scrollClassName="max-h-/);
    }
  });
});
