import { describe, expect, it } from 'vitest';
import { de } from '../i18n/de';
import { en } from '../i18n/en';
import {
  PAYMENT_FIELD_LOCK_KEYS,
  PAYMENT_WRITE_REFUSAL_KEYS,
  decidePaymentWrite,
  paymentFieldLock,
  type PaymentWriteRefusal,
} from './salaryPaymentWrite';

/**
 * Which salary payment is written straight into `salary_payments`, and which
 * stored row is frozen.
 *
 * **Owner, 04.10.2026, reversing 17.09.2026:** a cash payment added by hand is a
 * plain row again. These tests pin the reversal and, more importantly, pin what
 * it must NOT drag with it — because the module exists to keep three cash paths
 * apart, and only one of them changed.
 *
 * The money rule underneath is unchanged: the till is `cash_movements`, and only
 * the three Gehaltsquittung RPCs write it. Nothing this module decides moves
 * money. What the reversal costs is that a cash payment recorded here does not
 * lower the Bargeldbestand — the same state as the 34 pre-17.09 cash rows, and
 * the state `issue_salary_cash_receipt` was built for.
 */

describe('decidePaymentWrite', () => {
  describe('a payment the user adds', () => {
    it('is inserted directly, whether cash or bank — no Gehaltsquittung step', () => {
      // The screen the owner photographed: a cash payment handed itself to the
      // three-step receipt wizard instead of saving. "Once I click continue it
      // must be saved, so this popup must not be shown."
      expect(decidePaymentWrite({ origin: 'add', paymentType: 'cash' })).toEqual({ kind: 'insert' });
      expect(decidePaymentWrite({ origin: 'add', paymentType: 'bank' })).toEqual({ kind: 'insert' });
    });

    it('never answers anything but insert, whatever else is handed in', () => {
      // An `add` carries no stored row. If one were ever passed — a half-wired
      // edit, a copied call site — it must not reach the frozen-row branches and
      // refuse the save the owner asked to be unconditional.
      expect(
        decidePaymentWrite({
          origin: 'add',
          paymentType: 'cash',
          amount: 500,
          existing: { payment_type: 'cash', source_type: 'gehaltsquittung', amount: 100 },
        }),
      ).toEqual({ kind: 'insert' });
    });
  });

  describe('the weekly Bar zurück never becomes a receipt', () => {
    it('stays a plain insert although the row it writes is cash', () => {
      expect(decidePaymentWrite({ origin: 'weekly_cash_difference' })).toEqual({ kind: 'insert' });
    });

    it('stays a plain insert even when a cash payment type is handed in with it', () => {
      // The caller writes payment_type: 'cash' for this row. It is money the
      // driver kept out of a weekly settlement: paid in the salary's books, and
      // the till never saw it. paymentRowCanBeIssued keeps a receipt off it too.
      expect(decidePaymentWrite({ origin: 'weekly_cash_difference', paymentType: 'cash' })).toEqual({
        kind: 'insert',
      });
    });
  });

  describe('an ordinary stored cash row is editable again', () => {
    const cash = { payment_type: 'cash', source_type: 'manual', amount: 100 } as const;

    it('takes a changed amount, because no ledger row stands behind it either way', () => {
      // This refused until 04.10.2026, and the sentence it refused with told the
      // user to delete the row and record it again "because the new cash payment
      // creates a Gehaltsquittung and books the amount out of the cash box".
      // That stopped being true when the add path stopped doing it.
      expect(decidePaymentWrite({ origin: 'edit', paymentType: 'cash', amount: 5000, existing: cash })).toEqual({
        kind: 'update',
      });
    });

    it('takes a switch to a bank transfer, and a bank row a switch to cash', () => {
      expect(decidePaymentWrite({ origin: 'edit', paymentType: 'bank', amount: 100, existing: cash })).toEqual({
        kind: 'update',
      });
      expect(
        decidePaymentWrite({
          origin: 'edit',
          paymentType: 'cash',
          amount: 100,
          existing: { payment_type: 'bank', source_type: 'manual', amount: 100 },
        }),
      ).toEqual({ kind: 'update' });
    });

    it('takes a weekly row the same way — it moved no cash either', () => {
      expect(
        decidePaymentWrite({
          origin: 'edit',
          paymentType: 'cash',
          amount: 400,
          existing: { payment_type: 'cash', source_type: 'weekly_cash_difference', amount: 200 },
        }),
      ).toEqual({ kind: 'update' });
    });
  });

  describe('a row behind a receipt is frozen, and both database triggers say so', () => {
    it('refuses every edit of a row written by a Gehaltsquittung', () => {
      // 20260914140000's trigger refuses the UPDATE anyway; this is the sentence
      // a person can read instead of a database error. Voiding the receipt is the
      // only way such a payment leaves the salary.
      for (const paymentType of ['cash', 'bank'] as const) {
        expect(
          decidePaymentWrite({
            origin: 'edit',
            paymentType,
            amount: 300,
            existing: { payment_type: 'cash', source_type: 'gehaltsquittung', amount: 300 },
          }),
        ).toEqual({ kind: 'refused', refusal: 'receipt_payment_locked' });
      }
    });

    it('refuses an edit of a payment that has been issued a receipt after the fact', () => {
      // salary_payments_issued_receipt_guard (20261004110000) is BEFORE UPDATE OR
      // DELETE. paymentRowActions already hides this row's pencil, so this is the
      // second wall — and it is the one the freeze removed above used to provide
      // by accident, which is why it is written down rather than assumed.
      expect(
        decidePaymentWrite({
          origin: 'edit',
          paymentType: 'cash',
          amount: 300,
          existing: { payment_type: 'cash', source_type: 'manual', amount: 300, issued_receipt_id: 'r-1' },
        }),
      ).toEqual({ kind: 'refused', refusal: 'issued_receipt_locked' });
    });

    it('treats a blank or absent receipt id as no receipt, never as one', () => {
      // A refusal keyed on a whitespace string would freeze an ordinary row; a
      // write allowed on a real id would be refused by the database instead.
      for (const id of ['', '   ', null, undefined]) {
        expect(
          decidePaymentWrite({
            origin: 'edit',
            paymentType: 'cash',
            amount: 300,
            existing: { payment_type: 'cash', source_type: 'manual', amount: 300, issued_receipt_id: id },
          }),
        ).toEqual({ kind: 'update' });
      }
    });
  });

  describe('an edit with no row to edit', () => {
    it('is refused rather than falling through to a write', () => {
      // Unreachable from either call site today. The module is the single
      // authority for this decision, so it answers instead of defaulting.
      expect(decidePaymentWrite({ origin: 'edit', paymentType: 'cash', amount: 100 })).toEqual({
        kind: 'refused',
        refusal: 'payment_not_found',
      });
      expect(decidePaymentWrite({ origin: 'edit', paymentType: 'bank', existing: null })).toEqual({
        kind: 'refused',
        refusal: 'payment_not_found',
      });
    });
  });
});

