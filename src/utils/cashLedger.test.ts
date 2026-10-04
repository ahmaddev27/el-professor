import { describe, expect, it } from 'vitest';
import {
  bargeldIncomeEntries,
  belegEntries,
  cashBelegRows,
  cashLedgerDriverNames,
  cashMovementEntries,
  filterCashEntries,
  sortCashEntriesByDateDesc,
  summarizeCashLedger,
  type CashLedgerLabels,
  type CashMovementRow,
} from './cashLedger';

const labels: CashLedgerLabels = {
  bargeldIncome: 'Bargeld Einnahme',
  beleg: 'Beleg',
  gehaltsquittung: 'Gehaltsquittung',
  gehaltsquittungStorno: 'Storno Gehaltsquittung',
  manualIn: 'Bargeld eingelegt',
  manualOut: 'Barzahlung',
  other: 'Bargeldbewegung',
};

/** A month of Bargeld, as income rows read. */
const income = [
  { id: 'i1', amount: '1000.00', description: null, driver_name: 'Ali', date: '2026-03-02' },
  { id: 'i2', amount: 250.5, description: 'Woche 10', driver_name: 'Bea', date: '2026-03-09' },
];

/** Belege, one of them with the NULL expense the column still allows. */
const belege = [
  { id: 'b1', expense: '40.25', description: 'Tanken', driver_name: 'Ali', date: '2026-03-03' },
  { id: 'b2', expense: null, description: 'Wäsche', driver_name: 'Bea', date: '2026-03-04' },
];

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

