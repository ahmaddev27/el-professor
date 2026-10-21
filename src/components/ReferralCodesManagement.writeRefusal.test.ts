import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { press, settle } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';

/** Empfehlungscodes: a delete `platform_can('codes.manage')` hides is not a success. */

const world = vi.hoisted(() => ({
  mode: 'reaches' as 'reaches' | 'hidden' | 'gone',
  showToast: vi.fn(),
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
}));

const REF = { id: 'f1', ref_code: 'ABC', name: 'Partner', description: null, is_active: true, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.op === 'delete') return { data: world.mode === 'reaches' ? [{ id: 'f1' }] : [], error: null };
    return { data: world.mode === 'gone' && call.filters.some(f => f.startsWith('eq:id')) ? [] : [REF], error: null };
  });
  return { supabase: world.fake.client };
});
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: world.showToast }) }));
vi.mock('../contexts/LanguageContext', () => ({
  useTranslation: () => ({ t: (key: string) => key, tPlural: (k: { one: string }) => k.one }),
}));
vi.mock('./ui', () => ({ Alert: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('window', { confirm: () => true, addEventListener: () => {}, removeEventListener: () => {} });
const { default: Referrals } = await import('./ReferralCodesManagement');

async function deleteIt(): Promise<void> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(Referrals, { companies: [], companiesKnown: true })); });
  await settle();
  const trash = tree.root.findAll(n => n.type === 'button'
    && n.findAll(c => String(c.props.className ?? '').includes('lucide-trash')).length > 0);
  await press(trash[0]);
}

const toasts = () => world.showToast.mock.calls.map(c => `${c[0]}:${c[1]}`);

beforeEach(() => { world.mode = 'reaches'; world.showToast.mockReset(); });

describe('ReferralCodesManagement: the DELETE is checked', () => {
  it('toasts success when the code was deleted', async () => {
    await deleteIt();
    expect(toasts()).toEqual(['success:codes.referral.deleted']);
  });
  it('reports a refusal, and no success, when zero rows come back', async () => {
    world.mode = 'hidden';
    await deleteIt();
    expect(toasts()).toEqual(['error:common.writeRefused']);
  });
});
