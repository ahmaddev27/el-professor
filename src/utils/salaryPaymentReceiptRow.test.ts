import { describe, expect, it } from 'vitest';
import {
  currentLoadState,
  loadReceiptForPreview,
  paymentRowActions,
  paymentRowOffersView,
  paymentRowStorno,
  receiptPreviewView,
  receiptSheet,
  stornoStep,
  voidReasonProblem,
  type PaymentRowContext,
  type PaymentRowInput,
  type PaymentRowStorno,
  type PaymentRowStornoContext,
  type ReceiptLoadState,
  type ReceiptPreviewRequest,
  type ReceiptStatusOnly,
} from './salaryPaymentReceiptRow';

const RECEIPT_A = 'a3f1c0de-0000-4000-8000-000000000001';
const RECEIPT_B = 'a3f1c0de-0000-4000-8000-000000000002';

const receiptPayment: PaymentRowInput = {
  payment_type: 'cash',
  source_type: 'gehaltsquittung',
  source_reference: RECEIPT_A,
};

/** A company user looking at their own company, with the Dokumente feature. */
const inOwnCompany: PaymentRowContext = { planIncludesDokumente: true, scope: 'own_company' };

describe('paymentRowActions', () => {
  it('leaves an ordinary cash payment editable', () => {
    expect(paymentRowActions({ payment_type: 'cash', source_type: 'manual' }, inOwnCompany)).toEqual({
      kind: 'editable',
    });
  });

  it('leaves a bank payment editable', () => {
    expect(paymentRowActions({ payment_type: 'bank', source_type: 'manual' }, inOwnCompany)).toEqual({
      kind: 'editable',
    });
  });

  it('leaves a payment with no source at all editable', () => {
    expect(paymentRowActions({ payment_type: 'cash' }, inOwnCompany)).toEqual({ kind: 'editable' });
    expect(paymentRowActions({ payment_type: 'cash', source_type: null }, inOwnCompany)).toEqual({ kind: 'editable' });
  });

  it('leaves the weekly "Bar zurück" row editable', () => {
    expect(paymentRowActions({ payment_type: 'cash', source_type: 'weekly_cash_difference' }, inOwnCompany)).toEqual({
      kind: 'editable',
    });
  });

  it('offers the preview for a Gehaltsquittung payment, carrying its receipt id', () => {
    expect(paymentRowActions(receiptPayment, inOwnCompany)).toEqual({
      kind: 'receipt',
      preview: true,
      receiptId: RECEIPT_A,
    });
  });

  it('locks a Gehaltsquittung row whatever its payment type, because the trigger keys on the source', () => {
    // A bank row with this source would still be refused every edit and delete
    // by the database; offering the buttons would only produce failures.
    expect(paymentRowActions({ ...receiptPayment, payment_type: 'bank' }, inOwnCompany)).toEqual({
      kind: 'receipt',
      preview: true,
      receiptId: RECEIPT_A,
    });
  });

  it('no longer asks the plan: the owner dropped it from the conditions on 03.10.2026', () => {
    expect(paymentRowActions(receiptPayment, { ...inOwnCompany, planIncludesDokumente: false })).toEqual({
      kind: 'receipt',
      preview: true,
      receiptId: RECEIPT_A,
    });
  });

  it('locks the row without a preview when no receipt id was stored', () => {
    expect(paymentRowActions({ ...receiptPayment, source_reference: undefined }, inOwnCompany)).toEqual({
      kind: 'receipt',
      preview: false,
    });
    expect(paymentRowActions({ ...receiptPayment, source_reference: '   ' }, inOwnCompany)).toEqual({
      kind: 'receipt',
      preview: false,
    });
  });

  it('does not offer the preview outside the caller own company, where it can only be refused', () => {
    // SalaryDetailsModal reads the effective company, so platform staff who have
    // entered a customer see these rows; the receipt loads with the caller's own
    // company, so pressing the button would always end in company_mismatch.
    expect(paymentRowActions(receiptPayment, { ...inOwnCompany, scope: 'other_company' })).toEqual({
      kind: 'receipt',
      preview: false,
    });
    expect(paymentRowActions(receiptPayment, { ...inOwnCompany, scope: 'no_company' })).toEqual({
      kind: 'receipt',
      preview: false,
    });
  });

  it('keeps the row locked outside the own company, rather than falling back to edit and delete', () => {
    // The lock is the database's, not the plan's: losing the preview must never
    // hand back buttons the trigger refuses.
    const actions = paymentRowActions(receiptPayment, { planIncludesDokumente: false, scope: 'other_company' });
    expect(actions.kind).toBe('receipt');
  });
});

