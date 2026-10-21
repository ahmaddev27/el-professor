import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonsLabelled, press, settle, textOf } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';

/**
 * Fahrzeuge: a delete the database refuses must not read as a success.
 *
 * `cars` is gated by the Fahrzeuge page right (20260917130000). A role without
 * it has the row hidden from the DELETE's USING clause: PostgREST answers 200
 * with zero rows, and the screen toasted "Fahrzeug gelöscht" over a car that
 * was still there.
 */

const world = vi.hoisted(() => ({
  mayEdit: true,
  deleteReaches: true,
  showToast: vi.fn(),
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
  translation: {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

const CAR = { id: 'c1', kennzeichen: 'HH-AB-1234', tuev_gueltig_bis: '2027-05-01', letzte_hu: null, status: 'active' };

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.op === 'delete') return { data: world.deleteReaches ? [{ id: 'c1' }] : [], error: null };
    return { data: call.table === 'cars' ? [CAR] : [], error: null };
  });
  return { supabase: world.fake.client };
});
vi.mock('../hooks/useCompanyScope', () => ({ useCompanyScope: () => ({ can: () => world.mayEdit }) }));
vi.mock('../contexts/PlanContext', () => ({ usePlan: () => ({ planState: { carLimit: 10 } }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: world.showToast }) }));
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
vi.mock('./CarModal', () => ({ default: () => null }));
vi.mock('./ui', async importOriginal => {
  const original = await importOriginal<typeof import('./ui')>();
  return {
    ...original,
    Tooltip: ({ children }: { children: unknown }) => children,
    // Radix portals cannot be rendered by react-test-renderer; the contract the
    // screen relies on is only "confirm calls onConfirm".
    ConfirmDialog: (p: { open: boolean; onConfirm: () => void }) =>
      p.open ? createElement('button', { onClick: p.onConfirm }, 'CONFIRM-DELETE') : null,
  };
});

// Radix Tabs focuses through requestAnimationFrame, which the node environment lacks.
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, { window: eventTarget(), document: { ...eventTarget(), visibilityState: 'visible' } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: CarsManagement } = await import('./CarsManagement');

async function mount(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(CarsManagement)); });
  await settle();
  return tree;
}

const deleteButtons = (tree: ReactTestRenderer) =>
  tree.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('fleet.deleteCarAria'));
const editButtons = (tree: ReactTestRenderer) =>
  tree.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('fleet.editCarAria'));
const toasts = () => world.showToast.mock.calls.map(c => `${c[0]}:${c[1]}`);

async function deleteTheCar(tree: ReactTestRenderer): Promise<void> {
  await press(deleteButtons(tree)[0]);
  await press(buttonsLabelled(tree, 'CONFIRM-DELETE')[0]);
}

beforeEach(() => {
  world.mayEdit = true;
  world.deleteReaches = true;
  world.showToast.mockReset();
  world.fake!.calls.length = 0;
});

describe('CarsManagement: row actions follow the page right', () => {
  it('offers edit and delete to a role that may edit', async () => {
    const tree = await mount();
    expect(textOf(tree)).toContain('HH-AB-1234');
    expect(editButtons(tree)).toHaveLength(1);
    expect(deleteButtons(tree)).toHaveLength(1);
  });

  it('offers neither to a role that may not, and still lists the car', async () => {
    world.mayEdit = false;
    const tree = await mount();
    expect(textOf(tree)).toContain('HH-AB-1234');
    expect(editButtons(tree)).toHaveLength(0);
    expect(deleteButtons(tree)).toHaveLength(0);
  });
});

describe('CarsManagement: the DELETE is checked', () => {
  it('toasts success when the car was deleted', async () => {
    const tree = await mount();
    await deleteTheCar(tree);
    expect(toasts()).toEqual(['success:fleet.carDeleted']);
  });

  it('reports a refusal, and no success, when zero rows come back', async () => {
    world.deleteReaches = false;
    const tree = await mount();
    await deleteTheCar(tree);
    expect(toasts()).toEqual(['error:common.writeRefused']);
  });
});