describe('summarizeCashLedger', () => {
  it('is Bargeld minus Belege when no Gehaltsquittung was ever confirmed', () => {
    // The figure the screen showed before 4.3b, and the parity the staging
    // comparison checks per company and per month.
    const totals = summarizeCashLedger([
      ...bargeldIncomeEntries(income, labels),
      ...belegEntries(belege, labels),
    ]);

    expect(totals.bargeldIncomeCents).toBe(125050);
    expect(totals.belegExpenseCents).toBe(4025);
    expect(totals.salaryPayoutCents).toBe(0);
    expect(totals.balanceCents).toBe(125050 - 4025);
  });

  it('sums in exact cents, where a float accumulation drifts', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `i${i}`,
      amount: '0.10',
      description: null,
      driver_name: null,
      date: '2026-03-01',
    }));
    rows.push({ id: 'i9', amount: '0.20', description: null, driver_name: null, date: '2026-03-01' });

    expect(summarizeCashLedger(bargeldIncomeEntries(rows, labels)).balanceCents).toBe(50);
  });

  it('takes a confirmed Gehaltsquittung out of the till', () => {
    const totals = summarizeCashLedger([
      ...bargeldIncomeEntries(income, labels),
      ...belegEntries(belege, labels),
      ...cashMovementEntries([movement({ id: 'm1' })], labels),
    ]);

    expect(totals.salaryPayoutCents).toBe(30000);
    expect(totals.cashOutCents).toBe(4025 + 30000);
    expect(totals.balanceCents).toBe(125050 - 4025 - 30000);
    // The identity the screen's three cards add up to.
    expect(totals.balanceCents).toBe(
      totals.bargeldIncomeCents - totals.belegExpenseCents - totals.salaryPayoutCents,
    );
  });

  it('counts a partial payment as the cash that actually left, not the salary due', () => {
    // 300,00 € paid against a salary of 1.000,00 €, then 150,00 € more. The
    // ledger knows only the two payments; nothing here reads the salary.
    const movements = [
      movement({ id: 'm1', amount: '300.00', source_id: 'r1' }),
      movement({ id: 'm2', amount: '150.00', source_id: 'r2', movement_date: '2026-03-20' }),
    ];

    expect(summarizeCashLedger(cashMovementEntries(movements, labels)).salaryPayoutCents).toBe(45000);
  });

  it('books a voided receipt back on the day of the void, not the day it was paid', () => {
    // Paid 15.03., voided 04.04.: March stays lowered, April is raised, and the
    // two cancel only over a range that holds both. That is the cash-book rule
    // in 20260914140000, not an accident of filtering.
    const entries = [
      ...bargeldIncomeEntries(income, labels),
      ...belegEntries(belege, labels),
      ...cashMovementEntries(
        [
          movement({ id: 'm1', amount: '300.00', movement_date: '2026-03-15' }),
          movement({
            id: 'm2',
            amount: '300.00',
            movement_date: '2026-04-04',
            direction: 'in',
            source_type: 'gehaltsquittung_storno',
            description: 'Storno Gehaltsquittung GQ-2026-0001',
          }),
        ],
        labels,
      ),
    ];

    const march = summarizeCashLedger(filterCashEntries(entries, { from: '2026-03-01', to: '2026-03-31' }));
    const april = summarizeCashLedger(filterCashEntries(entries, { from: '2026-04-01', to: '2026-04-30' }));
    const both = summarizeCashLedger(entries);

    expect(march.salaryPayoutCents).toBe(30000);
    expect(march.balanceCents).toBe(125050 - 4025 - 30000);
    expect(april.salaryPayoutCents).toBe(-30000);
    expect(april.cashInCents).toBe(30000);
    expect(both.salaryPayoutCents).toBe(0);
    expect(both.balanceCents).toBe(125050 - 4025);
  });

  it('leaves the till alone for "Bar zurück"', () => {
    // The weekly cash difference is a salary_payments row with
    // source_type = 'weekly_cash_difference' and no cash_movements row at all:
    // paid, but kept back from a settlement rather than handed out. The ledger
    // is the only source here and salary_payments is never read, so a weekly
    // settlement contributes no entry to count in the first place.
    const entries = cashMovementEntries([movement({ id: 'm1', amount: '300.00' })], labels);

    expect(entries).toHaveLength(1);
    expect(summarizeCashLedger(entries).salaryPayoutCents).toBe(30000);
  });

  it('keeps a movement of an unknown source in the balance instead of losing the cash', () => {
    // The CHECK in 20260914140000 allows only the two Gehaltsquittung sources
    // today, so this row cannot exist yet. When a later migration adds one —
    // a float top-up, a deposit — it moves real cash, and a till that hides
    // cash is worse than one that categorises it loosely. Direction decides
    // the balance; only the categorisation falls back to "other".
    const entries = cashMovementEntries(
      [
        movement({ id: 'm1', amount: '300.00' }),
        movement({
          id: 'm2',
          amount: '90.00',
          direction: 'in',
          source_type: 'kassensturz_einlage',
          source_id: 'k1',
          description: null,
        }),
      ],
      labels,
    );
    const totals = summarizeCashLedger(entries);

    expect(entries.map(e => e.source)).toEqual(['gehaltsquittung', 'other']);
    // No source label of its own, so it falls back to the neutral one.
    expect(entries[1].description).toBe('Bargeldbewegung');
    expect(totals.cashInCents).toBe(9000);
    expect(totals.balanceCents).toBe(9000 - 30000);
    // It belongs to no card: the three categories do not explain the balance
    // any more, which is the visible consequence of not dropping the row.
    expect(totals.salaryPayoutCents).toBe(30000);
    expect(totals.bargeldIncomeCents).toBe(0);
  });

  it('reads a NULL expense as zero, the way the column default does', () => {
    expect(summarizeCashLedger(belegEntries([belege[1]], labels)).belegExpenseCents).toBe(0);
  });

  it('refuses an amount that is not a decimal rather than silently zeroing it', () => {
    expect(() => bargeldIncomeEntries([{ ...income[0], amount: '1.234,56' }], labels)).toThrow(RangeError);
  });
});

describe('entry building', () => {
  it('falls back to the label only when the row carries no description', () => {
    const [withText, withoutText] = bargeldIncomeEntries(
      [income[1], { ...income[0], description: '' }],
      labels,
    );
    expect(withText.description).toBe('Woche 10');
    expect(withoutText.description).toBe('Bargeld Einnahme');
  });

  it('names the driver of a payout through its receipt', () => {
    const [entry] = cashMovementEntries([movement({ id: 'm1', source_id: 'r1' })], labels, { r1: 'Ali' });
    expect(entry.driverName).toBe('Ali');
    expect(entry.source).toBe('gehaltsquittung');
  });

  it('leaves a payout without a driver when its receipt is not in the lookup', () => {
    const [entry] = cashMovementEntries([movement({ id: 'm1', source_id: 'gone' })], labels, { r1: 'Ali' });
    expect(entry.driverName).toBe('');
  });
});

