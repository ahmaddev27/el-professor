import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import { parseAppConfig, SEED_APP_CONFIG, type AppConfig } from '../lib/appConfig';

/**
 * The product configuration the database holds: the price book, the plan
 * feature map and the trial length (plan 3.9).
 *
 * Loaded once per session: `get_public_config()` while nobody is signed in,
 * `get_app_config()` once somebody is, and again only when the signed-in
 * account changes. Until the first answer arrives, and whenever a load fails,
 * the screens show the seed, which is what the database was seeded with.
 */
interface AppConfigContextValue extends AppConfig {
  /** True until the database has answered for the current account, or failed to. */
  loading: boolean;
  /** Where the values come from: the database's answer, or the seed. */
  source: 'seed' | 'database';
}

const AppConfigContext = createContext<AppConfigContextValue>({
  ...SEED_APP_CONFIG,
  loading: true,
  source: 'seed',
});

export const AppConfigProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;
  const [config, setConfig] = useState<AppConfig>(SEED_APP_CONFIG);
  const [source, setSource] = useState<'seed' | 'database'>('seed');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // The account is not known yet; asking now would ask for the wrong one.
    if (authLoading) return;

    let cancelled = false;
    const rpcName = userId ? 'get_app_config' : 'get_public_config';
    setLoading(true);

    (async () => {
      const { data, error } = await supabase.rpc(rpcName);
      if (cancelled) return;
      if (error) {
        // The last values stay: the seed on a first load, the last answer after
        // a change of account. Both are prices the database has held.
        console.warn(`${rpcName} failed; showing the prices and plan features already loaded`, error.message);
      } else {
        setConfig(parseAppConfig(data));
        setSource('database');
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, userId]);

  return (
    <AppConfigContext.Provider value={{ ...config, loading, source }}>
      {children}
    </AppConfigContext.Provider>
  );
};

export const useAppConfig = (): AppConfigContextValue => useContext(AppConfigContext);
