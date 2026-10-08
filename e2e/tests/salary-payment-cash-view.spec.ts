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
 * 2. THE VIEW. Open a cash payment's "Zahlung ansehen" and check that the dialog
 *    says no Gehaltsquittung is stored and that it shows no GQ number. This needs
 *    a cash payment with no stored receipt. The fixture is a 1,00 € row inserted
 *    into salary_payments for Emil Normal's November salary on 08.10.2026 (with
 *    the owner's yes), description "E2E-Fixture (08.10.2026) …". Without it the
 *    test FAILS and says so; it does not skip, because a skipped spec reads as a
 *    pass.
 *
 *    What the view offers changed on 04.–06.10.2026, by the owner's decisions,
 *    and this test asserted the earlier view until 08.10.2026: the printed sheet
 *    lost its "ZAHLUNGSANSICHT – keine Gehaltsquittung" banner (he had it
 *    removed), the view gained Download and Drucken, and it offers to issue a
 *    numbered receipt for the payment (`issue_salary_cash_receipt`). So the
 *    dialog's own sentence is now what says no receipt exists, and the buttons
 *    allowed are those four — never one that would write while the view is
 *    merely opened and closed.
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

  expect(text, 'the dialog says no Gehaltsquittung is stored').toContain('Es ist noch keine Gehaltsquittung gespeichert');
  expect(text, 'and that the view itself assigns no number').toContain('diese Ansicht selbst vergibt keine Nummer');
  expect(text, 'no GQ number is shown').not.toMatch(/GQ-\d{4}-\d{4}/);
  expect(text, 'no "Nr." receipt number is shown').not.toMatch(/Nr\. ?GQ/);
  const buttons = (await view.getByRole('button').allInnerTexts()).map(b => b.trim()).filter(Boolean);
  console.log('buttons in the view:', JSON.stringify(buttons));
  const allowed = /^(Download|Herunterladen|Drucken|Schließen|Close|Quittung mit Nummer ausstellen)$/;
  expect(buttons.every(b => allowed.test(b)), `the view offers only download, print, close and issuing a receipt, not: ${buttons}`).toBe(true);

  await view.getByRole('button', { name: 'Schließen' }).first().click();
  await expect(view).toHaveCount(0);
  expect(writes, 'opening and closing the view wrote nothing').toEqual([]);
  expect(errors, 'no uncaught page error').toEqual([]);
});
