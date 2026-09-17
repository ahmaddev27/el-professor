import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingAttemptKey, readPendingAttempt, type StorageLike } from '../utils/salaryCashReceiptFlow';
import { useGehaltsquittungFlow, type GehaltsquittungFlow, type GehaltsquittungFlowOptions } from './useGehaltsquittungFlow';

/**
 * A confirmation without an answer may already be booked. These render the
 * real hook to check that the request id survives what used to drop it: the
 * dialog being closed, and the tab being reloaded (a fresh hook instance
 * reading the same storage). A second id would book the payment twice.
 */

const world = vi.hoisted(() => {
  const salary = {
    id: 's1',
    driver_id: 'd1',
    period_start: '2026-08-03',
    period_end: '2026-08-30',
    amount_due: 1000,
    netto_salary: null,
    payment_status: 'unpaid',
  };
  return {
    salary,
    drivers: [{ id: 'd1', name: 'Max Mustermann', gender: 'male', status: 'active' }],
    confirmCashPayment: vi.fn(),
    loadSalaryBalanceInputs: vi.fn(async () => ({ salary, payments: [] })),
  };
});

vi.mock('../lib/salaryCashReceipts', () => ({
  loadReceiptDrivers: vi.fn(async () => world.drivers),
  loadDriverSalaries: vi.fn(async () => [world.salary]),
  loadSalaryBalanceInputs: world.loadSalaryBalanceInputs,
  confirmCashPayment: world.confirmCashPayment,
  uploadSignedCopy: vi.fn(),
}));

const RECEIPT = {
  id: 'r1',
  company_id: 'c1',
  receipt_number: 'GQ-2026-0005',
  salary_id: 's1',
  driver_id: 'd1',
  period_start: '2026-08-03',
  period_end: '2026-08-30',
  payment_date: '2026-09-16',
  place: 'Berlin',
  status: 'confirmed',
  signed_copy_path: null,
  confirmed_at: '2026-09-16T08:00:00Z',
  voided_at: null,
  void_reason: null,
  amount: '300.00',
  is_partial: true,
  due_amount: '1000.00',
  paid_bank_before: '0.00',
  paid_cash_manual_before: '0.00',
  paid_cash_weekly_before: '0.00',
  paid_cash_receipts_before: '0.00',
  remaining_before: '1000.00',
  remaining_after: '700.00',
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const probe: { flow: GehaltsquittungFlow } = { flow: null as unknown as GehaltsquittungFlow };

function HookProbe(options: GehaltsquittungFlowOptions) {
  probe.flow = useGehaltsquittungFlow(options);
  return null;
}

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: key => {
      data.delete(key);
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitFor(reached: () => boolean, what: string): Promise<void> {
  for (let tick = 0; tick < 50 && !reached(); tick += 1) await settle();
  if (!reached()) throw new Error(`the flow never reached: ${what}`);
}

async function mount(options: GehaltsquittungFlowOptions) {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(HookProbe, options));
  });
  await settle();
  return renderer;
}

/** Driver, salary and 300,00 € typed, standing on the preview. */
async function reachPreview(): Promise<void> {
  await waitFor(() => probe.flow.drivers.status === 'ready', 'the drivers');
  await act(async () => probe.flow.selectDriver('d1'));
  await waitFor(() => probe.flow.salaries.status === 'ready', 'the salaries');
  await act(async () => probe.flow.selectSalary('s1'));
  await waitFor(() => probe.flow.balance.status === 'ready', 'the balance');
  await act(async () => probe.flow.goToAmount());
  await act(async () => probe.flow.setAmountText('300,00'));
  await act(async () => probe.flow.goToPreview());
  expect(probe.flow.step).toBe('preview');
}

const options = (storage: StorageLike, enabled = true): GehaltsquittungFlowOptions => ({
  enabled,
  companyId: 'c1',
  defaultPlace: 'Berlin',
  storage,
});

