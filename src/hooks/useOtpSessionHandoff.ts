import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import type { OtpSession } from '../lib/otpClient';

/**
 * Installs the session otp-verify returned, then shows `destination`.
 * Resolves to false when the session could not be installed.
 *
 * Signing in swaps App's router. A visitor is served by the public
 * BrowserRouter; as soon as AuthContext sees a user, App mounts the
 * authenticated one in its place. A `navigate()` that runs after that swap goes
 * to the router being unmounted, and the new router — which listens only for
 * popstate — would stay on the code screen, now showing a signed-in user.
 * Whether the swap happens before or after `setSession` resolves depends on
 * the browser's lock and scheduler timing, so neither order is safe.
 *
 * For a visitor the address is therefore rewritten first, and the new router
 * simply starts there. A caller who is already signed in (the forgot-password
 * screen is reachable in both routers) keeps its router and navigates normally.
 */
export function useOtpSessionHandoff() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const signedIn = useRef(user !== null);
  signedIn.current = user !== null;

  return useCallback(async (session: OtpSession, destination: string): Promise<boolean> => {
    const routerWillSwap = !signedIn.current;
    const { pathname, search, hash } = window.location;
    const current = `${pathname}${search}${hash}`;
    if (routerWillSwap) window.history.replaceState(window.history.state, '', destination);

    let installed = false;
    try {
      const { error } = await supabase.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
      installed = !error;
    } catch {
      installed = false;
    }

    if (!installed) {
      if (routerWillSwap) window.history.replaceState(window.history.state, '', current);
      return false;
    }
    if (!routerWillSwap) navigate(destination, { replace: true });
    return true;
  }, [navigate]);
}