describe('currentLoadState — one dialog, one receipt at a time', () => {
  const loadedA: ReceiptLoadState = { status: 'loaded', receiptId: RECEIPT_A, receipt: { status: 'confirmed' } };

  it('treats the receipt shown before as still loading when another row opens the dialog', () => {
    // React commits and paints the new receiptId before the effect that starts
    // its load runs. Without this, one frame of receipt A — its number, its
    // amount, its period — prints under a dialog opened from receipt B's row.
    expect(currentLoadState(loadedA, RECEIPT_B)).toEqual({ status: 'loading', receiptId: RECEIPT_B });
    expect(receiptPreviewView(currentLoadState(loadedA, RECEIPT_B))).toEqual({ kind: 'loading' });
  });

  it('keeps the answer that belongs to the receipt now open', () => {
    expect(currentLoadState(loadedA, RECEIPT_A)).toBe(loadedA);
    expect(receiptPreviewView(currentLoadState(loadedA, RECEIPT_A))).toEqual({ kind: 'document', voided: false });
  });

  it('does not show a refusal earned by another receipt', () => {
    const failedA: ReceiptLoadState = { status: 'failed', receiptId: RECEIPT_A, refusal: 'unexpected' };
    expect(receiptPreviewView(currentLoadState(failedA, RECEIPT_B))).toEqual({ kind: 'loading' });
  });

  it('holds nothing back before the first receipt is opened', () => {
    const initial: ReceiptLoadState = { status: 'loading', receiptId: null };
    expect(receiptPreviewView(currentLoadState(initial, RECEIPT_A))).toEqual({ kind: 'loading' });
  });
});

describe('receiptPreviewView', () => {
  it('shows a confirmed receipt as a valid document', () => {
    expect(receiptPreviewView({ status: 'loaded', receiptId: RECEIPT_A, receipt: { status: 'confirmed' } })).toEqual({
      kind: 'document',
      voided: false,
    });
  });

  it('marks a voided receipt as voided rather than rendering it as valid', () => {
    expect(receiptPreviewView({ status: 'loaded', receiptId: RECEIPT_A, receipt: { status: 'voided' } })).toEqual({
      kind: 'document',
      voided: true,
    });
  });

  it('reports a query that answered with no row as receipt_not_found', () => {
    expect(receiptPreviewView({ status: 'loaded', receiptId: RECEIPT_A, receipt: null })).toEqual({
      kind: 'refusal',
      refusal: 'receipt_not_found',
    });
  });

  it('passes a refusal through', () => {
    const state: ReceiptLoadState = { status: 'failed', receiptId: RECEIPT_A, refusal: 'company_mismatch' };
    expect(receiptPreviewView(state)).toEqual({ kind: 'refusal', refusal: 'company_mismatch' });
  });
});

