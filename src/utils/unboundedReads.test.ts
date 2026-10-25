/**
 * A whole-table read must page, because PostgREST truncates in silence.
 *
 * Supabase caps a response at 1000 rows and returns **no error** when it cuts
 * one off. A `.select('*')` without `.range()` therefore looks like a success
 * and is a partial answer, and every figure computed from it is wrong by
 * however many rows fell off the end.
 *
 * Measured on production 23.10.2026, which is why this file exists: Y&A
 * Mobility held 1025 receipts and `useDatabase.getReceipts` read them with a
 * bare `.order('date')`. It received the oldest 1000, so the 25 newest — every
 * Beleg from 17.10.2026 on — were absent from the Belege list, from
 * Gesamtausgaben and the MwSt total, from Abrechnung's cash expenses and from
 * the Bargeldbestand, whose till was overstated by exactly those receipts. The
 * owner found it by noticing the list stopped; nothing in the product said a
 * word. `income` stood at 854 rows for the same company on the same day, so it
 * was not yet truncated and would have been within months.
 *
 * `src/utils/fetchAllPaginated.ts` already existed and already documented the
 * hazard, and two of the three `income` readers already used it. The defect was
 * never a missing tool — it was that the rule lived in one helper's header, so
 * a caller that did not reach for it lost the property silently. That is what
 * this test turns into something that fails.
 *
 * ## What is flagged, and why the shape is narrow
 *
 * A chain on one of the growable tables below that selects whole rows (`*`) and
 * carries none of `.range()`, `.limit()`, `.single()`, `.maybeSingle()`, and is
 * not keyed to one row by `.eq('id'`. Narrow on purpose: it should fail on a
 * new unpaged list read, not on every piece of PostgREST in the codebase. A
 * write chain (`insert`/`update`/`upsert`/`delete`) is excluded — its
 * `.select('id')` is the touched-row probe of `writeOutcome.ts`, not a read.
 *
 * One case is exempt and is recorded rather than excused by a looser rule.
 * "Keyed to a parent row, therefore bounded" is **false** in general here —
 * `fahrtenbuch_trips.eq('import_id', …)` is keyed to one import and a single
 * import can hold tens of thousands of rides, which is precisely why that read
 * pages. So the exemption names its file, its table and its filter, it carries
 * the measurement behind it, and a run where it matches nothing fails, so a
 * stale line cannot sit here excusing something else.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

/** Tables whose row count grows with use and is not bounded per company. */
const GROWABLE = [
  'receipts', 'income', 'fahrtenbuch_trips', 'cash_transactions',
  'cash_movements', 'salary_payments', 'salaries',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Each `.from('<table>')` chain, up to the statement's end. */
function chains(text: string, table: string): string[] {
  const out: string[] = [];
  const marker = `.from('${table}')`;
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
    const end = text.indexOf(';', at);
    out.push(text.slice(at, end === -1 ? text.length : end));
  }
  return out;
}

/**
 * Recorded exemptions. Each names what it covers precisely enough that it
 * cannot absorb a different defect, with the reason and what would end it.
 */
const EXEMPTIONS = [
  {
    file: 'components/SalaryDetailsModal.tsx',
    table: 'salary_payments',
    filter: ".eq('salary_id'",
    // Bounded by one salary's payments, not by a company's history. Measured on
    // production 23.10.2026: the most any single salary has is 4. Ends if this
    // read is ever keyed on company_id, or on a parent that holds many rows -
    // then it is an ordinary list read and must page.
    reason: 'one salary row; production worst case 4 payments',
  },
];

const exempt = (file: string, table: string, chain: string) =>
  EXEMPTIONS.find(e => file.endsWith(e.file.replace(/\//g, sep)) && e.table === table && chain.includes(e.filter));

const isWrite = (c: string) => /\.(insert|update|upsert|delete)\(/.test(c);
const isBounded = (c: string) =>
  /\.range\(/.test(c) || /\.limit\(/.test(c) ||
  /\.single\(/.test(c) || /\.maybeSingle\(/.test(c) || /\.eq\('id'/.test(c);
const readsWholeRows = (c: string) => /\.select\(\s*'\*'/.test(c);

function offenders(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const table of GROWABLE) {
      for (const chain of chains(text, table)) {
        if (isWrite(chain) || isBounded(chain) || !readsWholeRows(chain)) continue;
        if (exempt(file, table, chain)) continue;
        found.push(`${file.slice(SRC.length + 1)}: ${chain.slice(0, 110).replace(/\s+/g, ' ')}`);
      }
    }
  }
  return found;
}

describe('a whole-table read pages, because PostgREST truncates in silence', () => {
  it('finds the reads at all, so a passing run is not a vacuous one', () => {
    // If the scanner stops matching, every assertion below passes for free.
    const total = sourceFiles(SRC)
      .map(f => readFileSync(f, 'utf8'))
      .reduce((n, t) => n + GROWABLE.reduce((m, tbl) => m + chains(t, tbl).length, 0), 0);
    expect(total).toBeGreaterThan(20);
  });

  it('recognises a paged read as bounded', () => {
    const src = readFileSync(join(SRC, 'pages/OverviewPage.tsx'), 'utf8');
    const income = chains(src, 'income').filter(c => !isWrite(c) && readsWholeRows(c));
    expect(income.length).toBeGreaterThan(0);
    for (const c of income) expect(isBounded(c), c.slice(0, 80)).toBe(true);
  });

  it('every whole-row read of a growable table is bounded', () => {
    expect(offenders()).toEqual([]);
  });

  it('every recorded exemption still matches something', () => {
    // A line that excuses nothing any more is a line that will quietly excuse
    // the next thing that happens to look like it.
    const unmatched = EXEMPTIONS.filter(e => {
      for (const file of sourceFiles(SRC)) {
        if (!file.endsWith(e.file.replace(/\//g, sep))) continue;
        const text = readFileSync(file, 'utf8');
        if (chains(text, e.table).some(c => c.includes(e.filter) && !isWrite(c) && readsWholeRows(c))) return false;
      }
      return true;
    });
    expect(unmatched.map(e => `${e.file} / ${e.table} (${e.reason})`)).toEqual([]);
  });
});
