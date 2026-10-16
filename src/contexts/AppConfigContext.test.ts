import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigProvider, useAppConfig } from './AppConfigContext';
import { SEED_PRICE_BOOK } from '../lib/appConfigSeed';

/**
 * Two rules live in the provider itself, where no pure function can hold them:
 * the configuration is read again when the signed-in account changes, and
 * `loading` comes back down however the newest request was started.
 *
 * Both were broken in a way nothing on screen could show. The effect keyed on
 * the RPC name, which is `get_app_config` for every signed-in account, so a
 * session installed over another — `useOtpSessionHandoff`, an accepted
 * invitation, an email change — kept the first account's configuration and its
 * `loadedAt`. And `loading` was cleared only by a request that carried the
 * spinner, so a `refresh()` that overtook the load on mount left the spinner up
 * for the life of the tab.
 *
 * The provider is rendered for real rather than reasoned about, the way
 * `useGehaltsquittungFlow.test.ts` renders its hook: both rules are about when
 * an effect runs and when a `finally` matches, which is exactly what a reading
 * of the code gets wrong.
 */

const world = vi.hoisted(() => ({
  rpc: vi.fn(),
  auth: { user: null as { id: string } | null, loading: false },
}));

vi.mock('../lib/supabase', () => ({ supabase: { rpc: world.rpc } }));
vi.mock('./AuthContext', () => ({ useAuth: () => world.auth }));

/**
 * vitest runs in the node environment (`vitest.config.ts`), so there is no DOM.
 * The provider registers the focus and visibilitychange listeners that keep a
 * tab open for days from quoting the prices of the day it was opened; neither
 * test fires one, so these are the smallest stand-ins that let it mount.
 */
const noEvents = () => ({
  addEventListener: () => {},
  removeEventListener: () => {},
});
Object.assign(globalThis, {
  window: noEvents(),
  document: { ...noEvents(), visibilityState: 'hidden' },
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Config = ReturnType<typeof useAppConfig>;

const probe: { value: Config } = { value: null as unknown as Config };

function Probe() {
  probe.value = useAppConfig();
  return null;
}

const tree = () => createElement(AppConfigProvider, null, createElement(Probe));

/** What `get_app_config()` answers. The yearly discount says which account's. */
const answer = (yearlyPercent: number) => ({
  data: { price_book: { ...SEED_PRICE_BOOK, yearly_discount_percent: yearlyPercent } },
  error: null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settleWith => {
    resolve = settleWith;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const rendered: ReturnType<typeof create>[] = [];

async function mount() {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree());
  });
  rendered.push(renderer);
  return renderer;
}

beforeEach(() => {
  world.rpc.mockReset();
  world.auth = { user: null, loading: false };
});

afterEach(async () => {
  // A tree left mounted would keep answering a later test's re-render.
  await act(async () => {
    rendered.splice(0).forEach(renderer => renderer.unmount());
  });
});

describe('a change of account is read again', () => {
  it('reloads when one signed-in account is swapped for another', async () => {
    world.auth = { user: { id: 'account-a' }, loading: false };
    world.rpc.mockResolvedValueOnce(answer(14)).mockResolvedValueOnce(answer(30));

    const renderer = await mount();
    await settle();
    expect(world.rpc).toHaveBeenCalledTimes(1);
    expect(world.rpc).toHaveBeenLastCalledWith('get_app_config');
    expect(probe.value.priceBook.yearly_discount_percent).toBe(14);

    // A session installed straight over another, with no signed-out moment in
    // between: the RPC that answers does not change, only the account does.
    world.auth = { user: { id: 'account-b' }, loading: false };
    await act(async () => {
      renderer.update(tree());
    });
    await settle();

    expect(world.rpc).toHaveBeenCalledTimes(2);
    expect(world.rpc).toHaveBeenLastCalledWith('get_app_config');
    expect(probe.value.priceBook.yearly_discount_percent).toBe(30);
  });

  it('reads the public configuration again when the account signs out', async () => {
    world.auth = { user: { id: 'account-a' }, loading: false };
    world.rpc.mockResolvedValueOnce(answer(14)).mockResolvedValueOnce(answer(30));

    const renderer = await mount();
    await settle();
    expect(world.rpc).toHaveBeenLastCalledWith('get_app_config');

    world.auth = { user: null, loading: false };
    await act(async () => {
      renderer.update(tree());
    });
    await settle();

    expect(world.rpc).toHaveBeenCalledTimes(2);
    expect(world.rpc).toHaveBeenLastCalledWith('get_public_config');
  });

  it('does not ask again when the same account renders again', async () => {
    world.auth = { user: { id: 'account-a' }, loading: false };
    world.rpc.mockResolvedValue(answer(14));

    const renderer = await mount();
    await settle();
    expect(world.rpc).toHaveBeenCalledTimes(1);

    // AuthContext builds a new user object on every session refresh. Keying the
    // effect on that object rather than on the id would turn each one into a
    // request.
    world.auth = { user: { id: 'account-a' }, loading: false };
    await act(async () => {
      renderer.update(tree());
    });
    await settle();

    expect(world.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('loading comes back down however the request was started', () => {
  it('clears loading when a refresh overtakes the load on mount', async () => {
    const onMount = deferred<ReturnType<typeof answer>>();
    const onRefresh = deferred<ReturnType<typeof answer>>();
    world.auth = { user: { id: 'account-a' }, loading: false };
    world.rpc.mockReturnValueOnce(onMount.promise).mockReturnValueOnce(onRefresh.promise);

    await mount();
    expect(probe.value.loading).toBe(true);

    // The settings screens of plan 3.6c save, then ask for the values back
    // while the load on mount is still open.
    let refreshed!: Promise<void>;
    await act(async () => {
      refreshed = probe.value.refresh();
    });
    expect(world.rpc).toHaveBeenCalledTimes(2);

    await act(async () => {
      onMount.resolve(answer(14));
      onRefresh.resolve(answer(30));
      await refreshed;
    });
    await settle();

    expect(probe.value.loading).toBe(false);
    // …and the load the refresh overtook did not install its older answer.
    expect(probe.value.priceBook.yearly_discount_percent).toBe(30);
  });

  it('leaves loading up while the only request is still open', async () => {
    const onMount = deferred<ReturnType<typeof answer>>();
    world.auth = { user: { id: 'account-a' }, loading: false };
    world.rpc.mockReturnValueOnce(onMount.promise);

    await mount();
    await settle();
    expect(probe.value.loading).toBe(true);

    await act(async () => {
      onMount.resolve(answer(14));
      await onMount.promise;
    });
    await settle();
    expect(probe.value.loading).toBe(false);
  });
});
