import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settle } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';

/**
 * Empfänger: removing an address the database hides must not read as removed.
 * `notification_recipients` writes ask the company administrator; for anyone
 * else the DELETE touches zero rows and PostgREST answers 200.
 */

const world = vi.hoisted(() => ({
  mode: 'reaches' as 'reaches' | 'hidden' | 'gone',
  success: vi.fn(),
  error: vi.fn(),
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
}));

const ROW = { id: 'r1', notification_type: 'tuev_bald_ablaufend', email: 'a@example.com' };

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.table === 'notification_recipients') {
      if (call.op === 'delete') return { data: world.mode === 'reaches' ? [{ id: 'r1' }] : [], error: null };
      // The probe after a zero-row delete: the row is still there unless it is gone.
      return { data: world.mode === 'gone' && call.filters.includes('eq:id') ? [] : [ROW], error: null };
    }
    return { data: null, error: null };
  });
  return { supabase: world.fake.client };
});
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ success: world.success, error: world.error }) }));
vi.mock('../contexts/LanguageContext', () => ({
  useTranslation: () => ({ t: (key: string) => key, tPlural: (k: { one: string }) => k.one }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { default: Card } = await import('./NotificationRecipientsCard');

async function removeTheAddress(): Promise<void> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(Card, { readOnly: false })); });
  await settle();
  const button = tree.root.find(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('settings.notifyRecipients.remove'));
  await act(async () => { button.props.onClick({}); });
  await settle();
}

beforeEach(() => {
  world.mode = 'reaches';
  world.success.mockReset();
  world.error.mockReset();
});

describe('NotificationRecipientsCard: the DELETE is checked', () => {
  it('says removed when the row went', async () => {
    await removeTheAddress();
    expect(world.success).toHaveBeenCalledTimes(1);
    expect(world.error).not.toHaveBeenCalled();
  });

  it('reports a refusal, and no success, when zero rows come back', async () => {
    world.mode = 'hidden';
    await removeTheAddress();
    expect(world.success).not.toHaveBeenCalled();
    expect(world.error).toHaveBeenCalledWith('settings.notifyRecipients.removeFailed', 'common.writeRefused');
  });

  it('says it is already gone when someone else removed it first', async () => {
    world.mode = 'gone';
    await removeTheAddress();
    expect(world.success).not.toHaveBeenCalled();
    expect(world.error).toHaveBeenCalledWith('settings.notifyRecipients.removeFailed', 'common.writeAlreadyGone');
  });
});
