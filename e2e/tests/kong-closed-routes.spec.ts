import { test, expect } from '@playwright/test';

// Kong's auth-v1-closed block (deploy/kong.yml) answers 403 on the three
// GoTrue routes that would create an account without Google, whatever GoTrue
// itself would say, and also on the spellings of those paths Kong normalises
// before it matches. GoTrue's settings stay reachable, because the app reads
// them. Passes only once the release that brought the block runs on staging.
//
// Node's fetch on purpose, as in staging-protection.spec.ts: the API needs no
// Basic Auth, and a Playwright request context would add the web login. Each
// target is appended to the origin as written: new URL('//auth/v1/signup', base)
// would read "auth" as a host, while a full URL string keeps the double slash
// and %73 exactly as they are sent.

const apiOrigin = new URL(process.env.E2E_API_URL!).origin;
if (apiOrigin !== 'https://api-staging.elprofessor.eu') {
  throw new Error(`E2E_API_URL must be staging's API (https://api-staging.elprofessor.eu), not ${apiOrigin}`);
}

const CLOSED_MESSAGE = 'This route is closed by the gateway';

// The key supabase-js sends. It ships in the web bundle, so it is public.
function anonKey(): string {
  const key = process.env.E2E_ANON_KEY;
  if (!key) throw new Error('E2E_ANON_KEY is missing. Run "npm run setup" in e2e/ again; it copies staging\'s anon key into e2e/.env.local.');
  return key;
}

const CLOSED_TARGETS = [
  '/auth/v1/signup',
  '/auth/v1/signup/',
  '//auth/v1/signup',
  '/auth/v1/%73ignup',
  '/auth/v1/otp',
  '/auth/v1/magiclink',
];

for (const target of CLOSED_TARGETS) {
  test(`POST ${target} is closed by the gateway`, async () => {
    // An empty body: if the block were ever missing, GoTrue gets nothing it
    // could create an account from.
    const response = await fetch(`${apiOrigin}${target}`, {
      method: 'POST',
      headers: { apikey: anonKey(), 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'manual',
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(CLOSED_MESSAGE);
  });
}

test('GET /auth/v1/settings still answers 200, with Google, signup and autoconfirm agreeing', async () => {
  const response = await fetch(`${apiOrigin}/auth/v1/settings`, {
    headers: { apikey: anonKey() },
    redirect: 'manual',
  });
  expect(response.status).toBe(200);
  const settings = (await response.json()) as { external: { google: boolean }; disable_signup: boolean; mailer_autoconfirm: boolean };
  // Whatever GOOGLE_SIGNIN_ENABLED says on staging: signup is open and
  // autoconfirm off exactly while Google is on (the auth entrypoint).
  expect(typeof settings.external.google).toBe('boolean');
  expect(settings.disable_signup).toBe(!settings.external.google);
  expect(settings.mailer_autoconfirm).toBe(!settings.external.google);
});