describe('a confirmation without an answer keeps its request id', () => {
  beforeEach(() => {
    world.confirmCashPayment.mockReset();
    world.loadSalaryBalanceInputs.mockClear();
  });

  it('stores nothing before the request leaves', async () => {
    const storage = memoryStorage();
    world.confirmCashPayment.mockResolvedValue({ ok: true, receipt: RECEIPT });
    await mount(options(storage));
    await reachPreview();
    expect(storage.getItem(pendingAttemptKey('c1'))).toBeNull();
  });

  it('survives the dialog being closed, and the retry sends the same id', async () => {
    const storage = memoryStorage();
    world.confirmCashPayment.mockResolvedValueOnce({ ok: false, refusal: 'no_response' });
    const renderer = await mount(options(storage));
    await reachPreview();

    await act(async () => {
      await probe.flow.confirm();
    });
    const firstId: string = world.confirmCashPayment.mock.calls[0][0].requestId;
    expect(probe.flow.unresolved).toBe(true);
    expect(readPendingAttempt(storage, 'c1')?.requestId).toBe(firstId);

    // The user closes the dialog without settling it.
    await act(async () => {
      renderer.update(createElement(HookProbe, options(storage, false)));
    });
    await settle();
    expect(probe.flow.unresolved).toBe(true);
    expect(probe.flow.step).toBe('preview');

    // Opening it again resumes the same request instead of starting a new one.
    world.confirmCashPayment.mockResolvedValueOnce({ ok: true, receipt: RECEIPT });
    await act(async () => {
      renderer.update(createElement(HookProbe, options(storage)));
    });
    await settle();
    expect(probe.flow.step).toBe('preview');
    expect(probe.flow.unresolved).toBe(true);

    await act(async () => {
      await probe.flow.confirm();
    });
    expect(world.confirmCashPayment).toHaveBeenCalledTimes(2);
    expect(world.confirmCashPayment.mock.calls[1][0].requestId).toBe(firstId);
    expect(probe.flow.step).toBe('done');
    expect(probe.flow.receipt?.receipt_number).toBe('GQ-2026-0005');
    expect(readPendingAttempt(storage, 'c1')).toBeNull();
  });

  it('resumes in a fresh instance reading the same storage, as after a tab reload', async () => {
    const storage = memoryStorage();
    world.confirmCashPayment.mockResolvedValueOnce({ ok: false, refusal: 'no_response' });
    const first = await mount(options(storage));
    await reachPreview();
    await act(async () => {
      await probe.flow.confirm();
    });
    const sent = world.confirmCashPayment.mock.calls[0][0];

    // The tab goes away with everything it held in memory.
    await act(async () => {
      first.unmount();
    });

    world.confirmCashPayment.mockResolvedValueOnce({ ok: true, receipt: RECEIPT });
    await mount(options(storage));
    await waitFor(() => probe.flow.unresolved, 'the resumed attempt');
    expect(probe.flow.step).toBe('preview');
    expect(probe.flow.pending?.requestId).toBe(sent.requestId);
    expect(probe.flow.pending?.driver.name).toBe('Max Mustermann');

    await act(async () => {
      await probe.flow.confirm();
    });
    expect(world.confirmCashPayment).toHaveBeenCalledTimes(2);
    expect(world.confirmCashPayment.mock.calls[1][0]).toEqual(sent);
    expect(readPendingAttempt(storage, 'c1')).toBeNull();
  });

  it('forgets the attempt once the database answers, so the next payment takes a new id', async () => {
    const storage = memoryStorage();
    world.confirmCashPayment.mockResolvedValueOnce({ ok: false, refusal: 'overpayment' });
    const renderer = await mount(options(storage));
    await reachPreview();
    await act(async () => {
      await probe.flow.confirm();
    });
    expect(probe.flow.unresolved).toBe(false);
    expect(probe.flow.attempt?.state).toBe('refused');
    expect(probe.flow.refusal).toBe('overpayment');
    expect(readPendingAttempt(storage, 'c1')).toBeNull();

    // A refusal rolled the transaction back, so closing resets the dialog.
    await act(async () => {
      renderer.update(createElement(HookProbe, options(storage, false)));
    });
    await settle();
    expect(probe.flow.step).toBe('select');
    expect(probe.flow.attempt).toBeNull();
  });

  it('says nothing was booked when the check before the send fails', async () => {
    const storage = memoryStorage();
    await mount(options(storage));
    await reachPreview();
    world.loadSalaryBalanceInputs.mockRejectedValueOnce(new Error('offline'));

    await act(async () => {
      await probe.flow.confirm();
    });
    expect(world.confirmCashPayment).not.toHaveBeenCalled();
    expect(probe.flow.refusal).toBe('not_sent');
    expect(probe.flow.sending).toBe(false);
    expect(probe.flow.unresolved).toBe(false);
    expect(readPendingAttempt(storage, 'c1')).toBeNull();
  });
});

