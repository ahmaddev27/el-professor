import { describe, expect, it } from 'vitest';
import { de } from '../i18n/de';
import { en } from '../i18n/en';
import { computeReceiptFigures } from './salaryCashReceipt';
import {
  REFUSAL_MESSAGE_KEYS,
  SIGNED_COPY_MAX_BYTES,
  balanceMayHaveChanged,
  berlinToday,
  checkPaymentDate,
  checkSignedCopyFile,
  clearPendingAttempt,
  createRequestId,
  findOverlappingSalary,
  nextAttempt,
  outcomeIsUnknown,
  pendingAttemptKey,
  readAmountField,
  readPendingAttempt,
  receiptScope,
  refusalFromRpcError,
  refusalFromStorageError,
  sameSnapshot,
  savePendingAttempt,
  scopeRefusal,
  signedCopyPath,
  snapshotFromFigures,
  snapshotFromReceiptRow,
  type PaymentAttempt,
  type PaymentAttemptInput,
  type PendingReceiptAttempt,
  type StorageLike,
} from './salaryCashReceiptFlow';

function idSource() {
  let n = 0;
  return () => `req-${++n}`;
}

const payment: PaymentAttemptInput = {
  salaryId: 'salary-1',
  amountCents: 18000,
  paymentDate: '2026-09-14',
  place: 'Berlin',
};

describe('nextAttempt — one request id per payment until the database answers', () => {
  it('gives the first attempt a new id that has not been sent', () => {
    expect(nextAttempt(null, payment, idSource())).toEqual({ requestId: 'req-1', input: payment, state: 'not_sent' });
  });

  it('keeps the id for a double click on the same payment', () => {
    const newId = idSource();
    const first = nextAttempt(null, payment, newId);
    const sending: PaymentAttempt = { ...first, state: 'uncertain' };
    expect(nextAttempt(sending, { ...payment }, newId).requestId).toBe('req-1');
  });

  it('keeps the id for a retry after a lost response', () => {
    const newId = idSource();
    const lost: PaymentAttempt = { ...nextAttempt(null, payment, newId), state: 'uncertain' };
    const retry = nextAttempt(lost, payment, newId);
    expect(retry.requestId).toBe('req-1');
    expect(retry.state).toBe('uncertain');
  });

  it('keeps the id while a send is unanswered even if the fields changed, so a booked first send is refused as a conflict', () => {
    const newId = idSource();
    const lost: PaymentAttempt = { ...nextAttempt(null, payment, newId), state: 'uncertain' };
    const changed = nextAttempt(lost, { ...payment, amountCents: 10000 }, newId);
    expect(changed.requestId).toBe('req-1');
    expect(changed.input.amountCents).toBe(10000);
  });

  it('treats a place that differs only in outer spaces as the same payment, as the RPC trims it', () => {
    const newId = idSource();
    const refused: PaymentAttempt = { ...nextAttempt(null, payment, newId), state: 'refused' };
    expect(nextAttempt(refused, { ...payment, place: '  Berlin ' }, newId).requestId).toBe('req-1');
  });

  it('keeps the id after a refusal when nothing changed; nothing was stored under it', () => {
    const newId = idSource();
    const refused: PaymentAttempt = { ...nextAttempt(null, payment, newId), state: 'refused' };
    expect(nextAttempt(refused, payment, newId)).toEqual({ requestId: 'req-1', input: payment, state: 'refused' });
  });

  it('takes a new id for a changed payment after a refusal', () => {
    const newId = idSource();
    const refused: PaymentAttempt = { ...nextAttempt(null, payment, newId), state: 'refused' };
    for (const change of [
      { amountCents: 17999 },
      { paymentDate: '2026-09-13' },
      { place: 'Potsdam' },
      { salaryId: 'salary-2' },
    ]) {
      const next = nextAttempt(refused, { ...payment, ...change }, newId);
      expect(next.requestId).not.toBe('req-1');
      expect(next.state).toBe('not_sent');
    }
  });

  it('starts over after a success, which the caller records by dropping the attempt', () => {
    const newId = idSource();
    nextAttempt(null, payment, newId);
    expect(nextAttempt(null, payment, newId).requestId).toBe('req-2');
  });
});

