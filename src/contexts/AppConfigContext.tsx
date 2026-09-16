import React, { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import { parseAppConfig, shouldRefreshAppConfig, SEED_APP_CONFIG, type AppConfig } from '../lib/appConfig';

/**
 * The product configuration the database holds: the price book, the plan
 * feature map and the trial length (plan 3.9).
 *
 * `get_public_config()` answers while nobody is signed in, `get_app_config()`
 * once somebody is. It is read on mount, again whenever the signed-in account
 * changes, and again when the tab regains focus with the last answer older than
 * `APP_CONFIG_MAX_AGE_MS` — so a price the owner changes reaches a session that
 * has been open for days, without a polling loop and without a request while
 * the tab sits in the background.
 *
 * Until the first answer arrives, and whenever a load fails, the screens keep
 * the values they already have: the seed at first, the last good answer after.
 */
interface AppConfigContextValue extends AppConfig {
  /** True until the database has answered for the current account, or failed to. */
  loading: boolean;
  /** Where the values come from: the database's answer, or the seed. */
  source: 'seed' | 'database';
  /**
   * Reads the configuration again now, ignoring the staleness window, without
   * touching `loading`. For the platform settings screens (plan 3.6c) to call
   * after a write, so the owner sees what they just saved.
   */
  refresh: () => Promise<void>;
}

const AppConfigContext = createContext<AppConfigContextValue>({
  ...SEED_APP_CONFIG,
  loading: true,
  source: 'seed',
  refresh: async () => {},
});

type ConfigRpc = 'get_app_config' | 'get_public_config';

export const AppConfigProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;
  const rpc: ConfigRpc = userId ? 'get_app_config' : 'get_public_config';

  const [config, setConfig] = useState<AppConfig>(SEED_APP_CONFIG);
  const [source, setSource] = useState<'seed' | 'database'>('seed');
  const [loading, setLoading] = useState(true);

  const mounted = useRef(true);
  /** The newest request issued. Only its answer may be installed. */
  const latestRequest = useRef(0);
  /** Whether that request is still open, so a focus does not pile on. */
  const requestOpen = useRef(false);
  /** When the last answer was installed, for the staleness window. */
  const loadedAt = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * `withSpinner` is for the load the screens have to wait for — the first one,
   * and the one after the account changes. A background refresh leaves
   * `loading` alone, so nothing flashes.
   *
   * A change of account starts a second request while the first may still be
   * open, so only the newest one installs an answer.
   */
  const load = useCallback(async (which: ConfigRpc, withSpinner: boolean) => {
    const request = ++latestRequest.current;
    requestOpen.current = true;
    if (withSpinner) setLoading(true);

    try {
      const { data, error } = await supabase.rpc(which);
      if (!mounted.current || request !== latestRequest.current) return;

      if (error) {
        // The values already shown stay: the seed on a first load, the last
        // answer after a change of account or a refresh. Both are values the
        // database has held.
        console.warn(`${which} failed; keeping the prices and plan features already loaded`, error.message);
        return;
      }

      setConfig(previous => parseAppConfig(data, previous));
      setSource('database');
      loadedAt.current = Date.now();
    } finally {
      if (request === latestRequest.current) {
        requestOpen.current = false;
        if (mounted.current && withSpinner) setLoading(false);
      }
    }
  }, []);

  // Which account is signed in decides which RPC answers, so a change of
  // account is a fresh load the screens wait for.
  useEffect(() => {
    // The account is not known yet; asking now would ask for the wrong one.
    if (authLoading) return;
    loadedAt.current = null;
    void load(rpc, true);
  }, [authLoading, rpc, load]);

  // A tab left open for days would otherwise keep quoting the prices of the day
  // it was opened.
  useEffect(() => {
    if (authLoading) return;

    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      if (requestOpen.current) return;
      if (!shouldRefreshAppConfig(loadedAt.current, Date.now())) return;
      void load(rpc, false);
    };

    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [authLoading, rpc, load]);

  const refresh = useCallback(async () => {
    if (authLoading) return;
    await load(rpc, false);
  }, [authLoading, rpc, load]);

  return (
    <AppConfigContext.Provider value={{ ...config, loading, source, refresh }}>
      {children}
    </AppConfigContext.Provider>
  );
};

export const useAppConfig = (): AppConfigContextValue => useContext(AppConfigContext);
