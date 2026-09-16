import { describe, expect, it } from 'vitest';
import {
  paymentRowActions,
  receiptPreviewView,
  type PaymentRowInput,
  type ReceiptLoadState,
} from './salaryPaymentReceiptRow';

const receiptPayment: PaymentRowInput = {
  payment_type: 'cash',
  source_type: 'gehaltsquittung',
  source_reference: 'a3f1c0de-0000-4000-8000-000000000001',
};

describe('paymentRowActions', () => {
  it('leaves an ordinary cash payment editable', () => {
    expect(paymentRowActions({ payment_type: 'cash', source_type: 'manual' }, true)).toEqual({ kind: 'editable' });
  });

  it('leaves a bank payment editable', () => {
    expect(paymentRowActions({ payment_type: 'bank', source_type: 'manual' }, true)).toEqual({ kind: 'editable' });
  });

  it('leaves a payment with no source at all editable', () => {
    expect(paymentRowActions({ payment_type: 'cash' }, true)).toEqual({ kind: 'editable' });
    expect(paymentRowActions({ payment_type: 'cash', source_type: null }, true)).toEqual({ kind: 'editable' });
  });

  it('leaves the weekly "Bar zurück" row editable', () => {
    expect(paymentRowActions({ payment_type: 'cash', source_type: 'weekly_cash_difference' }, true)).toEqual({
      kind: 'editable',
    });
  });

  it('offers the preview for a Gehaltsquittung payment, carrying its receipt id', () => {
    expect(paymentRowActions(receiptPayment, true)).toEqual({
      kind: 'receipt',
      preview: true,
      receiptId: 'a3f1c0de-0000-4000-8000-000000000001',
    });
  });

  it('locks a Gehaltsquittung row whatever its payment type, because the trigger keys on the source', () => {
    // A bank row with this source would still be refused every edit and delete
    // by the database; offering the buttons would only produce failures.
    expect(paymentRowActions({ ...receiptPayment, payment_type: 'bank' }, true)).toEqual({
      kind: 'receipt',
      preview: true,
      receiptId: 'a3f1c0de-0000-4000-8000-000000000001',
    });
  });

  it('locks the row without a preview when the plan does not include Dokumente', () => {
    expect(paymentRowActions(receiptPayment, false)).toEqual({ kind: 'receipt', preview: false });
  });

  it('locks the row without a preview when no receipt id was stored', () => {
    expect(paymentRowActions({ ...receiptPayment, source_reference: undefined }, true)).toEqual({
      kind: 'receipt',
      preview: false,
    });
    expect(paymentRowActions({ ...receiptPayment, source_reference: '   ' }, true)).toEqual({
      kind: 'receipt',
      preview: false,
    });
  });
});

describe('receiptPreviewView', () => {
  it('waits while the receipt loads', () => {
    expect(receiptPreviewView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('shows a confirmed receipt as a valid document', () => {
    expect(receiptPreviewView({ status: 'loaded', receipt: { status: 'confirmed' } })).toEqual({
      kind: 'document',
      voided: false,
    });
  });

  it('marks a voided receipt as voided rather than rendering it as valid', () => {
    expect(receiptPreviewView({ status: 'loaded', receipt: { status: 'voided' } })).toEqual({
      kind: 'document',
      voided: true,
    });
  });

  it('reports a query that answered with no row as receipt_not_found', () => {
    expect(receiptPreviewView({ status: 'loaded', receipt: null })).toEqual({
      kind: 'refusal',
      refusal: 'receipt_not_found',
    });
  });

  it('passes a refusal through', () => {
    const state: ReceiptLoadState = { status: 'failed', refusal: 'company_mismatch' };
    expect(receiptPreviewView(state)).toEqual({ kind: 'refusal', refusal: 'company_mismatch' });
  });

  it('keeps the extra columns of a real row out of the decision', () => {
    const row = { status: 'voided' as const, receipt_number: 'GQ-2026-0012', amount: '123.45' };
    expect(receiptPreviewView({ status: 'loaded', receipt: row })).toEqual({ kind: 'document', voided: true });
  });
});
