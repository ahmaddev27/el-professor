import { Route } from 'react-router-dom';
import AccountPage from '../../src/pages/AccountPage';
import { supabase } from '../../src/lib/supabase';
import { r3Screen, R3_PASSKEYS } from './fixtures';

/** Mein Konto draws its own reads; the one query below only lets settle() see an answer. */
const AccountWithOneRead = () => {
  supabase.from('cars').select('id').then(() => undefined);
  return <AccountPage />;
};

export const R3_ROUTES = <Route path="mein-konto" element={<AccountWithOneRead />} />;

/** GoTrue's settings (passkeys on) and the passkey list, for this batch's screens only. */
if (r3Screen) {
  const realFetch = window.fetch.bind(window);
  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/auth/v1/settings')) return Promise.resolve(json({ passkeys_enabled: true, external: { google: false } }));
    if (method === 'GET' && /\/auth\/v1\/passkeys\/?$/.test(url)) return Promise.resolve(json(R3_PASSKEYS));
    return realFetch(input, init);
  };
}

export function r3InitialEntry(): string | undefined {
  return r3Screen ? '/mein-konto' : undefined;
}

if (r3Screen) {
  (supabase.auth as unknown as { getSession: () => Promise<unknown> }).getSession =
    async () => ({ data: { session: { access_token: 'harness-token' } }, error: null });
}
