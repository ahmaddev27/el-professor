import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { settle, textOf } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';
import type { Driver } from '../types/receipt';

/**
 * Fahrer, "Erstellt von": it printed the account's id. It prints the name, and a
 * name nobody can read becomes "unknown", never the id.
 */

const CREATOR_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const STRANGER_ID = '16fd2706-8baf-433b-82eb-8c7fada847da';

const world = vi.hoisted(() => ({
  profiles: { data: [] as unknown[] | null, error: null as null | { message: string } },
  hold: null as null | Promise<void>,
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
  translation: {
    t: (key: string) => key,
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.table !== 'user_profiles') return { data: [], error: null };
    // The fake resolves with whatever it is given, and a promise there is what holds the answer back.
    return world.hold ? (world.hold.then(() => world.profiles) as unknown as typeof world.profiles) : world.profiles;
  });
  return { supabase: world.fake.client };
});
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../contexts/PlanContext', () => ({ usePlan: () => ({ planState: { carLimit: 10 } }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: CREATOR_ID }, isAdmin: true, can: () => true }) }));
vi.mock('../hooks/useCompanyScope', () => ({ useCompanyScope: () => ({ can: () => true }) }));
vi.mock('../contexts/ExportPickerContext', () => ({ useColumnPickerExport: () => vi.fn() }));
vi.mock('./DriverModal', () => ({ default: () => null }));
vi.mock('./ui', async importOriginal => {
  const original = await importOriginal<typeof import('./ui')>();
  return { ...original, Tooltip: ({ children }: { children: unknown }) => children };
});

vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, { window: eventTarget(), document: { ...eventTarget(), visibilityState: 'visible' } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: DriversManagement } = await import('./DriversManagement');

const driver = (id: string, createdBy?: string): Driver => ({
  id, name: `Fahrer ${id}`, salaryRatio: 0.5, status: 'active', createdBy,
} as unknown as Driver);

async function shown(drivers: Driver[]): Promise<string> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(DriversManagement, {
      drivers, onAddDriver: vi.fn(), onEditDriver: vi.fn(), canEdit: () => true,
    } as never));
  });
  await settle();
  return textOf(tree);
}

describe('the Fahrer table, "Erstellt von"', () => {
  it('claims nothing until the read has answered', async () => {
    let answer!: () => void;
    const waiting = new Promise<void>(done => { answer = done; });
    world.profiles = { data: [{ user_id: CREATOR_ID, full_name: 'Demo Administrator', email: null }], error: null };
    world.hold = waiting;
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(DriversManagement, {
        drivers: [driver('a', CREATOR_ID)], onAddDriver: vi.fn(), onEditDriver: vi.fn(), canEdit: () => true,
      } as never));
    });
    expect(textOf(tree)).not.toContain('common.unknown');
    expect(textOf(tree)).toContain('…');
    answer();
    world.hold = null;
    await settle();
    expect(textOf(tree)).toContain('Demo Administrator');
  });

  it('prints the name of the account that created the driver', async () => {
    world.profiles = { data: [{ user_id: CREATOR_ID, full_name: 'Demo Administrator', email: 'demo-admin@example.com' }], error: null };
    const text = await shown([driver('a', CREATOR_ID)]);
    expect(text).toContain('Demo Administrator');
    expect(text).not.toContain(CREATOR_ID);
  });

  it('falls back to the address when the account has no name', async () => {
    world.profiles = { data: [{ user_id: CREATOR_ID, full_name: ' ', email: 'demo-admin@example.com' }], error: null };
    expect(await shown([driver('a', CREATOR_ID)])).toContain('demo-admin@example.com');
  });

  it('says unknown, never the id, for an account it cannot read', async () => {
    world.profiles = { data: [{ user_id: CREATOR_ID, full_name: 'Demo Administrator', email: null }], error: null };
    const text = await shown([driver('a', STRANGER_ID)]);
    expect(text).toContain('common.unknown');
    expect(text).not.toContain(STRANGER_ID);
  });

  it('says unknown, never the id, when the read fails', async () => {
    world.profiles = { data: null, error: { message: 'offline' } };
    const text = await shown([driver('a', CREATOR_ID)]);
    expect(text).toContain('common.unknown');
    expect(text).not.toContain(CREATOR_ID);
  });
});
