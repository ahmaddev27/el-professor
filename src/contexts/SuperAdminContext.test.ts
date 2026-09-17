import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuperAdminProvider, useSuperAdmin, type CompanyListItem } from './SuperAdminContext';

/**
 * The company gate's rules are pure functions in `platformAccess.ts`, tested
 * there. What only the provider can get wrong is *when* it applies them: that a
 * company closes at the context's end even if no answer ever comes back, that
 * asking again never flashes the panel into its loading state, and that entering
 * a company asks again. Each of those is about when an effect runs and which
 * clock it reads, so the provider is rendered for real, the way
 * `AppConfigContext.test.ts` renders its own.
 */

const world = vi.hoisted(() => ({
  rpc: vi.fn(),
  auth: {
    user: { id: 'staff-1' } as { id: string } | null,
    isSuperAdmin: true,
    companyId: null as string | null,
  },
  listeners: new Map<string, Set<() => void>>(),
}));

vi.mock('../lib/supabase', () => ({ supabase: { rpc: world.rpc } }));
vi.mock('./AuthContext', () => ({ useAuth: () => world.auth }));

/**
 * vitest runs in the node environment, so there is no DOM. These stand-ins keep
 * the listeners, so a test can bring the tab back the way a browser does.
 */
const eventTarget = () => ({
  addEventListener: (type: string, listener: () => void) => {
    if (!world.listeners.has(type)) world.listeners.set(type, new Set());
    world.listeners.get(type)!.add(listener);
  },
  removeEventListener: (type: string, listener: () => void) => {
    world.listeners.get(type)?.delete(listener);
  },
});
const fakeDocument = { ...eventTarget(), visibilityState: 'visible' };
Object.assign(globalThis, { window: eventTarget(), document: fakeDocument });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Gate = ReturnType<typeof useSuperAdmin>;
const probe: { value: Gate } = { value: null as unknown as Gate };

function Probe() {
  probe.value = useSuperAdmin();
  return null;
}

const tree = () => createElement(SuperAdminProvider, null, createElement(Probe));

const T0 = Date.parse('2026-09-17T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const company = (id: string) => ({ id, name: id }) as CompanyListItem;

/** A support account's whoami answer, with a context on `companyId` for `seconds`, or none. */
const whoami = (companyId: string | null, seconds = 3600) => ({
  data: {
    role: 'support',
    capabilities: ['business.read'],
    company_context: companyId === null ? null : {
      company_id: companyId, company_name: companyId, mode: 'view',
      expires_at: new Date(Date.now() + seconds * 1000).toISOString(), seconds_remaining: seconds,
    },
  },
  error: null,
});

/** Answers each RPC by name; `pending` makes every later call hang. */
function answering(answers: Record<string, () => unknown>) {
  world.rpc.mockImplementation((fn: string) => {
    const answer = answers[fn];
    return answer ? Promise.resolve(answer()) : Promise.reject(new Error(`unexpected rpc ${fn}`));
  });
}
const pending = () => world.rpc.mockImplementation(() => new Promise(() => {}));

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

const rendered: ReturnType<typeof create>[] = [];

async function mount() {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree());
  });
  rendered.push(renderer);
  await settle();
  return renderer;
}

function wake() {
  fakeDocument.visibilityState = 'visible';
  for (const listener of world.listeners.get('visibilitychange') ?? []) listener();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  world.rpc.mockReset();
  world.listeners.clear();
  world.auth = { user: { id: 'staff-1' }, isSuperAdmin: true, companyId: null };
});

afterEach(async () => {
  await act(async () => {
    rendered.splice(0).forEach(renderer => renderer.unmount());
  });
  vi.useRealTimers();
});

