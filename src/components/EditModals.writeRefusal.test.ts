import { createElement, type ComponentType, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settle } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';

/**
 * The two edit forms that UPDATE a gated row: CarModal (`cars`) and
 * WerkstattCheckModal (`werkstatt_checks`).
 *
 * A role without the page right has its row hidden from the UPDATE's USING
 * clause: PostgREST answers 200 with zero rows. Both forms used to toast
 * "aktualisiert" and close, over a row that had not changed. They now read what
 * the UPDATE touched; on a refusal they say so and stay open (`onSuccess` is
 * not called, which is what closes them).
 */

const world = vi.hoisted(() => ({
  /** Whether the UPDATE reaches the row (the role holds the right). */
  updateReaches: true,
  showToast: vi.fn(),
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
  translation: {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.op === 'update') return { data: world.updateReaches ? [{ id: 'x1' }] : [], error: null };
    // Probe after a refused write, and the modals' own lookups.
    if (call.table === 'cars') return { data: [{ id: 'c1', kennzeichen: 'HH-AB-1234' }], error: null };
    return { data: [{ id: 'x1' }], error: null };
  });
  return { supabase: world.fake.client };
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: world.showToast }) }));
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));

vi.mock('./ui', async importOriginal => {
  const original = await importOriginal<typeof import('./ui')>();
  // CarModal draws a Radix Sheet, which portals; react-test-renderer cannot
  // render a portal, so the sheet's parts draw their children inline.
  const pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    ...original,
    Sheet: pass, SheetBody: pass, SheetContent: pass, SheetDescription: pass,
    SheetFooter: pass, SheetHeader: pass, SheetTitle: pass,
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: CarModal } = await import('./CarModal');
const { default: WerkstattCheckModal } = await import('./WerkstattCheckModal');

const CAR = { id: 'c1', kennzeichen: 'HH-AB-1234', tuev_gueltig_bis: '2027-05-01', letzte_hu: null, drivers: [] };
const CHECK = {
  id: 'w1', car_id: 'c1', week_number: 2, year: 2026, check_date: '2026-10-13', status: 'positive' as const,
  notes: 'ok', repair_notes: null, oil_status: 'OK', km_stand: 1000,
};

const onSuccess = vi.fn();

async function submit(component: ComponentType<never>, props: Record<string, unknown>): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(component as ComponentType<Record<string, unknown>>, { onClose: vi.fn(), onSuccess, ...props })); });
  await settle();
  const form = tree.root.findAll(n => n.type === 'form')[0];
  await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
  await settle();
  return tree;
}

const toasts = () => world.showToast.mock.calls.map(c => `${c[0]}:${c[1]}`);

beforeEach(() => {
  world.updateReaches = true;
  world.showToast.mockReset();
  onSuccess.mockReset();
  world.fake!.calls.length = 0;
});

describe('CarModal: the UPDATE is checked', () => {
  it('toasts success and closes when the car was changed', async () => {
    await submit(CarModal as ComponentType<never>, { car: CAR });
    expect(toasts()).toEqual(['success:fleet.carUpdated']);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('reports a refusal, stays open and leaves the driver assignments alone when zero rows come back', async () => {
    world.updateReaches = false;
    // The probe must find the row still there, so it is a refusal and not "gone".
    await submit(CarModal as ComponentType<never>, { car: CAR });
    expect(toasts()).toEqual(['error:common.writeRefused']);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(world.fake!.calls.filter(c => c.table === 'car_driver_assignments' && c.op !== 'select')).toHaveLength(0);
  });
});

describe('WerkstattCheckModal: the UPDATE is checked', () => {
  it('toasts success and closes when the check was changed', async () => {
    await submit(WerkstattCheckModal as ComponentType<never>, { check: CHECK });
    expect(toasts()).toEqual(['success:fleet.werkstattCheckUpdated']);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('reports a refusal and stays open when zero rows come back', async () => {
    world.updateReaches = false;
    await submit(WerkstattCheckModal as ComponentType<never>, { check: CHECK });
    expect(toasts()).toEqual(['error:common.writeRefused']);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
