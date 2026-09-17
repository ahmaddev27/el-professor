import { test, expect } from '@playwright/test';

/**
 * The Google button on staging (plan 1.6, PR C).
 *
 * Which of the two tests runs is decided by staging itself: the button is
 * rendered only while GoTrue reports the provider enabled, so one test checks
 * the switched-off state this pull request ships in, and the other checks the
 * button and where it sends the browser once the owner sets
 * GOOGLE_SIGNIN_ENABLED=true in staging's .env and redeploys.
 *
 * The press is intercepted rather than followed: the authorize URL carries
 * everything worth asserting, and GoTrue's redirect to Google is checked with
 * one manual-redirect fetch. Nothing signs in to a real Google account here —
 * that is the manual check in the pull request.
 */

const apiOrigin = new URL(process.env.E2E_API_URL!).origin;
if (apiOrigin !== 'https://api-staging.elprofessor.eu') {
  throw new Error(`E2E_API_URL must be staging's API (https://api-staging.elprofessor.eu), not ${apiOrigin}`);
}

const appOrigin = new URL(process.env.E2E_BASE_URL!).origin;

// The German label: the suite runs with locale de-DE and German is the default.
const BUTTON = 'Mit Google anmelden';

let googleEnabled = false;

test.beforeAll(async () => {
  const key = process.env.E2E_ANON_KEY;
  if (!key) throw new Error('E2E_ANON_KEY is missing. Run "npm run setup" in e2e/ again.');
  const response = await fetch(`${apiOrigin}/auth/v1/settings`, { headers: { apikey: key } });
  const settings = (await response.json()) as { external?: { google?: boolean } };
  googleEnabled = settings.external?.google === true;
});

test('the sign-in screen offers no Google button while the provider is off', async ({ page }) => {
  test.skip(googleEnabled, 'Google is enabled on staging: the button is expected, see the other test.');
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: BUTTON })).toHaveCount(0);
});

test('the Google button sends the browser to Google with the configured client', async ({ page }) => {
  test.skip(!googleEnabled, 'GOOGLE_SIGNIN_ENABLED is false on staging; set it to true and redeploy to run this.');

  await page.goto('/login');
  const button = page.getByRole('button', { name: BUTTON });
  await expect(button).toBeVisible();

  // Stop at GoTrue's authorize route: what it was asked for is the point, and
  // this keeps the test from wandering onto Google's own sign-in page.
  let authorizeUrl = '';
  await page.route('**/auth/v1/authorize*', async route => {
    authorizeUrl = route.request().url();
    await route.abort();
  });

  await button.click();
  await expect.poll(() => authorizeUrl, { timeout: 15_000 }).toContain('/auth/v1/authorize');

  const asked = new URL(authorizeUrl);
  expect(asked.origin).toBe(apiOrigin);
  expect(asked.searchParams.get('provider')).toBe('google');
  expect(asked.searchParams.get('prompt')).toBe('select_account');
  // We call no Google API, so no refresh token is ever requested.
  expect(asked.searchParams.get('access_type')).toBeNull();
  expect(asked.searchParams.get('redirect_to')).toBe(`${appOrigin}/auth/callback`);

  // GoTrue's own redirect: the configured client — one client may serve both
  // environments since owner decision G3, 17.09.2026, so the id is only checked
  // to be present — staging's own callback, and the three scopes the Google
  // Cloud project is registered for.
  const redirect = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(redirect.status).toBeGreaterThanOrEqual(300);
  expect(redirect.status).toBeLessThan(400);

  const toGoogle = new URL(redirect.headers.get('location') ?? '');
  expect(toGoogle.hostname).toBe('accounts.google.com');
  expect(toGoogle.searchParams.get('client_id')).toBeTruthy();
  expect(toGoogle.searchParams.get('redirect_uri')).toBe(`${apiOrigin}/auth/v1/callback`);
  expect(toGoogle.searchParams.get('scope')).toContain('email');
  expect(toGoogle.searchParams.get('access_type')).toBeNull();
});
