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
 * Which salary payment becomes a Gehaltsquittung, and which stored row may
 * still assert a different amount of cash than it did yesterday.
 *
 * The rule this pins is not "payment_type is cash". Rows in `salary_payments`
 * carry `payment_type: 'cash'` and mean different things, and only one of them
 * is money handed out of the till at the moment it is recorded:
 *
 * - a payment the user adds by hand — the till is emptied by that amount, so it
 *   needs the receipt and the `cash_movements` row that
 *   `confirm_salary_cash_payment` writes with it;
 * - the weekly "Bar zurück" (`weekly_cash_difference`) — money the driver kept
 *   out of a weekly settlement. CLAUDE.md: it counts as paid and never moves
 *   cash. A receipt for it would book a payout that never happened and lower
 *   the Bargeldbestand by an amount still in the box;
 * - a cash row stored before 17.09.2026 — money that left the till with no
 *   ledger row at all. Editing its amount would move the claim without moving
 *   the ledger, which is the same defect through a different door.
 *
 * So the decision is keyed on the origin of the write and on the stored row,
 * and the two cases below are the ones that would silently corrupt the till if
 * anyone rewrote them as a check on the type.
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

  describe('a stored cash row is frozen in the two fields that assert cash', () => {
    const legacyCash = { payment_type: 'cash', source_type: 'manual', amount: 100 } as const;

    it('allows an edit that changes neither the amount nor the type', () => {
      // Date and description carry no cash claim.
      expect(
        decidePaymentWrite({ origin: 'edit', paymentType: 'cash', amount: 100, existing: legacyCash }),
      ).toEqual({ kind: 'update' });
    });

    it('compares the amount in cents, so the form text and the stored number agree', () => {
      expect(
        decidePaymentWrite({ origin: 'edit', paymentType: 'cash', amount: '100.00', existing: legacyCash }),
      ).toEqual({ kind: 'update' });
      expect(
        decidePaymentWrite({
          origin: 'edit',
          paymentType: 'cash',
          amount: '100.50',
          existing: { ...legacyCash, amount: 100.5 },
        }),
      ).toEqual({ kind: 'update' });
    });

    it('refuses a raised amount — the defect this module exists to close, through the pencil', () => {
      // 100,00 € edited to 5.000,00 € would assert 4.900,00 € more paid in cash
      // with no cash_movements row anywhere.
      expect(
        decidePaymentWrite({ origin: 'edit', paymentType: 'cash', amount: 5000, existing: legacyCash }),
      ).toEqual({ kind: 'refused', refusal: 'cash_row_locked' });
    });

    it('refuses a lowered amount too, and a switch away from cash', () => {
      expect(
        decidePaymentWrite({ origin: 'edit', paymentType: 'cash', amount: 1, existing: legacyCash }),
      ).toEqual({ kind: 'refused', refusal: 'cash_row_locked' });
      expect(
        decidePaymentWrite({ origin: 'edit', paymentType: 'bank', amount: 100, existing: legacyCash }),
      ).toEqual({ kind: 'refused', refusal: 'cash_row_locked' });
    });

    it('refuses an amount it cannot read rather than treating it as unchanged', () => {
      for (const unreadable of ['', 'abc', null, undefined, Number.NaN]) {
        expect(
          decidePaymentWrite({ origin: 'edit', paymentType: 'cash', amount: unreadable, existing: legacyCash }),
        ).toEqual({ kind: 'refused', refusal: 'cash_row_locked' });
      }
    });

    it('refuses when the stored amount is missing, so an unknown claim is never rewritten', () => {
      expect(
        decidePaymentWrite({
          origin: 'edit',
          paymentType: 'cash',
          amount: 100,
          existing: { payment_type: 'cash', source_type: 'manual' },
        }),
      ).toEqual({ kind: 'refused', refusal: 'cash_row_locked' });
    });

    it('freezes a weekly row the same way', () => {
      // Bar zurück moved no cash either, so raising it asserts cash that was
      // never in play.
      expect(
        decidePaymentWrite({
          origin: 'edit',
          paymentType: 'cash',
          amount: 400,
          existing: { payment_type: 'cash', source_type: 'weekly_cash_difference', amount: 200 },
        }),
      ).toEqual({ kind: 'refused', refusal: 'cash_row_locked' });
    });

    it('freezes a legacy row that carries no source at all', () => {
      expect(
        decidePaymentWrite({
          origin: 'edit',
          paymentType: 'cash',
          amount: 250,
          existing: { payment_type: 'cash', amount: 100 },
        }),
      ).toEqual({ kind: 'refused', refusal: 'cash_row_locked' });
    });
  });

  describe('a stored bank row', () => {
    const bank = { payment_type: 'bank', source_type: 'manual', amount: 100 } as const;

    it('is updated freely while it stays a bank transfer — no cash is asserted', () => {
      expect(decidePaymentWrite({ origin: 'edit', paymentType: 'bank', amount: 5000, existing: bank })).toEqual({
        kind: 'update',
      });
    });

    it('refuses being switched to cash', () => {
      // The other door into an untracked cash payment: create it as a bank
      // transfer, then edit the type. confirm_salary_cash_payment writes its own
      // salary_payments row and cannot adopt one, so this is named rather than
      // written.
      expect(decidePaymentWrite({ origin: 'edit', paymentType: 'cash', amount: 100, existing: bank })).toEqual({
        kind: 'refused',
        refusal: 'cash_needs_receipt',
      });
    });
  });

  describe('a row that belongs to a Gehaltsquittung', () => {
    it('refuses every edit, whatever the type or the amount', () => {
      // The trigger in 20260914140000 refuses the UPDATE anyway; this is the
      // sentence a person can read instead of a database error.
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
  it('leaves a new payment and a stored bank row open', () => {
    expect(paymentFieldLock(null)).toBe('none');
    expect(paymentFieldLock(undefined)).toBe('none');
    expect(paymentFieldLock({ payment_type: 'bank', source_type: 'manual', amount: 100 })).toBe('none');
  });

  it('locks a stored cash row, whatever its source', () => {
    expect(paymentFieldLock({ payment_type: 'cash', source_type: 'manual', amount: 100 })).toBe('legacy_cash');
    expect(paymentFieldLock({ payment_type: 'cash', source_type: 'weekly_cash_difference', amount: 100 })).toBe(
      'legacy_cash',
    );
    expect(paymentFieldLock({ payment_type: 'cash', amount: 100 })).toBe('legacy_cash');
  });

  it('names a receipt row as a receipt, not as legacy cash', () => {
    expect(paymentFieldLock({ payment_type: 'cash', source_type: 'gehaltsquittung', amount: 300 })).toBe('receipt');
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

  it('names the two blocked-cash reasons the salary form shows before it closes', () => {
    // Not refusals of decidePaymentWrite: they refuse the *path* rather than
    // the write, and they are shown beside the type select while it is still
    // open, so the payment can be recorded as a bank transfer instead.
    for (const key of ['sal.payment.cashBlockedOverlap', 'sal.payment.cashNeedsDokumente'] as const) {
      expect(de[key], key).toBeTruthy();
      expect(en[key], key).toBeTruthy();
    }
  });
});