describe('the gate has a clock', () => {
  it('closes the company when the context runs out, even if no answer ever arrives', async () => {
    answering({ platform_whoami: () => whoami('c1') });
    await mount();

    let opened = false;
    await act(async () => { opened = probe.value.enterCompany(company('c1')); });
    expect(opened).toBe(true);
    expect(probe.value.effectiveCompanyId).toBe('c1');
    expect(probe.value.platformReadsCompanyData).toBe(true);

    // From here on the database never answers again: whatever closes the
    // company has to be the clock.
    pending();
    await act(async () => { vi.advanceTimersByTime(HOUR - 1000); });
    expect(probe.value.effectiveCompanyId).toBe('c1');

    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(probe.value.activeCompany).toBeNull();
    expect(probe.value.effectiveCompanyId).toBeNull();
    expect(probe.value.platformReadsCompanyData).toBe(false);
  });

  it('closes the company when the tab comes back to a context closed elsewhere', async () => {
    let contextOpen = true;
    answering({ platform_whoami: () => whoami(contextOpen ? 'c1' : null) });
    await mount();
    await act(async () => { probe.value.enterCompany(company('c1')); });
    await settle();
    expect(probe.value.effectiveCompanyId).toBe('c1');

    contextOpen = false;
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000); });
    await act(async () => { wake(); });
    await settle();
    expect(probe.value.activeCompany).toBeNull();
  });

  it('sees a context opened elsewhere on the next attempt to enter', async () => {
    let contextOpen = false;
    answering({ platform_whoami: () => whoami(contextOpen ? 'c1' : null) });
    await mount();

    // Opened in another tab: the answer this tab holds still says none, and the
    // click is judged by it — but the refusal asks again.
    contextOpen = true;
    let opened = true;
    await act(async () => { opened = probe.value.enterCompany(company('c1')); });
    expect(opened).toBe(false);

    await settle();
    await act(async () => { opened = probe.value.enterCompany(company('c1')); });
    expect(opened).toBe(true);
  });
});

describe('asking again', () => {
  it('never puts the panel back into its loading state', async () => {
    answering({ platform_whoami: () => whoami(null) });
    await mount();
    expect(probe.value.platformAccessStatus).toBe('ready');

    pending();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    const callsBefore = world.rpc.mock.calls.length;
    await act(async () => { wake(); });
    expect(world.rpc.mock.calls.length).toBe(callsBefore + 1);
    // AdminLayout renders 'loading' as a spinner, which would unmount the page.
    expect(probe.value.platformAccessStatus).toBe('ready');
    expect(probe.value.isPlatformStaff).toBe(true);
  });

  it('asks once when focus and visibilitychange arrive together', async () => {
    answering({ platform_whoami: () => whoami(null) });
    await mount();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    const callsBefore = world.rpc.mock.calls.length;
    // Two separate tasks, as a browser delivers them. Inside one act React would
    // batch both into a single effect run and hide whether the gap does anything.
    await act(async () => { wake(); });
    await act(async () => {
      for (const listener of world.listeners.get('focus') ?? []) listener();
    });
    expect(world.rpc.mock.calls.length).toBe(callsBefore + 1);
  });

  it('closes the company and keeps the panel when a re-ask fails', async () => {
    answering({ platform_whoami: () => whoami('c1') });
    await mount();
    await act(async () => { probe.value.enterCompany(company('c1')); });
    await settle();

    world.rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'offline' } }));
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await act(async () => { wake(); });
    await settle();

    expect(probe.value.activeCompany).toBeNull();
    expect(probe.value.isPlatformStaff).toBe(true);
    expect(probe.value.platformAccessStatus).toBe('ready');
  });
});

describe('a staff account with a company of its own', () => {
  it('reads its own company only when the database admits it', async () => {
    world.auth = { user: { id: 'staff-1' }, isSuperAdmin: true, companyId: 'own' };
    answering({ platform_whoami: () => whoami(null), get_active_company_id: () => ({ data: 'own', error: null }) });
    await mount();
    expect(probe.value.ownCompanyReadable).toBe(true);
  });

  it('does not, when the database answers NULL for a pending or unsubscribed company', async () => {
    world.auth = { user: { id: 'staff-1' }, isSuperAdmin: true, companyId: 'own' };
    answering({ platform_whoami: () => whoami(null), get_active_company_id: () => ({ data: null, error: null }) });
    await mount();
    expect(probe.value.ownCompanyReadable).toBe(false);
  });

  it('asks nothing extra for a company user, and trusts the router', async () => {
    world.auth = { user: { id: 'user-1' }, isSuperAdmin: false, companyId: 'own' };
    answering({});
    await mount();
    expect(world.rpc).not.toHaveBeenCalled();
    expect(probe.value.ownCompanyReadable).toBe(true);
  });
});
