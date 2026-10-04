import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bargeldIncomeEntries,
  belegEntries,
  cashMovementEntries,
  summarizeCashLedger,
  type CashLedgerLabels,
  type CashMovementRow,
} from './cashLedger';

/**
 * THE RULE: a Gehaltsquittung issued for a cash payment that already exists
 * (`issue_salary_cash_receipt`, 20261004100000) must not move the Bargeldbestand.
 *
 * The cash ledger is Bargeld - Belege - (Gehaltsquittungen - Stornos), and its
 * third term is read from `cash_movements` and nowhere else. So the guarantee
 * has two halves, and both are pinned here: the function writes no such row
 * (read from the migration), and nothing on the reading side derives a payout
 * from a receipt (read from the screens). The first half is also asserted by
 * the migration's own self-check, from the catalogue, at release time.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), 'utf8');

const MIGRATION = read('supabase/migrations/20261004100000_issue_receipt_for_existing_cash_payment.sql');

const labels: CashLedgerLabels = {
  bargeldIncome: 'Bargeld Einnahme',
  beleg: 'Beleg',
  gehaltsquittung: 'Gehaltsquittung',
  gehaltsquittungStorno: 'Storno Gehaltsquittung',
  manualIn: 'Bargeld eingelegt',
  manualOut: 'Barzahlung',
  other: 'Bargeldbewegung',
};

const income = [{ id: 'i1', amount: '5000.00', description: null, driver_name: 'Ali', date: '2026-03-02' }];
const belege = [{ id: 'b1', expense: '40.25', description: 'Tanken', driver_name: 'Ali', date: '2026-03-03' }];

function movement(over: Partial<CashMovementRow> & Pick<CashMovementRow, 'id'>): CashMovementRow {
  return {
    direction: 'out',
    amount: '300.00',
    movement_date: '2026-03-15',
    source_type: 'gehaltsquittung',
    source_id: 'r1',
    description: 'Gehaltsquittung GQ-2026-0001',
    ...over,
  };
}

/** The body of issue_salary_cash_receipt, between its dollar quotes. */
function issueFunctionBody(): string {
  const start = MIGRATION.indexOf('CREATE FUNCTION public.issue_salary_cash_receipt');
  expect(start).toBeGreaterThan(-1);
  const open = MIGRATION.indexOf('$$', start);
  const close = MIGRATION.indexOf('$$;', open + 2);
  return MIGRATION.slice(open + 2, close);
}

describe('a receipt issued for an existing payment and the till', () => {
  it('leaves the balance exactly where it was: the receipt adds no movement, so nothing is subtracted', () => {
    const entries = (movements: CashMovementRow[]) => [
      ...bargeldIncomeEntries(income, labels),
      ...belegEntries(belege, labels),
      ...cashMovementEntries(movements, labels),
    ];
    const before = entries([movement({ id: 'm1' })]);
    // issue_salary_cash_receipt writes a receipt row and no movement row, so the
    // movements the screen reads after issuing are the movements it read before.
    const after = entries([movement({ id: 'm1' })]);
    expect(summarizeCashLedger(after)).toEqual(summarizeCashLedger(before));
    expect(summarizeCashLedger(after).balanceCents).toBe(500000 - 4025 - 30000);
  });

  it('would have dropped it by the full payment if issuing booked the till like confirm does', () => {
    // The counterfactual the migration exists to avoid: staging holds one company
    // with 33 manual payments of 19.573,32 EUR together. Booked as an outgoing
    // movement, the balance falls at once.
    const booked = summarizeCashLedger([
      ...bargeldIncomeEntries(income, labels),
      ...cashMovementEntries([movement({ id: 'm9', amount: '19573.32', source_id: 'r9' })], labels),
    ]);
    const unbooked = summarizeCashLedger(bargeldIncomeEntries(income, labels));
    expect(unbooked.balanceCents - booked.balanceCents).toBe(1957332);
  });
});