describe('refusalFromRpcError', () => {
  it('reads the reason from HINT, whatever the SQLSTATE', () => {
    expect(refusalFromRpcError({ code: 'P0001', hint: 'overpayment', message: 'Der Betrag von 5,00 EUR …' })).toBe('overpayment');
    expect(refusalFromRpcError({ code: 'P0001', hint: 'overlapping_salary' })).toBe('overlapping_salary');
    expect(refusalFromRpcError({ code: 'P0001', hint: 'already_paid' })).toBe('already_paid');
    expect(refusalFromRpcError({ code: 'P0001', hint: 'request_id_conflict' })).toBe('request_id_conflict');
    expect(refusalFromRpcError({ code: '42501', hint: 'not_authorized' })).toBe('not_authorized');
    expect(refusalFromRpcError({ code: 'P0002', hint: 'salary_not_found' })).toBe('salary_not_found');
    expect(refusalFromRpcError({ code: 'P0002', hint: 'receipt_not_found' })).toBe('receipt_not_found');
    expect(refusalFromRpcError({ code: 'P0001', hint: 'receipt_voided' })).toBe('receipt_voided');
    expect(refusalFromRpcError({ code: '22023', hint: 'invalid_payment_date' })).toBe('invalid_payment_date');
    expect(refusalFromRpcError({ code: '42501', hint: 'receipt_payment_locked' })).toBe('receipt_payment_locked');
  });

  it('never matches the German message', () => {
    expect(refusalFromRpcError({ code: 'P0001', hint: null, message: 'overpayment' })).toBe('unexpected');
  });

  it('reads a request that got no answer as no_response', () => {
    // What postgrest-js returns when fetch itself fails.
    expect(refusalFromRpcError({ code: '', hint: '', message: 'TypeError: Failed to fetch' })).toBe('no_response');
    expect(refusalFromRpcError({ message: 'An invalid response was received from the upstream server' })).toBe('no_response');
  });

  it('reads a plain permission error as not_authorized, and anything else as unexpected', () => {
    expect(refusalFromRpcError({ code: '42501', hint: 'Grant the required privileges to the current role.' })).toBe('not_authorized');
    expect(refusalFromRpcError({ code: 'PGRST301', message: 'JWT expired' })).toBe('unexpected');
    expect(refusalFromRpcError({ code: '22008', message: 'date/time field value out of range' })).toBe('unexpected');
  });
});

describe('refusalFromStorageError', () => {
  it('maps the bucket policy and limits', () => {
    expect(refusalFromStorageError({ statusCode: '403' })).toBe('not_authorized');
    expect(refusalFromStorageError({ status: 413 })).toBe('file_too_large');
    expect(refusalFromStorageError({ statusCode: '415' })).toBe('file_type');
    expect(refusalFromStorageError({ statusCode: '500' })).toBe('upload_failed');
    expect(refusalFromStorageError({})).toBe('upload_failed');
  });
});

describe('what a refusal means for the screen', () => {
  it('only an answer without a reason leaves the outcome unknown', () => {
    expect(outcomeIsUnknown('no_response')).toBe(true);
    expect(outcomeIsUnknown('unexpected')).toBe(true);
    for (const definitive of ['overpayment', 'overlapping_salary', 'not_authorized', 'request_id_conflict', 'stale_figures'] as const) {
      expect(outcomeIsUnknown(definitive)).toBe(false);
    }
  });

  it('reloads the balance for refusals that mean it moved', () => {
    expect(balanceMayHaveChanged('overpayment')).toBe(true);
    expect(balanceMayHaveChanged('already_paid')).toBe(true);
    expect(balanceMayHaveChanged('stale_figures')).toBe(true);
    expect(balanceMayHaveChanged('overlapping_salary')).toBe(false);
    expect(balanceMayHaveChanged('no_response')).toBe(false);
  });

  it('has a message in both dictionaries for every refusal', () => {
    for (const key of Object.values(REFUSAL_MESSAGE_KEYS)) {
      expect(de[key], key).toBeTruthy();
      expect(en[key], key).toBeTruthy();
    }
  });
});

