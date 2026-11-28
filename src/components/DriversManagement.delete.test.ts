import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonsLabelled, press, settle, textOf } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';
import type { Driver } from '../types/receipt';

/**
 * Fahrer: deleting a driver for good (27.11.2026). Ask the database first,
 * confirm, delete through the checked helper, and say what refers to a driver
 * who cannot go. Only an administrator sees the bin.
 */

const world = vi.hoisted(() => ({
  isAdmin: true,
  check: { ok: true, deletable: true, blockers: [] } as unknown,
  deleteAnswer: 'done' as 'done' | 'hidden' | 'references',
  stillThere: true,
  showToast: vi.fn(),
  onChanged: vi.fn(),
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
  translation: {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.table === 'rpc:driver_delete_check') return { data: world.check, error: null };
    if (call.table === 'drivers' && call.op === 'delete') {
      if (world.deleteAnswer === 'references') {
        return { data: null, error: { code: '23503', hint: 'driver_has_references', message: 'refers' } };
      }
      return { data: world.deleteAnswer === 'done' ? [{ id: 'd1' }] : [], error: null };
    }
    if (call.table === 'drivers') return { data: world.stillThere ? [{ id: 'd1' }] : [], error: null };
    return { data: [], error: null };
  });
  return { supabase: world.fake.client };
});
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: world.showToast }) }));
vi.mock('../contexts/PlanContext', () => ({ usePlan: () => ({ planState: { carLimit: 10 } }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isAdmin: world.isAdmin, can: () => true }),
}));
vi.mock('../hooks/useCompanyScope', () => ({
  useCompanyScope: () => ({ can: () => true, canEdit: () => true, readOnly: false, kind: 'own' }),
}));
vi.mock('../contexts/ExportPickerContext', () => ({ useColumnPickerExport: () => vi.fn() }));
vi.mock('./DriverModal', () => ({ default: () => null }));
vi.mock('./ui', async importOriginal => {
  const original = await importOriginal<typeof import('./ui')>();
  const box = ({ children }: { children?: unknown }) => createElement('div', null, children as never);
  return {
    ...original,
    Tooltip: ({ children }: { children: unknown }) => children,
    // Radix portals cannot be rendered by react-test-renderer.
    ConfirmDialog: (p: { open: boolean; description: string; onConfirm: () => void; onClose: () => void }) =>
      p.open ? createElement('div', null, p.description,
        createElement('button', { onClick: () => { p.onConfirm(); p.onClose(); } }, 'CONFIRM-DELETE')) : null,
    Dialog: ({ open, children }: { open: boolean; children: unknown }) => (open ? createElement('div', null, children as never) : null),
    DialogContent: box, DialogHeader: box, DialogFooter: box, DialogTitle: box, DialogDescription: box,
  };
});

vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, { window: eventTarget(), document: { ...eventTarget(), visibilityState: 'visible' } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: DriversManagement } = await import('./DriversManagement');

const driver = (status = 'active'): Driver => ({ id: 'd1', name: 'Fahrer Eins', salaryRatio: 0.5, status } as unknown as Driver);

async function mount(d: Driver = driver()): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(DriversManagement, {
      drivers: [d], onAddDriver: vi.fn(), onEditDriver: vi.fn(), canEdit: () => true, onDriverDeleted: world.onChanged,
    } as never));
  });
  await settle();
  return tree;
}

const bins = (tree: ReactTestRenderer) =>
  tree.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('fahrer.delete.aria'));
const toasts = () => world.showToast.mock.calls.map(c => `${c[0]}:${c[1]}`);
const rpcs = () => world.fake!.calls.filter(c => c.table.startsWith('rpc:')).map(c => c.table);

beforeEach(() => {
  world.isAdmin = true;
  world.check = { ok: true, deletable: true, blockers: [] };
  world.deleteAnswer = 'done';
  world.stillThere = true;
  world.showToast.mockReset();
  world.onChanged.mockReset();
  world.fake!.calls.length = 0;
});

describe('deleting a driver', () => {
  it('asks, confirms by name, deletes and reloads', async () => {
    const tree = await mount();
    await press(bins(tree)[0]);
    expect(rpcs()).toEqual(['rpc:driver_delete_check']);
    expect(textOf(tree)).toContain('Fahrer Eins');
    await press(buttonsLabelled(tree, 'CONFIRM-DELETE')[0]);
    expect(toasts()).toEqual(['success:fahrer.delete.done({"name":"Fahrer Eins"})']);
    expect(world.onChanged).toHaveBeenCalledTimes(1);
  });

  it('reports a refusal, not a success, when the policy hides the row', async () => {
    world.deleteAnswer = 'hidden';
    const tree = await mount();
    await press(bins(tree)[0]);
    await press(buttonsLabelled(tree, 'CONFIRM-DELETE')[0]);
    expect(toasts()).toEqual(['error:common.writeRefused']);
    expect(world.onChanged).not.toHaveBeenCalled();
  });

  it('says it was already removed when the row is gone, and reloads', async () => {
    world.deleteAnswer = 'hidden';
    world.stillThere = false;
    const tree = await mount();
    await press(bins(tree)[0]);
    await press(buttonsLabelled(tree, 'CONFIRM-DELETE')[0]);
    expect(toasts()).toEqual(['error:common.writeAlreadyGone']);
    expect(world.onChanged).toHaveBeenCalledTimes(1);
  });

  it('lists what refers to a driver who cannot go, and offers Deaktivieren', async () => {
    world.check = { ok: true, deletable: false, blockers: [{ table: 'fahrtenbuch_trips', rows: 12 }, { table: 'mystery', rows: 1 }] };
    const tree = await mount();
    await press(bins(tree)[0]);
    const text = textOf(tree);
    expect(text).toContain('fahrer.delete.area.trips');
    expect(text).toContain('fahrer.delete.area.other');
    expect(buttonsLabelled(tree, 'fleet.deactivate').length).toBeGreaterThan(0);
    expect(world.fake!.calls.some(c => c.op === 'delete')).toBe(false);
  });

  it('says a deactivated driver is already deactivated', async () => {
    world.check = { ok: true, deletable: false, blockers: [{ table: 'salaries', rows: 2 }] };
    const tree = await mount(driver('inactive'));
    await press(bins(tree)[0]);
    expect(textOf(tree)).toContain('fahrer.delete.alreadyDeactivated');
  });

  it('turns a late 23503 refusal into the blockers dialog', async () => {
    world.deleteAnswer = 'references';
    const tree = await mount();
    await press(bins(tree)[0]);
    world.check = { ok: true, deletable: false, blockers: [{ table: 'receipts', rows: 3 }] };
    await press(buttonsLabelled(tree, 'CONFIRM-DELETE')[0]);
    expect(textOf(tree)).toContain('fahrer.delete.area.receipts');
    expect(toasts()).toEqual([]);
  });

  it('shows no bin to a non-administrator', async () => {
    world.isAdmin = false;
    const tree = await mount();
    expect(textOf(tree)).toContain('Fahrer Eins');
    expect(bins(tree)).toHaveLength(0);
  });
});
