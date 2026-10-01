/**
 * The two monthly-hours columns stay out of the planning path.
 *
 * Owner's decision, 01.10.2026: the plan works from **salaries**, not hours, so
 * `target_monthly_hours` and `max_monthly_hours` were removed from the driver
 * form, the drivers export, the write path, the planning engine and the driver
 * pool's display.
 *
 * This file is what stops them coming back. A removal spread over nine files is
 * undone one convenience at a time — somebody adds the field to a form because a
 * screen shows it, or to an engine because a type carries it — and each step
 * looks reasonable on its own. The test reads the files rather than the types,
 * because a type can be widened in the same commit that reintroduces the use.
 *
 * **What it deliberately permits**, and the boundary is the point:
 *
 *   · The LEGACY pipeline (`monatsplanungPhase3`, `shiftBlockEngine`,
 *     `MonatsplanungAssignmentPreview`) still reads both as real constraints.
 *     CLAUDE.md forbids editing those: no test coverage, and they feed records
 *     that go to an accountant. With the form fields gone their columns go empty
 *     over time, and that engine already treats an empty one as "no cap" — so it
 *     degrades into the new rule rather than breaking.
 *   · `MonatsplanungDriverPool` still *reads* both into its row, because that
 *     row is the legacy engine's input. What it must not do is show them or ask
 *     the operator to fill them, which is what §5 forbids.
 *   · Comments naming the columns are not uses. They are how the next reader
 *     learns why the field is absent, and deleting them would make the removal
 *     look like an oversight.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

/**
 * The file with every comment and string removed, so only code is examined.
 *
 * Without this the test would fail on its own explanation, and the obvious fix
 * would be to delete the explanation — which is the opposite of what this is
 * for.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments, including JSDoc
    .replace(/\/\/[^\n]*/g, ' ')         // line comments
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // string literals, which name columns
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const COLUMNS = ['target_monthly_hours', 'max_monthly_hours',
                 'targetMonthlyHours', 'maxMonthlyHours'];

/** Files that must not mention either column in code at all. */
const CLEAN = [
  'src/components/DriverModal.tsx',
  'src/components/DriversManagement.tsx',
  'src/hooks/useDatabase.ts',
  'src/lib/driverRow.ts',
  'src/utils/monthlyPlan/hoursRange.ts',
  'src/utils/monthlyPlan/assign.ts',
  'src/utils/monthlyPlan/validate.ts',
  'src/utils/monthlyPlanDocuments.ts',
  'src/utils/monthlyPlanDocumentBuilders.ts',
  'src/utils/monthlyPlanScreens.ts',
  'src/pages/MonthlyPlanPage.tsx',
];

describe('the monthly-hours columns stay out of the planning path', () => {
  it.each(CLEAN)('%s names neither column in code', file => {
    const code = codeOnly(read(file));
    for (const column of COLUMNS) {
      expect(code, `${file} uses ${column}`).not.toContain(column);
    }
  });

  /**
   * The driver form is the one the owner pointed at. A field cannot come back
   * without an input bound to it, so the test looks for the label keys too —
   * those were removed with the inputs and their presence would mean the pair is
   * on screen again whatever the column is called.
   */
  it('the driver form offers no monthly-hours input', () => {
    const modal = read('src/components/DriverModal.tsx');
    for (const key of ['fleet.targetHoursMonth', 'fleet.maxHoursMonth',
                       'fleet.targetHoursPlaceholder', 'fleet.maxHoursPlaceholder']) {
      expect(modal, `the form still renders ${key}`).not.toContain(key);
    }
  });

  /**
   * §5 forbids `target_monthly_hours` as a displayed figure, which is why the
   * pool's "Monatsziel fehlt" warning went: it asked the operator to fill a
   * field nothing reads. The pool still *reads* both columns — that row is the
   * legacy engine's input — so this asserts on what it shows, not on what it
   * holds.
   */
  it('the driver pool neither shows a Monatsziel nor asks for one', () => {
    const pool = read('src/components/MonatsplanungDriverPool.tsx');
    expect(pool).not.toContain('mp.pool.missingMonthlyTarget');
    expect(pool).not.toContain('mp.pool.fieldMonthlyTarget');
  });

  /**
   * The cap has one source, and `explicit_cap` was the other one's name. Its
   * absence from the type is what makes a second bound impossible to add without
   * the compiler, and this test, both objecting.
   */
  it('the hours range has no explicit-cap source left', () => {
    const raw = read('src/utils/monthlyPlan/hoursRange.ts');
    // The union is read from the RAW file, not from `codeOnly`'s output: those
    // members are string literals, and stripping strings — which is what lets
    // the other assertions ignore comments — would delete the very thing being
    // asserted. The `explicit_cap` check still runs on stripped code, so the
    // comment explaining the removal does not trip it.
    expect(codeOnly(raw)).not.toContain('explicit_cap');
    expect(raw).toContain("'salary' | 'none'");
  });

  /**
   * The boundary, asserted so it cannot be mistaken for an omission: the legacy
   * pipeline is **expected** to still use them. A future change that removes
   * them there has to delete this assertion deliberately, and will then have to
   * answer for editing an untested payroll engine.
   */
  it('the legacy pipeline still uses them, deliberately and on the record', () => {
    const legacy = codeOnly(read('src/utils/monatsplanungPhase3.ts'));
    expect(legacy, 'monatsplanungPhase3 no longer reads max_monthly_hours — if that '
      + 'was deliberate, delete this assertion and say why in the commit')
      .toContain('max_monthly_hours');
  });
});
