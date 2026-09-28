/**
 * Three money screens, three failures that said nothing.
 *
 * These are source assertions, not renders. The three fixes live inside pages
 * of 550, 1,170 and 4,000 lines that no test can mount — there is no renderer
 * in this suite — and each of them is one line that a later edit can drop with
 * no symptom at all: a column missing from a `select`, an `.error` never read,
 * a `catch` that only logs. `subscriptionDirectWrites.test.ts` and
 * `planFeatures.test.ts` already guard rules this way, by reading the source
 * that ships. Each assertion below carries its negative control: the shape the
 * code had before the fix, stated so that a regression fails here instead of
 * being reasoned about.
 *
 * What they cannot check: that the screens then draw the right thing. That
 * needs the design harness (`npm run harness`), not vitest.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8');
}

/**
 * The text between two anchors, searching for `close` only after `open`. Brace
 * counting would have to know about braces inside strings, comments and JSX;
 * an anchor pair chosen per call does not.
 */
function between(source: string, open: string, close: string): string {
  const start = source.indexOf(open);
  // A plain throw, not expect(): this runs while the file is collected, not
  // inside a test. An anchor that moved is a failure worth reading as one.
  if (start === -1) throw new Error(`anchor not found: ${open}`);
  const end = source.indexOf(close, start + open.length);
  if (end === -1) throw new Error(`closing anchor not found after ${open}: ${close}`);
  return source.slice(start, end + close.length);
}

describe('BargeldbestandPage asks which Belege were paid in cash', () => {
  const source = read('pages/BargeldbestandPage.tsx');

  /**
   * The rule: only `receipts.payment_method = 'bar'` left the till, which is
   * what `abrechnung_weekly` and `get_current_cash_balance` have always read.
   * The screen has to *ask* for the column before `cashBelegRows` can apply it
   * — and because that helper keeps nothing when the key is absent, dropping
   * the column from the select would show a Belege total of 0,00 € rather than
   * the old, too-low balance. Both halves are pinned.
   */
  const receiptsRead = between(source, 'fetchAllPaginated<BelegRow>(', '.range(from, to),');

  it('selects payment_method on the receipts read', () => {
    expect(receiptsRead).toContain("from('receipts')");
    expect(receiptsRead).toMatch(/\.select\('[^']*payment_method[^']*'\)/);
  });

  it('passes the receipt rows through cashBelegRows before counting them', () => {
    expect(source).toContain('cashBelegRows,');
    expect(source).toContain('belegEntries(cashBelegRows(receiptRows), ledgerLabels)');
  });

  /**
   * The negative control: the shape that charged a bank transfer to the till.
   * On staging's copy of production (28.09.2026) that was 4 of 857 Belege,
   * 189,91 € — 110,00 € in 04/2026 and 79,91 € in 05/2026 — so the balance,
   * both cards and the Excel dump read lower than the cash box held.
   */
  it('no longer counts every Beleg', () => {
    expect(source).not.toContain('belegEntries(receiptRows, ledgerLabels)');
  });
});

describe('AbrechnungPage does not print a Tankenquote it failed to read', () => {
  const source = read('pages/AbrechnungPage.tsx');
  const body = between(source, 'const fetchTankenAndUmsatz = async (', '\n  };');

  it('throws on either failed read', () => {
    expect(body).toContain('if (receiptsRes.error) throw receiptsRes.error;');
    expect(body).toContain('if (incomeRes.error) throw incomeRes.error;');
  });

  /**
   * The negative control, as an ordering: `data` is null on an error, so
   * `?? []` turns a refusal into zero. With the receipts read failed and the
   * income read fine that was `0 / umsatz` — **Tankenquote 0,00 %** printed on
   * the card html2canvas renders and the driver is sent. Both throws have to
   * come before the first `.data` is read, or the zero is back.
   */
  it('reads no .data before both errors are checked', () => {
    const lastThrow = Math.max(
      body.indexOf('throw receiptsRes.error'),
      body.indexOf('throw incomeRes.error'),
    );
    const firstDataRead = Math.min(
      ...[body.indexOf('receiptsRes.data'), body.indexOf('incomeRes.data')].filter(i => i > -1),
    );
    expect(lastThrow).toBeGreaterThan(-1);
    expect(firstDataRead).toBeGreaterThan(lastThrow);
  });

  /**
   * The failure path is the one the callers already had — their `catch` shows
   * `abr.detailsFailed` and the modal is never opened. Deliberately *not*
   * `loadFailed`, which blanks the whole Abrechnung table although its own RPC
   * read succeeded; CLAUDE.md asks for exactly one failure state per screen,
   * and this screen's is that table's.
   */
  it('clears any modal data instead of leaving a half-loaded card up', () => {
    const occurrences = source.split('setDetailModalData(null);').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe('StundennachweisPage says when a save was refused', () => {
  const source = read('pages/StundennachweisPage.tsx');
  const saveCatch = between(
    source.slice(source.indexOf('const handleSave = async ()')),
    '} catch (e) {',
    '} finally {',
  );

  it('puts the refusal in state, not only in the console', () => {
    expect(saveCatch).toContain('setSaveError(');
  });

  /**
   * The negative control: the catch used to be a bare `console.error`, so a
   * save refused by RLS — a platform support session, or a role without the
   * `stundennachweise` gate, neither of which needs a network fault — left the
   * button back at "Speichern" with no way to tell a stored sheet from a lost
   * one. 31 saved Stundennachweise exist on staging's copy of production.
   */
  it('is more than a console.error', () => {
    const statements = saveCatch
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('//') && !line.startsWith('}'));
    expect(statements.some(line => line.startsWith('console.error'))).toBe(true);
    expect(statements.filter(line => !line.startsWith('console.error')).length).toBeGreaterThan(0);
  });

  it('renders it as a critical Alert', () => {
    expect(source).toMatch(/\{saveError && \(\s*<Alert tone="critical"/);
  });

  it('clears the message when the next save starts, so a stale refusal cannot linger', () => {
    expect(source).toContain('setSaveError(null)');
  });

  /** One failure state and nothing else, as CLAUDE.md asks for this batch. */
  it('adds exactly one state', () => {
    const declarations = source.match(/const \[saveError, setSaveError\] = useState/g) ?? [];
    expect(declarations).toHaveLength(1);
  });
});
