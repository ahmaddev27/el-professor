import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonsLabelled, press, settle } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';

/**
 * Gehälter, the payment list: deleting a payment the `salaries` page gate hides
 * (200, zero rows) must not toast success over a payment that is still there,
 * and the delete button follows the same right. The receipt guards RAISE and
 * are not touched here: a raised error still reaches the error toast.
 */

const world = vi.hoisted(() => ({
  mode: 'reaches' as 'reaches' | 'hidden' | 'gone' | 'raises',
  mayEdit: true,
  showToast: vi.fn(),
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
}));

const PAYMENT = {
  id: 'p1', salary_id: 's1', amount: 50, payment_date: '2026-10-01', payment_method: 'cash',
  source_type: 'manual', notes: null, company_id: 'company-1',
};

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.table !== 'salary_payments') return { data: [], error: null };
    if (call.op === 'delete') {
      if (world.mode === 'raises') return { data: null, error: { message: 'RECEIPT-GUARD' } };
      return { data: world.mode === 'reaches' ? [{ id: 'p1' }] : [], error: null };
    }
    return { data: world.mode === 'gone' && call.filters.includes('eq:id') ? [] : [PAYMENT], error: null };
  });
  return { supabase: world.fake.client };
});
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, companyId: 'company-1', can: () => world.mayEdit }),
}));
vi.mock('../contexts/PlanContext', () => ({ usePlan: () => ({ can: () => true }) }));
vi.mock('../contexts/SuperAdminContext', () => ({
  useSuperAdmin: () => ({ effectiveCompanyId: 'company-1', isViewingAsCompany: false }),
}));
vi.mock('../contexts/CompanySettingsContext', () => ({ useCompanySettings: () => ({ settings: {} }) }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: world.showToast }) }));
vi.mock('../contexts/LanguageContext', () => ({
  useTranslation: () => ({ t: (key: string) => key, tPlural: (k: { one: string }) => k.one }),
}));
vi.mock('../lib/salaryCashReceipts', () => ({
  loadIssuedReceiptIds: async () => ({}),
  loadReceiptById: async () => null,
  voidReceipt: async () => null,
}));
vi.mock('./SalaryPaymentModal', () => ({ default: () => null }));
vi.mock('./SalaryPaymentReceiptPreview', () => ({ default: () => null }));
vi.mock('./SalaryPaymentCashView', () => ({ default: () => null }));
vi.mock('./DriverSalarySummaryCard', () => ({ default: () => null }));
vi.mock('./SalaryRevenueDetails', () => ({ default: () => null }));
vi.mock('./GehaltsquittungParts', () => ({ ReceiptAlert: () => null, useRefusalMessage: () => () => '' }));
vi.mock('./ConfirmationModal', () => ({
  default: (p: { isOpen: boolean; onConfirm: () => void }) =>
    p.isOpen ? createElement('button', { onClick: p.onConfirm }, 'CONFIRM-DELETE') : null,
}));
vi.mock('../utils/driverSalaryPdf', () => ({ generateDriverSalaryPdf: vi.fn() }));
vi.mock('./ui', async importOriginal => {
  const original = await importOriginal<typeof import('./ui')>();
  return {
    ...original,
    Dialog: (p: { children: unknown }) => p.children,
    DialogContent: (p: { children: unknown }) => p.children,
    DialogHeader: (p: { children: unknown }) => p.children,
    DialogFooter: (p: { children: unknown }) => p.children,
    DialogTitle: () => null,
    DialogDescription: () => null,
    DialogClose: (p: { children: unknown }) => p.children,
  };
});

const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, { window: eventTarget(), document: { ...eventTarget(), visibilityState: 'visible' } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: SalaryDetailsModal } = await import('./SalaryDetailsModal');

const SALARY = {
  salary_id: 's1', driver_id: 'd1', driver_name: 'Fahrer', period_start: '2026-10-01', period_end: '2026-10-31',
  amount_due: 100, netto_salary: 100,
};

async function mount(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(SalaryDetailsModal, {
      isOpen: true, onClose: () => {}, salary: SALARY as never, onUpdate: () => {},
    }));
  });
  await settle();
  return tree;
}

const trashButtons = (tree: ReactTestRenderer) =>
  tree.root.findAll(n => n.type === 'button' && n.props.title === 'common.delete');
const toasts = () => world.showToast.mock.calls.map(c => `${c[0]}:${c[1]}`);

async function deleteThePayment(): Promise<void> {
  const tree = await mount();
  await press(trashButtons(tree)[0]);
  await press(buttonsLabelled(tree, 'CONFIRM-DELETE')[0]);
}

beforeEach(() => {
  world.mode = 'reaches';
  world.mayEdit = true;
  world.showToast.mockReset();
});

describe('SalaryDetailsModal: deleting a payment', () => {
  it('draws the delete button only to a role holding the salaries right', async () => {
    expect(trashButtons(await mount())).toHaveLength(1);
    world.mayEdit = false;
    expect(trashButtons(await mount())).toHaveLength(0);
  });

  it('toasts success when the payment was deleted', async () => {
    await deleteThePayment();
    expect(toasts()).toEqual(['success:sal.payment.deleted']);
  });

  it('reports a refusal, and no success, when zero rows come back', async () => {
    world.mode = 'hidden';
    await deleteThePayment();
    expect(toasts()).toEqual(['error:common.writeRefused']);
  });

  it('says it is already gone when someone else removed it first', async () => {
    world.mode = 'gone';
    await deleteThePayment();
    expect(toasts()).toEqual(['warning:common.writeAlreadyGone']);
  });

  it('still shows a raised refusal (the receipt guards) as an error', async () => {
    world.mode = 'raises';
    await deleteThePayment();
    expect(toasts()).toEqual(['error:RECEIPT-GUARD']);
  });
});