describe('findOverlappingSalary — the overlapping_salary condition', () => {
  const august = { id: 'aug', period_start: '2026-08-03', period_end: '2026-08-30' };
  const calendarAugust = { id: 'cal-aug', period_start: '2026-08-01', period_end: '2026-08-31' };
  const september = { id: 'sep', period_start: '2026-08-31', period_end: '2026-09-27' };

  it('finds a calendar month beside a business month', () => {
    expect(findOverlappingSalary(august, [august, calendarAugust, september])).toBe(calendarAugust);
  });

  it('counts a shared first or last day as an overlap, as the RPC compares with <= and >=', () => {
    expect(findOverlappingSalary(september, [august, september, calendarAugust])).toBe(calendarAugust);
  });

  it('ignores the row itself and rows that only touch', () => {
    expect(findOverlappingSalary(august, [august, september])).toBeNull();
  });
});

describe('readAmountField', () => {
  it('reads German amounts into cents', () => {
    expect(readAmountField('1.234,56')).toEqual({ cents: 123456, problem: null });
    expect(readAmountField('180')).toEqual({ cents: 18000, problem: null });
    expect(readAmountField('999.999,99')).toEqual({ cents: 99999999, problem: null });
    expect(readAmountField('0,00')).toEqual({ cents: 0, problem: null });
  });

  it('names an amount it cannot read or cannot write out in words', () => {
    for (const bad of ['', 'abc', '-5', '1,234.56', '12,345']) {
      expect(readAmountField(bad)).toEqual({ cents: null, problem: 'invalid' });
    }
    expect(readAmountField('1.000.000,00')).toEqual({ cents: null, problem: 'too_large' });
  });
});

describe('payment date', () => {
  it('is today in Berlin, not in UTC', () => {
    // 23:30 UTC on 14 September is 01:30 on the 15th in Berlin (CEST).
    expect(berlinToday(new Date('2026-09-14T23:30:00Z'))).toBe('2026-09-15');
    expect(berlinToday(new Date('2026-01-31T22:59:59Z'))).toBe('2026-01-31');
  });

  it('refuses a missing or future date and allows any earlier one', () => {
    expect(checkPaymentDate('', '2026-09-15')).toBe('missing');
    expect(checkPaymentDate('15.09.2026', '2026-09-15')).toBe('missing');
    expect(checkPaymentDate('2026-09-16', '2026-09-15')).toBe('future');
    expect(checkPaymentDate('2026-09-15', '2026-09-15')).toBeNull();
    expect(checkPaymentDate('2019-01-01', '2026-09-15')).toBeNull();
  });
});

describe('snapshots — what the receipt prints', () => {
  const figures = computeReceiptFigures(
    { netto_salary: null, amount_due: 1000 },
    [
      { payment_type: 'cash', amount: 400, source_type: 'gehaltsquittung' },
      { payment_type: 'cash', amount: 250, source_type: 'gehaltsquittung' },
      { payment_type: 'bank', amount: 100, source_type: 'manual' },
      { payment_type: 'cash', amount: 50, source_type: 'weekly_cash_difference' },
      { payment_type: 'cash', amount: 20, source_type: 'manual' },
    ],
    18000,
  );
  if (!figures.ok) throw new Error('scenario R3 must be payable');

  it('maps the preview figures field by field', () => {
    expect(snapshotFromFigures(figures.figures)).toEqual({
      dueCents: 100000,
      paidBankCents: 10000,
      paidCashManualCents: 2000,
      paidCashWeeklyCents: 5000,
      paidCashReceiptsCents: 65000,
      remainingBeforeCents: 18000,
      amountCents: 18000,
      remainingAfterCents: 0,
      isPartial: false,
    });
  });

  it('reads the stored row exactly, numbers and numeric strings alike, and matches the preview', () => {
    const row = {
      due_amount: '1000.00',
      paid_bank_before: 100,
      paid_cash_manual_before: '20.00',
      paid_cash_weekly_before: 50,
      paid_cash_receipts_before: '650.00',
      remaining_before: 180,
      amount: '180.00',
      remaining_after: 0,
      is_partial: false,
    };
    expect(sameSnapshot(snapshotFromReceiptRow(row), snapshotFromFigures(figures.figures))).toBe(true);
    expect(sameSnapshot(snapshotFromReceiptRow({ ...row, paid_bank_before: '100.01' }), snapshotFromFigures(figures.figures))).toBe(false);
  });
});

