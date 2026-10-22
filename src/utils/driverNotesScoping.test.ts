/**
 * Every read of `driver_notes` names its company.
 *
 * RLS already confines the table — its SELECT policy is
 * `company_id = get_active_company_id() OR platform_reads_company_data()`, and
 * the platform seam has been a constant `false` since 20260917140000. So a read
 * without the filter is not a leak today, and the one that shipped without it
 * (the Gehaltsabweichung section of `MonatsplanungStundennachweisPreview`) was
 * answering correctly.
 *
 * It is pinned anyway, for the reason this repository keeps writing down: a
 * property that holds because of one policy, in one of seven call sites, is a
 * property nobody can see. Six reads carried the filter and one did not, and
 * nothing would have reported the odd one out. If the policy is ever restated
 * and loses its tenant term, the six stay correct and the seventh starts
 * answering across companies — silently, on the screen that feeds the
 * Stundennachweis an accountant receives.
 *
 * A write is deliberately not checked here. `driver_notes` INSERT is policed by
 * `WITH CHECK` on the same predicate, and `NotesPage`'s insert builds its
 * payload with `company_id` as a column rather than a filter, which this
 * scanner would not recognise and must not fail on.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** The chain from `.from('driver_notes')` up to the statement's end. */
function readChains(text: string): string[] {
  const out: string[] = [];
  const marker = ".from('driver_notes')";
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
    // A supabase chain ends at the first semicolon after it; that is enough to
    // hold every `.eq()` of the statement and nothing of the next one.
    const end = text.indexOf(';', at);
    const chain = text.slice(at, end === -1 ? text.length : end);
    // Reads only: an insert/update/delete scopes itself differently.
    if (chain.includes('.select(')) out.push(chain);
  }
  return out;
}

describe('driver_notes reads are company-scoped in the query, not only by policy', () => {
  const files = sourceFiles(SRC);

  it('finds the reads at all, so a passing run is not a vacuous one', () => {
    const total = files.reduce((n, f) => n + readChains(readFileSync(f, 'utf8')).length, 0);
    // Seven today: NotesPage, MonthlyPlanPage, both Monatsplanung previews,
    // HistoricalWorkingHoursWizard and StundennachweisPage twice.
    expect(total).toBeGreaterThanOrEqual(7);
  });

  it('every one of them filters on company_id', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const chain of readChains(readFileSync(file, 'utf8'))) {
        if (!chain.includes("company_id")) {
          offenders.push(`${file.slice(SRC.length + 1)}: ${chain.slice(0, 120).replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