/*
  The form disables what it may not change rather than accepting it and
  refusing on submit: a field that takes a value and then rejects it teaches
  that the change is possible and merely disallowed today.
*/
describe('paymentFieldLock', () => {
  it('leaves a new payment and every ordinary stored row open', () => {
    expect(paymentFieldLock(null)).toBe('none');
    expect(paymentFieldLock(undefined)).toBe('none');
    expect(paymentFieldLock({ payment_type: 'bank', source_type: 'manual', amount: 100 })).toBe('none');
    expect(paymentFieldLock({ payment_type: 'cash', source_type: 'manual', amount: 100 })).toBe('none');
    expect(paymentFieldLock({ payment_type: 'cash', source_type: 'weekly_cash_difference', amount: 100 })).toBe(
      'none',
    );
  });

  it('locks the two kinds of row a database trigger refuses', () => {
    expect(paymentFieldLock({ payment_type: 'cash', source_type: 'gehaltsquittung', amount: 300 })).toBe('receipt');
    expect(
      paymentFieldLock({ payment_type: 'cash', source_type: 'manual', amount: 300, issued_receipt_id: 'r-1' }),
    ).toBe('issued_receipt');
  });

  it('agrees with decidePaymentWrite on every row, so the form cannot disable what it would save', () => {
    const rows = [
      { payment_type: 'bank', source_type: 'manual', amount: 100 },
      { payment_type: 'cash', source_type: 'manual', amount: 100 },
      { payment_type: 'cash', source_type: 'weekly_cash_difference', amount: 100 },
      { payment_type: 'cash', source_type: 'gehaltsquittung', amount: 100 },
      { payment_type: 'cash', source_type: 'manual', amount: 100, issued_receipt_id: 'r-1' },
    ] as const;
    for (const existing of rows) {
      const decision = decidePaymentWrite({ origin: 'edit', paymentType: existing.payment_type, amount: 100, existing });
      expect(paymentFieldLock(existing) !== 'none', JSON.stringify(existing)).toBe(decision.kind === 'refused');
    }
  });
});

describe('every refusal and every lock has a sentence in both languages', () => {
  const refusals = Object.keys(PAYMENT_WRITE_REFUSAL_KEYS) as PaymentWriteRefusal[];

  it.each(refusals)('refusal %s', refusal => {
    const key = PAYMENT_WRITE_REFUSAL_KEYS[refusal];
    expect(de[key]).toBeTruthy();
    expect(en[key]).toBeTruthy();
  });

  it('every field lock', () => {
    for (const key of Object.values(PAYMENT_FIELD_LOCK_KEYS)) {
      expect(de[key], key).toBeTruthy();
      expect(en[key], key).toBeTruthy();
    }
  });

  it('names the two reasons a receipt cannot be issued for a payment', () => {
    // Not refusals of decidePaymentWrite, and no longer refusals of the payment
    // form either: since 04.10.2026 they gate the *issue* button on a cash
    // payment's view, so both sentences say the payment itself can still be
    // recorded. A copy that reads otherwise would refuse something that works.
    for (const key of ['sal.payment.cashBlockedOverlap', 'sal.payment.cashNeedsDokumente'] as const) {
      expect(de[key], key).toBeTruthy();
      expect(en[key], key).toBeTruthy();
    }
  });
});
