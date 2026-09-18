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
const whoami = (companyId: string | null, seconds = 3600, mode: 'view' | 'support' = 'view') => ({
  data: {
    role: 'support',
    capabilities: ['business.read', 'support.session'],
    company_context: companyId === null ? null : {
      company_id: companyId, company_name: companyId, mode,
      expires_at: new Date(Date.now() + seconds * 1000).toISOString(), seconds_remaining: seconds,
    },
  },
  error: null,
});

/** What platform_context_open answers: success, with the row it wrote. */
const opened = (companyId: string, mode: 'view' | 'support' = 'view', seconds = 3600) => ({
  data: {
    success: true,
    context: {
      company_id: companyId, company_name: companyId, mode,
      expires_at: new Date(Date.now() + seconds * 1000).toISOString(), seconds_remaining: seconds,
    },
  },
  error: null,
});

/** What it answers when it refuses — a return value, never an exception. */
const refused = (reason: string) => ({
  data: { success: false, reason, error: 'German sentence' },
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

/**
 * 3.4b: the company a platform account is in comes from the database, so it
 * survives a reload and follows what the server says — the defect being fixed
 * is that it used to live in this provider's own state and nowhere else.
 */
describe('the company comes from the server', () => {
  it('is open after a reload, with nothing clicked in this tab', async () => {
    // A fresh mount is a reload: no enterCompany has ever run here.
    answering({ platform_whoami: () => whoami('c1') });
    await mount();

    expect(probe.value.effectiveCompanyId).toBe('c1');
    expect(probe.value.isViewingAsCompany).toBe(true);
    // The name comes from the context when no panel screen handed a row over.
    expect(probe.value.activeCompany?.name).toBe('c1');
  });

  it('carries the mode, so a read context writes nothing', async () => {
    answering({ platform_whoami: () => whoami('c1', 3600, 'view') });
    await mount();
    expect(probe.value.companyScope).toMatchObject({ kind: 'view', readOnly: true, companyId: 'c1' });
  });

  it('lets a support session write', async () => {
    answering({ platform_whoami: () => whoami('c1', 3600, 'support') });
    await mount();
    expect(probe.value.companyScope).toMatchObject({ kind: 'support', readOnly: false });
  });

  it('closes the company when the context expires mid-screen, with nothing clicked', async () => {
    answering({ platform_whoami: () => whoami('c1', 600) });
    await mount();
    expect(probe.value.effectiveCompanyId).toBe('c1');

    pending();
    await act(async () => { vi.advanceTimersByTime(600 * 1000 + 1); });
    expect(probe.value.effectiveCompanyId).toBeNull();
    expect(probe.value.companyScope.kind).toBe('none');
    expect(probe.value.companyScope.readOnly).toBe(true);
  });
});

describe('opening and closing a company', () => {
  /*
    The point of installing the RPC's own answer: between a successful
    platform_context_open and the platform_whoami that would confirm it, the
    provider must already hold the context — otherwise the caller navigates and
    PlatformAccountGuard bounces it straight back to /admin.
  */
  it('holds the company the moment the RPC answers, before any whoami', async () => {
    answering({
      platform_whoami: () => whoami(null),
      platform_context_open: () => opened('c1'),
    });
    await mount();
    expect(probe.value.effectiveCompanyId).toBeNull();

    // whoami hangs from here: only the open call's own answer can explain it.
    world.rpc.mockImplementation((fn: string) =>
      fn === 'platform_context_open' ? Promise.resolve(opened('c1')) : new Promise(() => {}));

    await act(async () => { await probe.value.openCompany(company('c1'), 'view'); });
    expect(probe.value.effectiveCompanyId).toBe('c1');
    expect(probe.value.companyScope.kind).toBe('view');
  });

  it('raises a read context to a support session in place', async () => {
    let mode: 'view' | 'support' = 'view';
    answering({
      platform_whoami: () => whoami('c1', 3600, mode),
      platform_context_open: () => { mode = 'support'; return opened('c1', 'support'); },
    });
    await mount();
    expect(probe.value.companyScope.readOnly).toBe(true);

    await act(async () => { await probe.value.openCompany(company('c1'), 'support', 'Beleg prüfen'); });
    expect(probe.value.companyScope).toMatchObject({ kind: 'support', readOnly: false, companyId: 'c1' });
  });

  // A refusal is a return value from the RPC; callPlatformRpc turns it into a
  // throw, and nothing may open on the back of it.
  it('opens nothing when the database refuses', async () => {
    answering({
      platform_whoami: () => whoami(null),
      platform_context_open: () => refused('context_open'),
    });
    await mount();

    let thrown: unknown = null;
    await act(async () => {
      await probe.value.openCompany(company('c1'), 'view').catch((error: unknown) => { thrown = error; });
    });
    expect((thrown as { reason?: string } | null)?.reason).toBe('context_open');
    expect(probe.value.effectiveCompanyId).toBeNull();
  });

  /*
    Closing takes access away here first and asks the server after: the
    optimistic half can only ever show less than the account holds, and leaving
    the company on screen for a round trip after someone asked to leave it is
    the one thing that would be wrong.
  */
  it('closes the company before the server has answered', async () => {
    let closeResolved: (value: unknown) => void = () => {};
    answering({ platform_whoami: () => whoami('c1') });
    await mount();
    expect(probe.value.effectiveCompanyId).toBe('c1');

    world.rpc.mockImplementation((fn: string) =>
      fn === 'platform_context_close'
        ? new Promise(resolve => { closeResolved = resolve; })
        : Promise.resolve(whoami('c1')));

    let closing!: Promise<void>;
    await act(async () => { closing = probe.value.closeCompany(); });
    expect(probe.value.effectiveCompanyId).toBeNull();

    await act(async () => {
      closeResolved({ data: { success: true }, error: null });
      await closing;
    });
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
