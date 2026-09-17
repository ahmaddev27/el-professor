import { describe, expect, it } from 'vitest';
import { de } from '../i18n/de';
import { en } from '../i18n/en';
import {
  PAYMENT_WRITE_REFUSAL_KEYS,
  decidePaymentWrite,
  type PaymentWriteRefusal,
} from './salaryPaymentWrite';

/**
 * Which salary payment becomes a Gehaltsquittung.
 *
 * The rule this pins is not "payment_type is cash". Two rows in
 * `salary_payments` carry `payment_type: 'cash'` and mean different things, and
 * only one of them is money handed out of the till:
 *
 * - a payment the user adds by hand — the till is emptied by that amount, so it
 *   needs the receipt and the `cash_movements` row that
 *   `confirm_salary_cash_payment` writes with it;
 * - the weekly "Bar zurück" (`weekly_cash_difference`) — money the driver kept
 *   out of a weekly settlement. CLAUDE.md: it counts as paid and never moves
 *   cash. A receipt for it would book a payout that never happened and lower
 *   the Bargeldbestand by an amount still in the box.
 *
 * So the decision is keyed on the origin of the write, and the case below is
 * the one that would silently corrupt the till if anyone rewrote it as a check
 * on the type.
 */

describe('decidePaymentWrite', () => {
  describe('the weekly Bar zurück never becomes a receipt', () => {
    it('stays a plain insert although the row it writes is cash', () => {
      expect(decidePaymentWrite({ origin: 'weekly_cash_difference' })).toEqual({ kind: 'insert' });
    });

    it('stays a plain insert even when a cash payment type is handed in with it', () => {
      // The caller writes payment_type: 'cash' for this row. If the origin were
      // ever ignored in favour of the type, this is the call that would book a
      // cash movement for money that never left the till.
      expect(decidePaymentWrite({ origin: 'weekly_cash_difference', paymentType: 'cash' })).toEqual({
        kind: 'insert',
      });
    });
  });

  describe('a payment the user adds', () => {
    it('becomes a Gehaltsquittung when it is cash', () => {
      expect(decidePaymentWrite({ origin: 'add', paymentType: 'cash' })).toEqual({ kind: 'gehaltsquittung' });
    });

    it('is inserted directly when it is a bank transfer', () => {
      expect(decidePaymentWrite({ origin: 'add', paymentType: 'bank' })).toEqual({ kind: 'insert' });
    });
  });

  describe('an existing payment', () => {
    it('is updated when its cash row is edited — nothing is backfilled', () => {
      // A manual cash payment recorded before 17.09.2026 keeps its row. It gets
      // no retroactive receipt and no cash movement; the till was already
      // reconciled around it.
      expect(
        decidePaymentWrite({
          origin: 'edit',
          paymentType: 'cash',
          existing: { payment_type: 'cash', source_type: 'manual' },
        }),
      ).toEqual({ kind: 'update' });
    });

    it('is updated when a legacy cash row has no source at all', () => {
      expect(
        decidePaymentWrite({ origin: 'edit', paymentType: 'cash', existing: { payment_type: 'cash' } }),
      ).toEqual({ kind: 'update' });
    });

    it('is updated when a weekly row is edited', () => {
      expect(
        decidePaymentWrite({
          origin: 'edit',
          paymentType: 'cash',
          existing: { payment_type: 'cash', source_type: 'weekly_cash_difference' },
        }),
      ).toEqual({ kind: 'update' });
    });

    it('is updated when a bank row stays a bank row', () => {
      expect(
        decidePaymentWrite({
          origin: 'edit',
          paymentType: 'bank',
          existing: { payment_type: 'bank', source_type: 'manual' },
        }),
      ).toEqual({ kind: 'update' });
    });

    it('refuses being switched from bank to cash', () => {
      // The other door into an untracked cash payment: create it as a bank
      // transfer, then edit the type. confirm_salary_cash_payment writes its own
      // salary_payments row and cannot adopt one, so this is named rather than
      // written.
      expect(
        decidePaymentWrite({
          origin: 'edit',
          paymentType: 'cash',
          existing: { payment_type: 'bank', source_type: 'manual' },
        }),
      ).toEqual({ kind: 'refused', refusal: 'cash_needs_receipt' });
    });

    it('refuses any edit of a row that belongs to a Gehaltsquittung', () => {
      // The trigger in 20260914140000 refuses the UPDATE anyway; this is the
      // sentence a person can read instead of a database error.
      for (const paymentType of ['cash', 'bank'] as const) {
        expect(
          decidePaymentWrite({
            origin: 'edit',
            paymentType,
            existing: { payment_type: 'cash', source_type: 'gehaltsquittung' },
          }),
        ).toEqual({ kind: 'refused', refusal: 'receipt_payment_locked' });
      }
    });
  });
});

describe('every refusal has a sentence in both languages', () => {
  const refusals = Object.keys(PAYMENT_WRITE_REFUSAL_KEYS) as PaymentWriteRefusal[];

  it.each(refusals)('%s', refusal => {
    const key = PAYMENT_WRITE_REFUSAL_KEYS[refusal];
    expect(de[key]).toBeTruthy();
    expect(en[key]).toBeTruthy();
  });
});