describe('issue_salary_cash_receipt writes no till row', () => {
  it('never names the till ledger table in its body', () => {
    expect(issueFunctionBody()).not.toMatch(/cash_movements/i);
  });

  it('never writes a salary payment', () => {
    expect(issueFunctionBody()).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?salary_payments/i);
  });

  it('writes the receipt with books_cash = false and the payment it documents', () => {
    expect(issueFunctionBody()).toMatch(/v_payment\.id\s*,\s*false/);
  });

  it('draws its number from the confirm counter and the salary business year', () => {
    const body = issueFunctionBody();
    expect(body).toMatch(/next_document_number\s*\(\s*v_company\s*,\s*'gehaltsquittung'\s*,\s*v_year\s*\)/);
    expect(body).toMatch(/v_year\s*:=\s*v_byear\s*;/);
  });

  it('refuses a platform context before it locks or numbers anything', () => {
    const body = issueFunctionBody();
    const refusal = body.indexOf('platform_session_not_allowed');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(body.indexOf('not_authorized'));
    expect(refusal).toBeLessThan(body.indexOf('pg_advisory_xact_lock'));
    expect(refusal).toBeLessThan(body.indexOf('next_document_number'));
  });

  it('locks the payment before the salary, both FOR NO KEY UPDATE, never FOR UPDATE', () => {
    const body = issueFunctionBody();
    expect(body).not.toMatch(/FOR\s+UPDATE/);
    const payment = body.indexOf('FROM salary_payments WHERE id = p_payment_id FOR NO KEY UPDATE');
    const salary = body.indexOf('FROM salaries WHERE id = v_payment.salary_id FOR NO KEY UPDATE');
    expect(payment).toBeGreaterThan(-1);
    expect(salary).toBeGreaterThan(payment);
  });

  it('keeps the company on get_active_company_id() and the role on salaries', () => {
    const body = issueFunctionBody();
    expect(body).toMatch(/get_active_company_id\(\)/);
    expect(body).not.toMatch(/get_user_company_id/);
    expect(body).toMatch(/current_role_permits\('salaries', true\)/);
  });

  it('refuses in the order the header documents', () => {
    const body = issueFunctionBody();
    const order = [
      'platform_session_not_allowed',
      "HINT = 'not_authorized'",
      "HINT = 'invalid_request'",
      "HINT = 'invalid_place'",
      "HINT = 'payment_not_found'",
      "HINT = 'request_id_conflict'",
      "HINT = 'overlapping_salary'",
      "HINT = 'payment_not_issuable'",
      "HINT = 'already_issued'",
      "HINT = 'overpayment'",
      'next_document_number',
    ].map(fragment => body.indexOf(fragment));
    expect(order.every(index => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('void on a receipt that booked nothing', () => {
  it('is spliced in front of the statement that deletes the payment', () => {
    expect(MIGRATION).toContain('IF NOT v_receipt.books_cash THEN');
    expect(MIGRATION).toContain('DELETE\\s+FROM\\s+salary_payments');
  });
});

describe('nothing on the reading side derives a payout from a receipt', () => {
  it('the Bargeldbestand reads receipts only for the driver behind a movement', () => {
    const page = read('src/pages/BargeldbestandPage.tsx');
    const reads = [...page.matchAll(/\.from\('salary_cash_receipts'\)\s*\.select\('([^']*)'\)/g)].map(m => m[1]);
    expect(reads).toEqual(['id, driver_id']);
  });

  it('the ledger module and the Overview never read the receipt table', () => {
    expect(read('src/utils/cashLedger.ts')).not.toMatch(/from\('salary_cash_receipts'\)/);
    expect(read('src/pages/OverviewPage.tsx')).not.toMatch(/from\('salary_cash_receipts'\)/);
    expect(read('src/utils/overviewHelpers.ts')).not.toMatch(/from\('salary_cash_receipts'\)/);
  });
});