describe('loadReceiptForPreview', () => {
  const ownCompany: ReceiptPreviewRequest = {
    receiptId: RECEIPT_A,
    companyId: 'company-a',
    effectiveCompanyId: 'company-a',
    isViewingAsCompany: false,
  };

  /** A loader that records how it was called, so "no query went out" is an assertion. */
  function recordingLoader(answer: () => Promise<ReceiptStatusOnly | null>) {
    const calls: { companyId: string; receiptId: string }[] = [];
    return {
      calls,
      load: (companyId: string, receiptId: string) => {
        calls.push({ companyId, receiptId });
        return answer();
      },
    };
  }

  it('asks for the receipt with the caller own company', async () => {
    const loader = recordingLoader(() => Promise.resolve({ status: 'confirmed' as const }));
    const state = await loadReceiptForPreview(ownCompany, loader.load);

    expect(loader.calls).toEqual([{ companyId: 'company-a', receiptId: RECEIPT_A }]);
    expect(state).toEqual({ status: 'loaded', receiptId: RECEIPT_A, receipt: { status: 'confirmed' } });
  });

  it('refuses platform staff viewing another company before any query goes out', async () => {
    // The receipt's SELECT policy reads the caller's own company, so the query
    // would answer with no row — indistinguishable from a deleted receipt.
    const loader = recordingLoader(() => Promise.reject(new Error('must not be asked')));
    const state = await loadReceiptForPreview(
      { ...ownCompany, effectiveCompanyId: 'company-b', isViewingAsCompany: true },
      loader.load,
    );

    expect(loader.calls).toEqual([]);
    expect(state).toEqual({ status: 'failed', receiptId: RECEIPT_A, refusal: 'company_mismatch' });
    expect(receiptPreviewView(state)).toEqual({ kind: 'refusal', refusal: 'company_mismatch' });
  });

  it('refuses an account that belongs to no company before any query goes out', async () => {
    const loader = recordingLoader(() => Promise.reject(new Error('must not be asked')));
    const state = await loadReceiptForPreview(
      { ...ownCompany, companyId: null, effectiveCompanyId: null },
      loader.load,
    );

    expect(loader.calls).toEqual([]);
    expect(state).toEqual({ status: 'failed', receiptId: RECEIPT_A, refusal: 'no_company' });
  });

  it('turns a query that throws into a named refusal, not an empty sheet', async () => {
    const loader = recordingLoader(() => Promise.reject(new Error('JWT expired')));
    const state = await loadReceiptForPreview(ownCompany, loader.load);

    expect(state).toEqual({ status: 'failed', receiptId: RECEIPT_A, refusal: 'unexpected' });
    expect(receiptPreviewView(state)).toEqual({ kind: 'refusal', refusal: 'unexpected' });
  });

  it('turns a query that finds no row into receipt_not_found', async () => {
    const loader = recordingLoader(() => Promise.resolve(null));
    const state = await loadReceiptForPreview(ownCompany, loader.load);

    expect(state).toEqual({ status: 'loaded', receiptId: RECEIPT_A, receipt: null });
    expect(receiptPreviewView(state)).toEqual({ kind: 'refusal', refusal: 'receipt_not_found' });
  });

  it('answers for the receipt it was asked about, so a late answer can be told apart', async () => {
    const loader = recordingLoader(() => Promise.resolve({ status: 'confirmed' as const }));
    const state = await loadReceiptForPreview({ ...ownCompany, receiptId: RECEIPT_A }, loader.load);

    expect(receiptPreviewView(currentLoadState(state, RECEIPT_B))).toEqual({ kind: 'loading' });
  });
});

