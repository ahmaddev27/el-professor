import { test, expect } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL!;

// Staging holds a copy of production data, so it must never answer a visitor
// who has no login — while the release marker stays public for deploy.sh.
//
// The anonymous checks use Node's fetch on purpose. Playwright applies the
// config's httpCredentials to every request context it creates, including
// request.newContext(), so a "visitor without the login" built that way would
// quietly carry the test login and get a 200.

test('staging refuses a visitor without the login', async () => {
  const response = await fetch(new URL('/', baseURL));
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate') ?? '').toMatch(/^Basic/);
});

test('the release marker stays public and names a full commit', async () => {
  const response = await fetch(new URL('/version.txt', baseURL));
  expect(response.status).toBe(200);
  expect((await response.text()).trim()).toMatch(/^[0-9a-f]{40}$/);
});

test('with the login, the sign-in page and the staging banner show', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
  await expect(page.getByText('Testumgebung mit einer Kopie der Produktionsdaten', { exact: false })).toBeVisible();
});