describe('signed copies', () => {
  // The contract attach_salary_cash_receipt_signed_copy checks, copied from the migration.
  const RPC_PATH = /^[^/]+(\/[A-Za-z0-9._-]+)+$/;
  const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$)/;
  const company = '7b0f9c3e-2a41-4d7e-9a55-0c1f6d2e8b11';
  const receipt = { receipt_number: 'GQ-2026-0007', payment_date: '2026-09-14' };

  it('builds a path the RPC accepts, inside the company folder', () => {
    const path = signedCopyPath(company, receipt, 'application/pdf', new Date('2026-09-15T08:05:09.123Z'));
    expect(path).toBe(`${company}/2026/GQ-2026-0007_20260915T080509Z.pdf`);
    expect(path).toMatch(RPC_PATH);
    expect(path).not.toMatch(DOT_SEGMENT);
    expect(path.split('/')[0]).toBe(company);
  });

  it('gives every upload its own name, so a replacement never overwrites the earlier file', () => {
    const first = signedCopyPath(company, receipt, 'image/jpeg', new Date('2026-09-15T08:05:09Z'));
    const second = signedCopyPath(company, receipt, 'image/jpeg', new Date('2026-09-15T08:05:10Z'));
    expect(first).not.toBe(second);
    expect(second.endsWith('.jpg')).toBe(true);
  });

  it('refuses a type the bucket does not accept', () => {
    expect(() => signedCopyPath(company, receipt, 'image/gif', new Date())).toThrow(RangeError);
    expect(() => signedCopyPath(company, receipt, 'constructor', new Date())).toThrow(RangeError);
  });

  it('checks type, emptiness and the 10 MB limit before uploading', () => {
    expect(checkSignedCopyFile({ type: 'application/pdf', size: 1 })).toBeNull();
    expect(checkSignedCopyFile({ type: 'image/png', size: SIGNED_COPY_MAX_BYTES })).toBeNull();
    expect(checkSignedCopyFile({ type: 'image/png', size: SIGNED_COPY_MAX_BYTES + 1 })).toBe('file_too_large');
    expect(checkSignedCopyFile({ type: 'image/heic', size: 1 })).toBe('file_type');
    expect(checkSignedCopyFile({ type: 'toString', size: 1 })).toBe('file_type');
    expect(checkSignedCopyFile({ type: 'application/pdf', size: 0 })).toBe('file_empty');
  });
});