describe('receiptSheet — the stored row is what prints', () => {
  const storedReceipt = {
    receipt_number: 'GQ-2026-0012',
    status: 'confirmed' as const,
    period_start: '2026-08-03',
    period_end: '2026-08-30',
    business_month: 8,
    business_year: 2026,
    payment_date: '2026-09-14',
    place: 'Berlin',
    due_amount: '2500.00',
    paid_bank_before: '1000.00',
    paid_cash_manual_before: '20.00',
    paid_cash_weekly_before: '50.00',
    paid_cash_receipts_before: '0.00',
    remaining_before: '1430.00',
    amount: '1234.56',
    remaining_after: '195.44',
    is_partial: true,
    voided_at: null as string | null,
    void_reason: null as string | null,
  };
  const driver = { name: 'Max Mustermann', gender: 'male' as const };
  const company = { name: 'Muster Mietwagen GmbH', addressLines: ['Hauptstraße 5', '10115 Berlin'] };

  it('prints the number and the amount the database stored', () => {
    const sheet = receiptSheet(storedReceipt, driver, company);

    expect(sheet.kind).toBe('text');
    if (sheet.kind !== 'text') return;
    expect(sheet.text.number).toBe('Nr. GQ-2026-0012');
    expect(sheet.text.amount.figures).toBe('1.234,56 EUR');
    expect(sheet.text.banner).toBeNull();
    expect(sheet.text.facts).toContainEqual({ label: 'Abrechnungsmonat', value: 'August 2026', emphasis: false });
  });

  it('prints the stored Abrechnungsmonat even where the period alone would say another one', () => {
    // A period starting Thursday 01.01.2026 belongs to the business month
    // December 2025, and the receipt is numbered GQ-2025-…. The sheet must read
    // that pair off the row, not recompute it, or a later change to the
    // calendar rule would reprint an issued document under another month.
    const sheet = receiptSheet(
      {
        ...storedReceipt,
        receipt_number: 'GQ-2025-0004',
        period_start: '2026-01-01',
        period_end: '2026-01-25',
        business_month: 12,
        business_year: 2025,
      },
      driver,
      company,
    );

    expect(sheet.kind).toBe('text');
    if (sheet.kind !== 'text') return;
    expect(sheet.text.facts).toEqual([
      { label: 'Abrechnungsmonat', value: 'Dezember 2025', emphasis: false },
      { label: 'Zahlungsdatum', value: '14.09.2026', emphasis: false },
    ]);
    expect(sheet.text.number).toBe('Nr. GQ-2025-0004');
  });

  it('marks a voided receipt on the sheet itself', () => {
    const sheet = receiptSheet(
      // 00:30 on 16 September in Berlin.
      { ...storedReceipt, status: 'voided', voided_at: '2026-09-15T22:30:00+00:00', void_reason: 'Falscher Betrag' },
      driver,
      company,
    );

    expect(sheet.kind).toBe('text');
    if (sheet.kind !== 'text') return;
    expect(sheet.text.banner).toBe('STORNIERT am 16.09.2026 – Grund: Falscher Betrag');
  });

  it('reports an amount the builder cannot read instead of throwing through the salary screen', () => {
    // toCents throws RangeError by design on anything that is not a finite
    // decimal, from inside storedReceiptDocumentInput — before the builder is
    // reached. The salary screen sits under no error boundary, so an escaped
    // throw would unmount the application rather than the dialog.
    expect(receiptSheet({ ...storedReceipt, amount: 'nicht lesbar' }, driver, company)).toEqual({ kind: 'broken' });
    expect(receiptSheet({ ...storedReceipt, remaining_after: '' }, driver, company)).toEqual({ kind: 'broken' });
  });

  it('reports an unreadable void timestamp instead of throwing through the salary screen', () => {
    // berlinToday(new Date('kaputt')) is a RangeError out of Intl, again from
    // inside storedReceiptDocumentInput.
    expect(receiptSheet({ ...storedReceipt, status: 'voided', voided_at: 'kaputt' }, driver, company)).toEqual({
      kind: 'broken',
    });
  });

  it('refuses to sign a receipt to nobody', () => {
    expect(receiptSheet(storedReceipt, { name: '  ', gender: null }, company)).toEqual({
      kind: 'problem',
      problem: 'missing_driver_name',
    });
    expect(receiptSheet(storedReceipt, driver, { name: '', addressLines: [] })).toEqual({
      kind: 'problem',
      problem: 'missing_company_name',
    });
  });
});

// ─── The Storno on the payment row ──────────────────────────────────────────

/**
 * The rule under test: a Gehaltsquittung payment is undone only by voiding its
 * receipt — which removes the payment, books the amount back into the till on
 * the day of the void, and keeps the receipt on record as voided. These tests
 * pin what the row may offer; they never assert that a payment can be deleted,
 * because it cannot.
 */

/** An editor of their own company: what void_salary_cash_receipt requires. */
const mayVoid: PaymentRowStornoContext = { scope: 'own_company', mayEditSalaries: true };

/**
 * NEGATIVE CONTROL — the behaviour before this change, written out.
 *
 * The payment row offered a lock and, at most, "Quittung ansehen": the Storno
 * existed only on the Gehaltsquittung list. So the old answer for every row,
 * Gehaltsquittung or not, was "nothing here".
 */
const beforeThisChange = (): PaymentRowStorno => ({ kind: 'hidden' });