/*
  A cash payment added on the salary screen arrives with its driver, its salary
  and its amount already chosen. It must land on the amount step — where the
  place of payment is, a field the salary form does not have — and it must never
  push an unanswered confirmation aside, whichever screen started that one.
*/
describe('a preselected salary', () => {
  const preselected = (storage: StorageLike, enabled = true): GehaltsquittungFlowOptions => ({
    ...options(storage, enabled),
    preselect: { driverId: 'd1', salaryId: 's1', amountCents: 30000, paymentDate: '2026-09-16' },
  });

  beforeEach(() => {
    world.confirmCashPayment.mockReset();
    world.loadSalaryBalanceInputs.mockClear();
  });

  it('opens on the amount step with the payment already filled in', async () => {
    await mount(preselected(memoryStorage()));
    await waitFor(() => probe.flow.balance.status === 'ready', 'the balance');
    expect(probe.flow.step).toBe('amount');
    expect(probe.flow.locked).toBe(true);
    expect(probe.flow.driverId).toBe('d1');
    expect(probe.flow.salaryId).toBe('s1');
    expect(probe.flow.amountText).toBe('300,00');
    expect(probe.flow.paymentDate).toBe('2026-09-16');
    expect(probe.flow.figures?.thisPaymentCents).toBe(30000);
  });

  it('has no step to go back to, so the choices stay the ones handed in', async () => {
    await mount(preselected(memoryStorage()));
    await waitFor(() => probe.flow.balance.status === 'ready', 'the balance');
    await act(async () => probe.flow.goToPreview());
    expect(probe.flow.step).toBe('preview');
    await act(async () => probe.flow.goBack());
    expect(probe.flow.step).toBe('amount');
    await act(async () => probe.flow.goBack());
    expect(probe.flow.step).toBe('amount');
    expect(probe.flow.salaryId).toBe('s1');
  });

  it('confirms the payment it was handed', async () => {
    world.confirmCashPayment.mockResolvedValueOnce({ ok: true, receipt: RECEIPT });
    await mount(preselected(memoryStorage()));
    await waitFor(() => probe.flow.balance.status === 'ready', 'the balance');
    await act(async () => probe.flow.goToPreview());
    await act(async () => {
      await probe.flow.confirm();
    });
    expect(world.confirmCashPayment).toHaveBeenCalledTimes(1);
    expect(world.confirmCashPayment.mock.calls[0][0]).toMatchObject({
      salaryId: 's1',
      amountCents: 30000,
      paymentDate: '2026-09-16',
      place: 'Berlin',
    });
    expect(probe.flow.step).toBe('done');
  });

  it('settles an unanswered confirmation first instead of starting the new payment', async () => {
    const storage = memoryStorage();
    world.confirmCashPayment.mockResolvedValueOnce({ ok: false, refusal: 'no_response' });
    const first = await mount(options(storage));
    await reachPreview();
    await act(async () => {
      await probe.flow.confirm();
    });
    const sent = world.confirmCashPayment.mock.calls[0][0];
    await act(async () => {
      first.unmount();
    });

    // The salary screen now hands over a different payment. The stored attempt
    // may already be booked, so it wins: a second id would book it twice.
    await mount({
      ...options(storage),
      preselect: { driverId: 'd1', salaryId: 's1', amountCents: 12345, paymentDate: '2026-09-17' },
    });
    await waitFor(() => probe.flow.unresolved, 'the resumed attempt');
    expect(probe.flow.step).toBe('preview');
    expect(probe.flow.pending?.requestId).toBe(sent.requestId);
    expect(probe.flow.pending?.input.amountCents).toBe(sent.amountCents);

    world.confirmCashPayment.mockResolvedValueOnce({ ok: true, receipt: RECEIPT });
    await act(async () => {
      await probe.flow.confirm();
    });
    expect(world.confirmCashPayment.mock.calls[1][0]).toEqual(sent);
  });
});
