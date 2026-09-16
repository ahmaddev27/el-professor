import { describe, expect, it } from 'vitest';
import {
  bargeldIncomeEntries,
  belegEntries,
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
    // is the only source here, so there is nothing to double-count.
    const entries = cashMovementEntries(
      [
        movement({ id: 'm1', amount: '300.00' }),
        // What a weekly_cash_difference row would look like if anything ever
        // wrote one into the ledger: it is not a source this screen reads.
        movement({ id: 'm2', amount: '90.00', source_type: 'weekly_cash_difference', source_id: 'w1' }),
      ],
      labels,
    );

    expect(entries).toHaveLength(1);
    expect(summarizeCashLedger(entries).salaryPayoutCents).toBe(30000);
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