describe('paymentRowStorno', () => {
  it('offers the Storno on a Gehaltsquittung row, carrying its receipt id', () => {
    expect(paymentRowStorno(receiptPayment, mayVoid)).toEqual({ kind: 'offered', receiptId: RECEIPT_A });
  });

  it('is what changed: the row used to offer nothing at all', () => {
    // NEGATIVE CONTROL. With the old behaviour in place this assertion fails.
    expect(paymentRowStorno(receiptPayment, mayVoid)).not.toEqual(beforeThisChange());
  });

  it('does not make the row editable: the payment itself stays locked', () => {
    // NEGATIVE CONTROL for the guard. The trigger refuses every edit and delete
    // of a `gehaltsquittung` row, and adding a Storno must not hand those
    // buttons back. The row keeps `kind: 'receipt'` in every context.
    expect(paymentRowActions(receiptPayment, inOwnCompany).kind).toBe('receipt');
    expect(paymentRowActions(receiptPayment, { ...inOwnCompany, scope: 'other_company' }).kind).toBe('receipt');
    expect(paymentRowActions(receiptPayment, { ...inOwnCompany, planIncludesDokumente: false }).kind).toBe('receipt');
  });

  it('shows nothing on a row that is not a Gehaltsquittung — those have a real delete', () => {
    expect(paymentRowStorno({ payment_type: 'cash', source_type: 'manual' }, mayVoid)).toEqual({ kind: 'hidden' });
    expect(paymentRowStorno({ payment_type: 'bank', source_type: 'manual' }, mayVoid)).toEqual({ kind: 'hidden' });
    expect(paymentRowStorno({ payment_type: 'cash' }, mayVoid)).toEqual({ kind: 'hidden' });
    expect(paymentRowStorno({ payment_type: 'cash', source_type: null }, mayVoid)).toEqual({ kind: 'hidden' });
    expect(paymentRowStorno({ payment_type: 'cash', source_type: 'weekly_cash_difference' }, mayVoid)).toEqual({
      kind: 'hidden',
    });
  });

  it('offers the Storno on a bank-typed Gehaltsquittung row too, because the trigger keys on the source', () => {
    expect(paymentRowStorno({ ...receiptPayment, payment_type: 'bank' }, mayVoid)).toEqual({
      kind: 'offered',
      receiptId: RECEIPT_A,
    });
  });

  it('refuses a platform support session by name, in either context mode', () => {
    // The owner's decision of 18.09.2026: a support session issues, voids and
    // signs nothing here. `receiptScope` answers `other_company` inside a
    // context, and since 20260921110010 the RPC refuses it as well
    // (`platform_session_not_allowed`, the same sentence).
    expect(paymentRowStorno(receiptPayment, { scope: 'other_company', mayEditSalaries: true })).toEqual({
      kind: 'blocked',
      refusal: 'company_mismatch',
    });
  });

  it('refuses an account that belongs to no company', () => {
    expect(paymentRowStorno(receiptPayment, { scope: 'no_company', mayEditSalaries: true })).toEqual({
      kind: 'blocked',
      refusal: 'no_company',
    });
  });

  it('refuses a caller without edit rights on salaries, the right the RPC checks', () => {
    expect(paymentRowStorno(receiptPayment, { scope: 'own_company', mayEditSalaries: false })).toEqual({
      kind: 'blocked',
      refusal: 'not_authorized',
    });
  });

  it('names the scope before the role, so the permanent rule is the sentence shown', () => {
    expect(paymentRowStorno(receiptPayment, { scope: 'other_company', mayEditSalaries: false })).toEqual({
      kind: 'blocked',
      refusal: 'company_mismatch',
    });
  });

  it('refuses a Gehaltsquittung row that names no receipt: there is nothing to void', () => {
    expect(paymentRowStorno({ ...receiptPayment, source_reference: undefined }, mayVoid)).toEqual({
      kind: 'blocked',
      refusal: 'receipt_not_found',
    });
    expect(paymentRowStorno({ ...receiptPayment, source_reference: '   ' }, mayVoid)).toEqual({
      kind: 'blocked',
      refusal: 'receipt_not_found',
    });
    expect(paymentRowStorno({ ...receiptPayment, source_reference: null }, mayVoid)).toEqual({
      kind: 'blocked',
      refusal: 'receipt_not_found',
    });
  });

  it('trims the stored id, so a padded reference still names its receipt', () => {
    expect(paymentRowStorno({ ...receiptPayment, source_reference: ` ${RECEIPT_A} ` }, mayVoid)).toEqual({
      kind: 'offered',
      receiptId: RECEIPT_A,
    });
  });

  it('is not gated on the plan, although issuing is', () => {
    // The Storno is the only undo. Gating it on `dokumente` — which
    // `plan_features` can change under a company — would leave a cash payment
    // that can be neither edited, nor deleted, nor voided. The preview does go
    // dark in that case, and that difference is deliberate.
    const planOff: PaymentRowContext = { planIncludesDokumente: false, scope: 'own_company' };
    expect(paymentRowActions(receiptPayment, planOff).kind).toBe('receipt');
    expect(paymentRowStorno(receiptPayment, mayVoid)).toEqual({ kind: 'offered', receiptId: RECEIPT_A });
  });
});

