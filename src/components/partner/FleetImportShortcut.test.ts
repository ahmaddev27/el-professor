import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonsLabelled, press, settle } from '../../test-utils/tree';
import type { FakeCall } from '../../test-utils/fakeSupabase';

/**
 * "Fahrer aus Reidey aktualisieren": the Fahrer page's shortcut runs the drivers
 * leg alone, in place; the empty prompt still leads to the full import.
 */

const world = vi.hoisted(() => ({
  connected: true,
  isAdmin: true,
  invoke: vi.fn(),
  fake: null as null | ReturnType<typeof import('../../test-utils/fakeSupabase').createFakeSupabase>,
  translation: {
    t: (key: string) => key,
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

vi.mock('../../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.table === 'partner_connections') return { data: world.connected ? [{ id: 'p1' }] : [], error: null };
    if (call.table === 'rpc:partner_drivers_import') {
      return { data: { ok: true, created: 2, linked: 1, skipped: [] }, error: null };
    }
    return { data: [], error: null };
  });
  return { supabase: { ...world.fake.client, functions: { invoke: world.invoke } } };
});
vi.mock('../../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ isAdmin: world.isAdmin }) }));
vi.mock('../../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../../hooks/useCompanyScope', () => ({ useCompanyScope: () => ({ canEdit: () => true }) }));
vi.mock('../../lib/uberBackfillDeps', () => ({ supabaseBackfillDeps: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FleetImportShortcut } = await import('./FleetImportShortcut');

async function render(props: Parameters<typeof FleetImportShortcut>[0]): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(MemoryRouter, null, createElement(FleetImportShortcut, props)));
  });
  await settle();
  return tree;
}

const rpcs = () => (world.fake?.calls ?? []).filter(c => c.table.startsWith('rpc:')).map(c => c.table);

beforeEach(() => {
  world.connected = true;
  world.isAdmin = true;
  world.fake?.calls.splice(0);
  world.invoke.mockReset();
  world.invoke.mockResolvedValue({ data: { ok: true, seen: 3 }, error: null });
});

describe('FleetImportShortcut', () => {
  it('runs the drivers leg alone, in place, then asks the page to reload', async () => {
    const onImported = vi.fn();
    const tree = await render({ scope: 'drivers', onImported });
    await press(buttonsLabelled(tree, 'import.shortcut.updateDrivers')[0]);
    expect(world.invoke).toHaveBeenCalledTimes(1);
    expect(world.invoke).toHaveBeenCalledWith('partner-pull', { body: { scope: 'drivers' } });
    expect(rpcs()).toEqual(['rpc:partner_drivers_import']);
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tree.toJSON())).toContain('import.doneBody');
  });

  it('keeps the link to the full import when the company is not connected', async () => {
    world.connected = false;
    const tree = await render({ scope: 'drivers' });
    expect(buttonsLabelled(tree, 'import.shortcut.updateDrivers')).toHaveLength(0);
    expect(tree.root.findByProps({ to: '/datenimport' })).toBeTruthy();
  });

  it('keeps the link for a caller who may not import', async () => {
    world.isAdmin = false;
    const tree = await render({ scope: 'drivers' });
    expect(buttonsLabelled(tree, 'import.shortcut.updateDrivers')).toHaveLength(0);
    expect(tree.root.findByProps({ to: '/datenimport' })).toBeTruthy();
  });

  it('the empty variant still links to the full import and runs nothing', async () => {
    const tree = await render({ empty: true, scope: 'drivers' });
    expect(tree.root.findByProps({ to: '/datenimport' })).toBeTruthy();
    expect(world.invoke).not.toHaveBeenCalled();
    expect(rpcs()).toEqual([]);
  });
});
