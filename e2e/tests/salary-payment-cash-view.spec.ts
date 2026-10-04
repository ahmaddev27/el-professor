/**
 * Gehälter: the salary dialog, and the read-only view of a cash payment that has
 * no stored receipt (src/components/SalaryPaymentCashView.tsx).
 *
 * Two tests, on purpose, so the one that can be walked is not hidden behind the
 * one that cannot:
 *
 * 1. THE DIALOG. Open Gehälter, pick November (where the demo company's income
 *    sits), click Emil Normal's row, and read the dialog: title, the three
 *    figures, the payment status and the payment history. Writes nothing.
 *
 * 2. THE VIEW. Open a cash payment's "Zahlung ansehen" and check that its banner
 *    says it is not a Gehaltsquittung, that it shows no GQ number, and that it
 *    offers no PDF. This needs a cash payment with no stored receipt, and the
 *    demo company has none: it has no salary payment at all. The screen cannot
 *    make one - with a plan that includes Dokumente every "Barzahlung" entered
 *    in the payment form goes through confirm_salary_cash_payment and so gets a
 *    receipt, and the row then opens that receipt, never the view - so the
 *    fixture can only come from a row inserted directly into salary_payments
 *    (payment_type 'cash', source_type NULL). Without it the test FAILS and says
 *    so; it does not skip, because a skipped spec reads as a pass. Once such a
 *    row exists on the demo company (1,00 € is enough), it runs through.
 *
 * ## What this writes
 *
 * Nothing. Both tests only read; the view itself writes nothing by design, which
 * the second test asserts by watching for any non-GET request while it is open.
 * Both still refuse to run unless the signed-in account is the demo
 * administrator.
 *
 * Runs against the synthetic DEMO Monatsplanung GmbH. No real customer's data.
 */
import { test, expect, type Page } from '@playwright/test';
import { DEMO_PASSWORD, assertDemoAccount, signInAsDemo } from '../lib/demoSession';

test.skip(!DEMO_PASSWORD, 'E2E_DEMO_PASSWORD is not set; the demo password is never in the repo.');

async function openEmilsSalary(page: Page) {
  await page.goto('/salaries');
  const month = page.locator('input[type="month"]').first();
  await expect(month).toBeVisible({ timeout: 60_000 });
  await month.fill('2026-11');
  const row = page.locator('table tbody tr').filter({ hasText: 'Emil Normal' }).first();
  await expect(row, 'Emil Normal has a salary row in November 2026').toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText('597,50 €');
  await row.click();
  await expect(page.getByRole('heading', { name: /Gehaltsdetails — Emil Normal/ })).toBeVisible({ timeout: 30_000 });
}

test('the salary dialog opens from the row and shows the salary and its payment history', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));
  await signInAsDemo(page);
  await assertDemoAccount(page);
  await openEmilsSalary(page);

  await expect(page.getByText('02.11.2026 – 06.12.2026'), 'the period is drawn as DD.MM.YYYY').toBeVisible();
  await expect(page.getByText('Berechnetes Fahrer-Gehalt').first()).toBeVisible();
  await expect(page.getByText('Zahlungshistorie')).toBeVisible();
  const history = await page.getByText('Zahlungshistorie').locator('xpath=ancestor::div[1]').innerText();
  console.log('payment history:', history.replace(/\s+/g, ' ').slice(0, 300));
  console.log('view buttons on screen:', await page.getByRole('button', { name: /Barzahlung vom .* ansehen/ }).count());
  expect(errors, 'no uncaught page error').toEqual([]);
});

test('a cash payment without a receipt opens a view that is not a Gehaltsquittung', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));
  const writes: string[] = [];
  page.on('request', r => {
    const readRpc = /\/rest\/v1\/rpc\/get_[a-z_]+$/.test(r.url());
    if (/\/rest\/v1\//.test(r.url()) && !readRpc && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) {
      writes.push(`${r.method()} ${r.url()}`);
    }
  });
  await signInAsDemo(page);
  await assertDemoAccount(page);
  await openEmilsSalary(page);

  const viewButtons = page.getByRole('button', { name: /Barzahlung vom .* ansehen/ });
  await expect(viewButtons.first(),
    'FIXTURE MISSING: the demo company has no cash salary payment without a stored receipt, so there is nothing to ' +
    'view. The screen cannot create one (every cash payment it takes becomes a Gehaltsquittung); insert one salary_payments ' +
    "row (payment_type 'cash', source_type NULL, 1,00 EUR) for Emil Normal's November 2026 salary, then rerun.")
    .toBeVisible({ timeout: 10_000 });

  await viewButtons.first().click();
  const view = page.getByRole('dialog').filter({ hasText: 'Ansicht dieser Barzahlung' });
  await expect(view.getByRole('heading', { name: 'Barzahlung' })).toBeVisible();
  const text = (await view.innerText()).replace(/\s+/g, ' ');
  console.log('view:', text.slice(0, 900));

  expect(text, 'the banner says it is not a Gehaltsquittung').toContain('ZAHLUNGSANSICHT – keine Gehaltsquittung');
  expect(text).toContain('ohne Quittungsnummer');
  expect(text, 'no GQ number is shown').not.toMatch(/GQ-\d{4}-\d{4}/);
  expect(text, 'no "Nr." receipt number is shown').not.toMatch(/Nr\. ?GQ/);
  await expect(view.getByRole('button', { name: /PDF|Herunterladen|Drucken|Download/i }), 'no PDF button').toHaveCount(0);
  await expect(view.getByRole('link', { name: /PDF/i })).toHaveCount(0);
  const buttons = (await view.getByRole('button').allInnerTexts()).map(b => b.trim()).filter(Boolean);
  console.log('buttons in the view:', JSON.stringify(buttons));
  expect(buttons.every(b => /Schließen|Close/.test(b)), `the view offers only Schließen, not: ${buttons}`).toBe(true);

  await view.getByRole('button', { name: 'Schließen' }).first().click();
  await expect(view).toHaveCount(0);
  expect(writes, 'opening and closing the view wrote nothing').toEqual([]);
  expect(errors, 'no uncaught page error').toEqual([]);
});
