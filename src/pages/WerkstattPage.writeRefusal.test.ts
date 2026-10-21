import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonsLabelled, buttonsWithIcon, press, settle, textOf } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';

/**
 * Werkstatt: a delete the database refuses must not read as a success.
 *
 * `werkstatt_checks` is gated by the Werkstatt page right. For a role without
 * it the DELETE hits a USING clause that hides the row, and PostgREST answers
 * 200 with zero rows, so the screen used to toast "gelöscht" over a row that was
 * still there. The fake client answers exactly that.
 */

const world = vi.hoisted(() => ({
  mayEdit: true,
  /** Whether the DELETE reaches the row (the role holds the right). */
  deleteReaches: true,
  showToast: vi.fn(),
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
  translation: {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

const CHECK = {
  id: 'w1', car_id: 'c1', week_number: 2, year: 2026, check_date: '2026-10-13', status: 'positive',
  notes: 'ok', repair_notes: null, oil_status: 'OK', km_stand: 1, car: { kennzeichen: 'HH-AB-1234' },
};

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.op === 'delete') return { data: world.deleteReaches ? [{ id: 'w1' }] : [], error: null };
    return { data: [CHECK], error: null };
  });
  return { supabase: world.fake.client };
});
vi.mock('../hooks/useCompanyScope', () => ({
  useCompanyScope: () => ({ can: () => world.mayEdit }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' }, profile: null }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: world.showToast }) }));
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
vi.mock('../utils/excelExport', () => ({ exportTableToExcel: vi.fn() }));

const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, { window: eventTarget(), document: { ...eventTarget(), visibilityState: 'visible' } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: WerkstattPage } = await import('./WerkstattPage');

async function mount(): Promise<ReactTestRenderer> {
  vi.setSystemTime(new Date(2026, 9, 13));
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(WerkstattPage)); });
  await settle();
  return tree;
}

async function deleteFirstCheck(tree: ReactTestRenderer): Promise<void> {
  await press(buttonsWithIcon(tree, 'trash')[0]);
  await press(buttonsLabelled(tree, 'common.delete')[0]);
}

const toasts = () => world.showToast.mock.calls.map(c => `${c[0]}:${c[1]}`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  world.mayEdit = true;
  world.deleteReaches = true;
  world.showToast.mockReset();
  world.fake!.calls.length = 0;
});

describe('WerkstattPage: delete and edit buttons follow the page right', () => {
  it('shows both for a role that may edit', async () => {
    const tree = await mount();
    expect(buttonsWithIcon(tree, 'trash')).toHaveLength(1);
    expect(buttonsWithIcon(tree, 'credit-card')).toHaveLength(1); // the edit button
    expect(textOf(tree)).toContain('HH-AB-1234');
  });

  it('shows neither for a role that may not, while the check itself stays readable', async () => {
    world.mayEdit = false;
    const tree = await mount();
    expect(textOf(tree)).toContain('HH-AB-1234');
    expect(buttonsWithIcon(tree, 'trash')).toHaveLength(0);
    expect(buttonsWithIcon(tree, 'square-pen').length + buttonsWithIcon(tree, 'pencil').length
      + buttonsWithIcon(tree, 'credit-card').length).toBe(0);
  });
});

describe('WerkstattPage: the DELETE is checked', () => {
  it('toasts success when the row was deleted', async () => {
    const tree = await mount();
    await deleteFirstCheck(tree);
    expect(toasts()).toEqual(['success:werkstatt.deleted']);
  });

  it('reports a refusal, and no success, when zero rows come back', async () => {
    world.deleteReaches = false;
    const tree = await mount();
    await deleteFirstCheck(tree);
    expect(toasts()).toEqual(['error:common.writeRefused']);
    expect(toasts().some(t => t.startsWith('success'))).toBe(false);
  });
});