describe('cashBelegRows — only a Beleg paid in cash left the till', () => {
  /**
   * The rule: `receipts.payment_method` is `'bar'` or `'uberweisung'`, and only
   * `'bar'` moved money out of the cash box. `abrechnung_weekly` and
   * `get_current_cash_balance` have always restricted to `'bar'`; the
   * Bargeldbestand did not ask for the column at all, so it charged a bank
   * transfer to the till and read lower than the till was. Measured on
   * staging's copy of production, 28.09.2026: 853 `'bar'`, 4 `'uberweisung'`
   * (189,91 €), 0 NULL.
   */
  const mixed = [
    { id: 'b1', expense: '40.25', description: 'Tanken',  driver_name: 'Ali', date: '2026-04-03', payment_method: 'bar' },
    { id: 'b2', expense: '110.00', description: 'Reifen', driver_name: 'Ali', date: '2026-04-11', payment_method: 'uberweisung' },
  ];

  it('keeps the cash Beleg and drops the bank transfer', () => {
    expect(cashBelegRows(mixed).map(r => r.id)).toEqual(['b1']);
  });

  it('is what the till balance now reads', () => {
    const totals = summarizeCashLedger([
      ...bargeldIncomeEntries(
        [{ id: 'i1', amount: '500.00', description: null, driver_name: 'Ali', date: '2026-04-02' }],
        labels,
      ),
      ...belegEntries(cashBelegRows(mixed), labels),
    ]);

    expect(totals.belegExpenseCents).toBe(4025);
    expect(totals.balanceCents).toBe(50000 - 4025);
  });

  /**
   * The negative control: the old figure, spelled out. `belegEntries` still
   * counts every row it is given — `utils/overviewHelpers.ts` passes a row
   * shape that carries no `payment_method` and must keep the figure it has —
   * so the exclusion has to come from `cashBelegRows` and from nowhere else. If
   * a later change moves the filter inside `belegEntries`, this fails.
   */
  it('was 189,91 € worth of bank Belege too low, and belegEntries alone still is', () => {
    const unfiltered = summarizeCashLedger(belegEntries(mixed, labels));
    expect(unfiltered.belegExpenseCents).toBe(4025 + 11000);
  });

  it("excludes a NULL exactly as SQL's `payment_method = 'bar'` excludes it", () => {
    const rows = [
      { id: 'n1', expense: '10.00', date: '2026-04-01', payment_method: null },
      { id: 'n2', expense: '10.00', date: '2026-04-01' },
      { id: 'n3', expense: '10.00', date: '2026-04-01', payment_method: 'BAR' },
      { id: 'n4', expense: '10.00', date: '2026-04-01', payment_method: 'bar' },
    ];
    expect(cashBelegRows(rows).map(r => r.id)).toEqual(['n4']);
  });
});

describe('filtering and ordering', () => {
  const entries = [
    ...bargeldIncomeEntries(income, labels),
    ...belegEntries(belege, labels),
    ...cashMovementEntries([movement({ id: 'm1', movement_date: '2026-03-15' })], labels, { r1: 'Ali' }),
  ];

  it('filters by driver across every source', () => {
    const ali = filterCashEntries(entries, { driverName: 'Ali' });
    expect(ali.map(e => e.id).sort()).toEqual(['b1', 'i1', 'm1']);
  });

  it('filters by direction', () => {
    expect(filterCashEntries(entries, { direction: 'out' }).map(e => e.id).sort()).toEqual(['b1', 'b2', 'm1']);
  });

  it('compares dates as text, inclusive at both ends', () => {
    const range = filterCashEntries(entries, { from: '2026-03-03', to: '2026-03-09' });
    expect(range.map(e => e.id).sort()).toEqual(['b1', 'b2', 'i2']);
  });

  it('orders newest first and breaks ties by id', () => {
    const sorted = sortCashEntriesByDateDesc(entries);
    expect(sorted.map(e => e.date)).toEqual([
      '2026-03-15', '2026-03-09', '2026-03-04', '2026-03-03', '2026-03-02',
    ]);
  });

  it('offers every driver the ledger knows, once, sorted', () => {
    expect(cashLedgerDriverNames(entries)).toEqual(['Ali', 'Bea']);
  });
});


describe('manual till entries (record_cash_movement)', () => {
  it('count by direction, in their own totals, and never touch the salary figure', () => {
    const entries = cashMovementEntries(
      [
        { id: 'a', direction: 'in', amount: '500.00', movement_date: '2026-04-02', source_type: 'manual_in', source_id: 'r1', description: null },
        { id: 'b', direction: 'out', amount: '120.50', movement_date: '2026-04-03', source_type: 'manual_out', source_id: 'r2', description: 'Reinigung' },
      ],
      labels,
    );
    const totals = summarizeCashLedger(entries);
    expect(entries.map(e => e.source)).toEqual(['manual_in', 'manual_out']);
    expect(entries[0].description).toBe('Bargeld eingelegt');
    expect(totals.manualInCents).toBe(50000);
    expect(totals.manualOutCents).toBe(12050);
    expect(totals.balanceCents).toBe(50000 - 12050);
    expect(totals.salaryPayoutCents).toBe(0);
  });
});
