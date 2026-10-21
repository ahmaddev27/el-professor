import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonsLabelled, press, settle } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';

/**
 * Fixkosten: a delete the `fixed-costs` page gate hides is not a success.
 * The row is not in the DELETE's scope, PostgREST answers 200 with no rows.
 */

const world = vi.hoisted(() => ({
  mode: 'reaches' as 'reaches' | 'hidden' | 'gone',
  success: vi.fn(),
  error: vi.fn(),
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
}));

const ROW = { id: 'x1', description: 'Versicherung', amount: 100, period_month: '2026-10-01', company_id: 'company-1' };

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.op === 'delete') return { data: world.mode === 'reaches' ? [{ id: 'x1' }] : [], error: null };
    return { data: world.mode === 'gone' && call.filters.includes('eq:id') ? [] : [ROW], error: null };
  });
  return { supabase: world.fake.client };
});
vi.mock('../hooks/useCompanyScope', () => ({ useCompanyScope: () => ({ can: () => true }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' }, profile: { role: 'admin' }, companyId: 'company-1' }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ success: world.success, error: world.error, warning: vi.fn(), showToast: vi.fn() }),
}));
vi.mock('../contexts/ExportPickerContext', () => ({ useColumnPickerExport: () => vi.fn() }));
vi.mock('../contexts/LanguageContext', () => ({
  useTranslation: () => ({ t: (key: string) => key, tPlural: (k: { one: string }) => k.one }),
}));
vi.mock('./ui', async importOriginal => {
  const original = await importOriginal<typeof import('./ui')>();
  return {
    ...original,
    Tooltip: ({ children }: { children: unknown }) => children,
    ConfirmDialog: (p: { open: boolean; onConfirm: () => void }) =>
      p.open ? createElement('button', { onClick: p.onConfirm }, 'CONFIRM-DELETE') : null,
  };
});

vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, { window: eventTarget(), document: { ...eventTarget(), visibilityState: 'visible' } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: FixedCostsManagement } = await import('./FixedCostsManagement');

async function deleteTheCost(): Promise<void> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(FixedCostsManagement)); });
  await settle();
  const trash = tree.root.findAll(n => String(n.props['aria-label'] ?? '').startsWith('fleet.deleteFixedCostAria') && typeof n.props.onClick === 'function');
  await press(trash[0]);
  await press(buttonsLabelled(tree, 'CONFIRM-DELETE')[0]);
}

beforeEach(() => {
  world.mode = 'reaches';
  world.success.mockReset();
  world.error.mockReset();
});

describe('FixedCostsManagement: the DELETE is checked', () => {
  it('says deleted when the row went', async () => {
    await deleteTheCost();
    expect(world.success).toHaveBeenCalledWith('fleet.fixedCostsDeleted', 'fleet.fixedCostsDeletedBody');
    expect(world.error).not.toHaveBeenCalled();
  });
  it('reports a refusal, and no success, when zero rows come back', async () => {
    world.mode = 'hidden';
    await deleteTheCost();
    expect(world.success).not.toHaveBeenCalled();
    expect(world.error).toHaveBeenCalledWith('common.errorDelete', 'common.writeRefused');
  });
  it('says it is already gone when someone else removed it first', async () => {
    world.mode = 'gone';
    await deleteTheCost();
    expect(world.success).not.toHaveBeenCalled();
    expect(world.error).toHaveBeenCalledWith('common.errorDelete', 'common.writeAlreadyGone');
  });
});
