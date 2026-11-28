import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonsLabelled, press, settle, textOf } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';
import type { Driver } from '../types/receipt';
import type { DriverLinkState } from '../lib/partnerDriverLinks';

/**
 * Fahrer: taking a Reidey link apart (owner, 28.11.2026). The button sits beside
 * the badge and follows the drivers page's edit right, the right that confirms
 * and rejects a link. The dialog says what stays and what never happens again
 * before anything is sent, and the call is the RPC and nothing else.
 */

const world = vi.hoisted(() => ({
  mayEditDrivers: true,
  answer: { data: { ok: true, driver_id: 'd1' }, error: null } as { data: unknown; error: unknown },
  editAsked: [] as unknown[],
  showToast: vi.fn(),
  onUnlinked: vi.fn(),
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
  translation: {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.table === 'rpc:partner_driver_link_unlink') return world.answer as never;
    return { data: [], error: null };
  });
  return { supabase: world.fake.client };
});
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: world.showToast }) }));
vi.mock('../contexts/PlanContext', () => ({ usePlan: () => ({ planState: { carLimit: 10 } }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isAdmin: false, can: () => true }),
}));
vi.mock('../hooks/useCompanyScope', () => ({
  useCompanyScope: () => ({
    can: () => true,
    canEdit: (...args: unknown[]) => { world.editAsked.push(args[1]); return world.mayEditDrivers; },
    readOnly: false,
    kind: 'own',
  }),
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

const driver = { id: 'd1', name: 'Fahrer Eins', salaryRatio: 0.5, status: 'active' } as unknown as Driver;
const NAME = '{"name":"Fahrer Eins"}';

async function mount(state: DriverLinkState | null = 'linked', linkId: string | null = 'link-1'): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(DriversManagement, {
      drivers: [driver],
      onAddDriver: vi.fn(),
      onEditDriver: vi.fn(),
      canEdit: () => true,
      partnerLinks: new Map(state ? [['d1', state]] : [['someone-else', 'linked']]),
      partnerLinkIds: new Map(linkId ? [['d1', linkId]] : []),
      onPartnerUnlinked: world.onUnlinked,
    } as never));
  });
  await settle();
  return tree;
}

const unlinkButtons = (tree: ReactTestRenderer) =>
  tree.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('partner.links.unlink.aria'));
const confirmButton = (tree: ReactTestRenderer) => buttonsLabelled(tree, 'partner.links.unlink.confirm')[0];
const toasts = () => world.showToast.mock.calls.map(c => `${c[0]}:${c[1]}`);
/** Every RPC and every write; the creator-name read on mount is neither. */
const calls = () => world.fake!.calls
  .filter(c => c.table.startsWith('rpc:') || c.op !== 'select')
  .map(c => `${c.table}:${c.op}`);

beforeEach(() => {
  world.mayEditDrivers = true;
  world.answer = { data: { ok: true, driver_id: 'd1' }, error: null };
  world.editAsked.length = 0;
  world.showToast.mockReset();
  world.onUnlinked.mockReset();
  world.fake!.calls.length = 0;
});

describe('unlinking a Reidey driver', () => {
  it('says what stays and what never happens again before anything is sent', async () => {
    const tree = await mount();
    await press(unlinkButtons(tree)[0]);
    const text = textOf(tree);
    expect(text).toContain(`partner.links.unlink.title(${NAME})`);
    expect(text).toContain(`partner.links.unlink.recordsStay(${NAME})`);
    expect(text).toContain('partner.links.unlink.noAutoRelink');
    expect(text).toContain('partner.links.unlink.relinkByHand');
    expect(calls()).toEqual([]);
  });

  it('calls the RPC with the link and nothing else, then reloads the links', async () => {
    const tree = await mount();
    await press(unlinkButtons(tree)[0]);
    await press(confirmButton(tree));
    expect(calls()).toEqual(['rpc:partner_driver_link_unlink:select']);
    expect(world.fake!.calls.find(c => c.table.startsWith('rpc:'))!.payload).toEqual({ p_link_id: 'link-1' });
    expect(toasts()).toEqual([`success:partner.links.unlink.done(${NAME})`]);
    expect(world.onUnlinked).toHaveBeenCalledTimes(1);
    expect(textOf(tree)).not.toContain('partner.links.unlink.title');
  });

  it('offers the button beside a departed driver too: the link still binds them', async () => {
    const tree = await mount('departed');
    expect(textOf(tree)).toContain('partner.links.departedBadge');
    expect(unlinkButtons(tree)).toHaveLength(1);
  });

  it('says a link that was already taken apart was, and reloads', async () => {
    world.answer = { data: null, error: { code: 'P0001', hint: 'not_linked', message: 'not linked' } };
    const tree = await mount();
    await press(unlinkButtons(tree)[0]);
    await press(confirmButton(tree));
    expect(toasts()).toEqual(['error:partner.links.unlink.notLinked']);
    expect(world.onUnlinked).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open after a failure, so the second press is a retry', async () => {
    world.answer = { data: null, error: { code: '57014', message: 'timeout' } };
    const tree = await mount();
    await press(unlinkButtons(tree)[0]);
    await press(confirmButton(tree));
    expect(toasts()).toEqual(['error:partner.links.unlink.failed']);
    expect(world.onUnlinked).not.toHaveBeenCalled();
    expect(textOf(tree)).toContain('partner.links.unlink.title');
  });

  it('reads an answer that is not ok as a failure, never as done', async () => {
    world.answer = { data: { ok: false }, error: null };
    const tree = await mount();
    await press(unlinkButtons(tree)[0]);
    await press(confirmButton(tree));
    expect(toasts()).toEqual(['error:partner.links.unlink.failed']);
    expect(world.onUnlinked).not.toHaveBeenCalled();
  });

  it('asks the drivers page, and shows no button without its edit right', async () => {
    world.mayEditDrivers = false;
    const tree = await mount();
    expect(textOf(tree)).toContain('partner.links.status.linked');
    expect(unlinkButtons(tree)).toHaveLength(0);
    expect(world.editAsked).toContain('drivers');
  });

  it('shows no button beside a driver with no link, or without the link row', async () => {
    expect(unlinkButtons(await mount(null))).toHaveLength(0);
    expect(unlinkButtons(await mount('linked', null))).toHaveLength(0);
  });
});