describe('stornoStep — what the dialog offers for the receipt it loaded', () => {
  it('waits while the receipt is loading', () => {
    expect(stornoStep({ status: 'loading', receiptId: RECEIPT_A })).toEqual({ kind: 'loading' });
  });

  it('offers the Storno for a confirmed receipt', () => {
    expect(stornoStep({ status: 'loaded', receiptId: RECEIPT_A, receipt: { status: 'confirmed' } })).toEqual({
      kind: 'ready',
    });
  });

  it('offers nothing for a receipt that was already voided elsewhere', () => {
    // NEGATIVE CONTROL for the idempotent RPC. void_salary_cash_receipt returns
    // a voided receipt unchanged instead of raising, so a second Storno would
    // report success while writing nothing, booking no cash back and dropping
    // the reason that was typed. `voided` is therefore its own step, and the
    // one thing it must never be is `ready`.
    const step = stornoStep({ status: 'loaded', receiptId: RECEIPT_A, receipt: { status: 'voided' } });
    expect(step).toEqual({ kind: 'voided' });
    expect(step).not.toEqual({ kind: 'ready' });
  });

  it('passes a refusal through', () => {
    expect(stornoStep({ status: 'failed', receiptId: RECEIPT_A, refusal: 'company_mismatch' })).toEqual({
      kind: 'refusal',
      refusal: 'company_mismatch',
    });
    expect(stornoStep({ status: 'failed', receiptId: RECEIPT_A, refusal: 'unexpected' })).toEqual({
      kind: 'refusal',
      refusal: 'unexpected',
    });
  });

  it('reports a receipt the query did not find', () => {
    expect(stornoStep({ status: 'loaded', receiptId: RECEIPT_A, receipt: null })).toEqual({
      kind: 'refusal',
      refusal: 'receipt_not_found',
    });
  });

  it('never offers a Storno of the receipt opened before', () => {
    // Voiding the wrong receipt moves cash and marks the wrong document. An
    // answer held for receipt A must read as loading under a dialog opened on
    // receipt B, which is what currentLoadState is for.
    const loadedA: ReceiptLoadState = { status: 'loaded', receiptId: RECEIPT_A, receipt: { status: 'confirmed' } };
    expect(stornoStep(currentLoadState(loadedA, RECEIPT_B))).toEqual({ kind: 'loading' });
    expect(stornoStep(currentLoadState(loadedA, RECEIPT_A))).toEqual({ kind: 'ready' });
  });
});

describe('voidReasonProblem', () => {
  it('requires a reason, which the RPC refuses without', () => {
    expect(voidReasonProblem('')).toBe('invalid_reason');
    expect(voidReasonProblem('   ')).toBe('invalid_reason');
    expect(voidReasonProblem('\n\t')).toBe('invalid_reason');
  });

  it('accepts a reason, and judges it the way the RPC trims it', () => {
    expect(voidReasonProblem('Falscher Betrag')).toBeNull();
    expect(voidReasonProblem('  Falscher Betrag  ')).toBeNull();
  });
});

describe('paymentRowOffersView — every cash payment can be viewed', () => {
  const view = (p: PaymentRowInput, ctx: PaymentRowContext = inOwnCompany) =>
    paymentRowOffersView(p, paymentRowActions(p, ctx));

  it('offers it for a manual cash payment, which has no stored receipt', () => {
    expect(view({ payment_type: 'cash', source_type: 'manual' })).toBe(true);
    expect(view({ payment_type: 'cash' })).toBe(true);
  });

  it('offers it for a cash payment inside a support session, which reads and writes nothing', () => {
    expect(view({ payment_type: 'cash', source_type: 'manual' }, { scope: 'other_company' })).toBe(true);
  });

  it('does not offer it for a bank payment', () => {
    expect(view({ payment_type: 'bank', source_type: 'manual' })).toBe(false);
  });

  it('does not offer it for "Bar zurück", which the till never saw', () => {
    expect(view({ payment_type: 'cash', source_type: 'weekly_cash_difference' })).toBe(false);
  });

  it('never replaces a stored receipt that can be opened', () => {
    expect(view(receiptPayment)).toBe(false);
  });

  it('falls back to it for a Gehaltsquittung row whose receipt cannot be opened', () => {
    expect(view({ ...receiptPayment, source_reference: null })).toBe(true);
    expect(view(receiptPayment, { scope: 'other_company' })).toBe(true);
  });
});