describe('createRequestId', () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('uses crypto.randomUUID where the browser has it', () => {
    expect(createRequestId({ randomUUID: () => 'from-random-uuid', getRandomValues: array => array })).toBe('from-random-uuid');
  });

  it('builds a v4 UUID from getRandomValues where randomUUID is missing (older Safari, plain http)', () => {
    const allOnes = {
      getRandomValues: (array: Uint8Array) => {
        array.fill(0xff);
        return array;
      },
    };
    expect(createRequestId(allOnes)).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(createRequestId(allOnes)).toMatch(UUID_V4);
  });

  it('gives a fresh v4 id for every call from real random bytes', () => {
    const noRandomUuid = { getRandomValues: (array: Uint8Array) => globalThis.crypto.getRandomValues(array) };
    const ids = new Set(Array.from({ length: 50 }, () => createRequestId(noRandomUuid)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});

describe('receiptScope — whose receipts the screens may act on', () => {
  it('is the own company unless platform staff view another', () => {
    expect(receiptScope({ companyId: 'c1', effectiveCompanyId: 'c1', isViewingAsCompany: false })).toBe('own_company');
    expect(receiptScope({ companyId: 'c1', effectiveCompanyId: 'c1', isViewingAsCompany: true })).toBe('own_company');
    expect(receiptScope({ companyId: 'c1', effectiveCompanyId: 'c2', isViewingAsCompany: true })).toBe('other_company');
    expect(receiptScope({ companyId: null, effectiveCompanyId: 'c2', isViewingAsCompany: true })).toBe('other_company');
  });

  it('tells an account without a company apart from one viewing another company', () => {
    expect(receiptScope({ companyId: null, effectiveCompanyId: null, isViewingAsCompany: false })).toBe('no_company');
    expect(scopeRefusal('no_company')).toBe('no_company');
    expect(scopeRefusal('other_company')).toBe('company_mismatch');
    expect(scopeRefusal('own_company')).toBeNull();
  });
});

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: key => {
      data.delete(key);
    },
  };
}

const pendingRecord: PendingReceiptAttempt = {
  companyId: 'c1',
  requestId: 'req-1',
  input: payment,
  driver: { id: 'd1', name: 'Max Mustermann', gender: 'male' },
  period: { start: '2026-08-03', end: '2026-08-30' },
  shown: {
    dueCents: 100000,
    paidBankCents: 10000,
    paidCashManualCents: 2000,
    paidCashWeeklyCents: 5000,
    paidCashReceiptsCents: 65000,
    remainingBeforeCents: 18000,
    amountCents: 18000,
    remainingAfterCents: 0,
    isPartial: false,
  },
};

describe('pending attempts in sessionStorage', () => {
  it('keeps the attempt of one company until it is cleared', () => {
    const storage = memoryStorage();
    expect(savePendingAttempt(storage, pendingRecord)).toBe(true);
    expect(readPendingAttempt(storage, 'c1')).toEqual(pendingRecord);
    expect(readPendingAttempt(storage, 'c2')).toBeNull();
    expect([...storage.data.keys()]).toEqual([pendingAttemptKey('c1')]);
    clearPendingAttempt(storage, 'c1');
    expect(readPendingAttempt(storage, 'c1')).toBeNull();
  });

  it('ignores a record it cannot trust', () => {
    const storage = memoryStorage();
    const key = pendingAttemptKey('c1');
    for (const bad of [
      '{not json',
      JSON.stringify({ ...pendingRecord, requestId: '' }),
      JSON.stringify({ ...pendingRecord, companyId: 'c2' }),
      JSON.stringify({ ...pendingRecord, input: { ...payment, amountCents: '180.00' } }),
      JSON.stringify({ ...pendingRecord, shown: { ...pendingRecord.shown, dueCents: 1000.5 } }),
      JSON.stringify({ ...pendingRecord, driver: { id: 'd1', name: 'Max', gender: 'x' } }),
      JSON.stringify([pendingRecord]),
    ]) {
      storage.data.set(key, bad);
      expect(readPendingAttempt(storage, 'c1')).toBeNull();
    }
  });

  it('never throws when storage is missing or blocked', () => {
    const blocked: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(savePendingAttempt(blocked, pendingRecord)).toBe(false);
    expect(readPendingAttempt(blocked, 'c1')).toBeNull();
    expect(() => clearPendingAttempt(blocked, 'c1')).not.toThrow();
    expect(savePendingAttempt(null, pendingRecord)).toBe(false);
    expect(readPendingAttempt(null, 'c1')).toBeNull();
  });
});
