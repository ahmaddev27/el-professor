/**
 * Bargeldbestand: the two new buttons, "Bargeld hinzufügen" and "Barzahlung
 * hinzufügen" (src/components/CashEntryDialog.tsx), walked in a browser.
 *
 * Checks, in order: the dialog opens with today's date as TT.MM.JJJJ; it refuses
 * nonsense in the amount, the date and the purpose WITHOUT sending a request;
 * a Bargeld entry raises the balance by exactly its amount and shows as a green
 * "+"; a Barzahlung lowers it by exactly its amount and shows as a red "-".
 *
 * ## What this writes, and why that is safe
 *
 * Two rows in the DEMO Monatsplanung GmbH's cash ledger per run: +1,00 € and
 * -1,00 €, both described "E2E-WALK ...". They net to zero, so the balance
 * returns to where it started and a repeated run cannot distort the company's
 * figures. They cannot be deleted: a manual booking is append-only by design
 * (record_cash_movement is the only writer, and nothing voids one), so each run
 * leaves a pair behind in the transaction list. The spec refuses to write unless
 * the signed-in account is the demo administrator.
 *
 * Runs against the synthetic DEMO Monatsplanung GmbH. No real customer's data.
 */
import { test, expect, type Page } from '@playwright/test';
import { DEMO_PASSWORD, assertDemoAccount, euroTextToCents, signInAsDemo } from '../lib/demoSession';

test.skip(!DEMO_PASSWORD, 'E2E_DEMO_PASSWORD is not set; the demo password is never in the repo.');

const todayBerlin = (): string =>
  new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date());

async function main(page: Page): Promise<string> {
  return (await page.locator('main').first().innerText()).replace(/\n{2,}/g, '\n');
}

/**
 * The "Aktueller Bestand" card, in cents. The cards turn into skeletons for a
 * moment while the ledger reloads after a booking, so this waits for a figure
 * rather than reading the screen once.
 */
async function balanceCents(page: Page): Promise<number> {
  const pattern = /Aktueller Bestand\s*([-−]?[\d.]+,\d{2}\s*€)/;
  await expect(page.locator('main').first(), 'the balance card shows a figure').toContainText(pattern, { timeout: 30_000 });
  return euroTextToCents(pattern.exec(await main(page))![1]);
}

/** The "Manuelle Buchungen" card in cents, or null while no manual entry exists. */
async function manualCardCents(page: Page): Promise<number | null> {
  await balanceCents(page); // the ledger has finished loading
  const m = /Manuelle Buchungen\s*([-−]?[\d.]+,\d{2}\s*€)/.exec(await main(page));
  return m ? euroTextToCents(m[1]) : null;
}

async function openBargeldbestand(page: Page) {
  await page.goto('/bargeldbestand');
  await expect(page.getByRole('button', { name: 'Bargeld hinzufügen' }), 'the add buttons are offered')
    .toBeEnabled({ timeout: 60_000 });
  await expect(page.getByText('Aktueller Bestand')).toBeVisible();
}

const dialog = (page: Page) => page.getByRole('dialog');

test('Bargeld hinzufügen and Barzahlung hinzufügen move the balance by the right sign', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));
  const bookings: string[] = [];
  page.on('request', r => {
    if (r.method() === 'POST' && /\/rest\/v1\/rpc\/record_cash_movement/.test(r.url())) {
      bookings.push(r.postData() ?? '');
    }
  });

  await signInAsDemo(page);
  await assertDemoAccount(page);
  await openBargeldbestand(page);

  const start = await balanceCents(page);
  const startManual = await manualCardCents(page);
  console.log(`start: balance ${start} cents, manual card ${startManual}`);

  // ── The dialog and its validation ─────────────────────────────────────────
  await page.getByRole('button', { name: 'Bargeld hinzufügen' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Bargeld hinzufügen' })).toBeVisible();
  const amount = dialog(page).getByLabel(/^Betrag/);
  const date = dialog(page).getByLabel(/^Datum/);
  const purpose = dialog(page).getByLabel(/^Verwendungszweck/);
  await expect(date, 'the date defaults to today as TT.MM.JJJJ').toHaveValue(todayBerlin());

  const submit = dialog(page).getByRole('button', { name: 'Buchen' });
  const errorText = {
    amount: /Betrag über 0 mit höchstens zwei Nachkommastellen/,
    date: /gültiges Datum als TT\.MM\.JJJJ/,
    future: /nicht in der Zukunft/,
    purpose: /Verwendungszweck angeben/,
  };

  // Everything empty: amount and purpose are refused, the prefilled date is fine.
  await purpose.fill('');
  await submit.click();
  await expect(dialog(page).getByText(errorText.amount)).toBeVisible();
  await expect(dialog(page).getByText(errorText.purpose)).toBeVisible();
  await expect(dialog(page).getByText(errorText.date)).toHaveCount(0);

  for (const bad of ['0', '-1', '1,234', 'abc', '1,0,0']) {
    await amount.fill(bad);
    await purpose.fill('E2E-WALK Prüfung');
    await submit.click();
    await expect(dialog(page).getByText(errorText.amount), `amount "${bad}" is refused`).toBeVisible();
  }

  await amount.fill('1,00');
  for (const bad of ['abc', '31.02.2026', '2026-10-04', '4.10.26', '32.01.2026', '01.01.1999', '']) {
    await date.fill(bad);
    await submit.click();
    await expect(dialog(page).getByText(errorText.date), `date "${bad}" is refused`).toBeVisible();
  }
  await date.fill('01.01.2099');
  await submit.click();
  await expect(dialog(page).getByText(errorText.future), 'a future date is refused').toBeVisible();

  expect(bookings, 'no invalid form reached the database').toHaveLength(0);

  // The booking below uses today's date, typed exactly as a person would.
  await date.fill(todayBerlin());

  // ── Bargeld hinzufügen: +1,00 € ───────────────────────────────────────────
  const inDescription = 'E2E-WALK Einlage 1,00';
  const inBefore = await page.getByText(inDescription).count();
  await amount.fill('1,00');
  await purpose.fill(inDescription);
  await submit.click();
  await expect(page.getByText('Bargeld gebucht.'), 'the success toast').toBeVisible();
  await expect(dialog(page), 'the dialog closes after a booking').toHaveCount(0);
  expect(bookings, 'exactly one booking was sent').toHaveLength(1);

  await expect.poll(() => balanceCents(page), { message: 'balance rose by exactly 1,00 €' })
    .toBe(start + 100);
  await expect(page.getByText(inDescription), 'the entry is in the transaction list')
    .toHaveCount(inBefore + 1);
  const inRow = page.locator('table tbody tr').filter({ hasText: inDescription }).first();
  await expect(inRow).toContainText('+1,00 €');
  await expect(inRow).toContainText('Einnahme');
  console.log('after Bargeld:', (await inRow.innerText()).replace(/\s+/g, ' '),
    '| balance', await balanceCents(page), '| manual card', await manualCardCents(page));
  expect(await manualCardCents(page), 'the manual card moved by +1,00 €').toBe((startManual ?? 0) + 100);

  // ── Barzahlung hinzufügen: -1,00 € ────────────────────────────────────────
  await page.getByRole('button', { name: 'Barzahlung hinzufügen' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Barzahlung hinzufügen' })).toBeVisible();
  await expect(dialog(page).getByLabel(/^Datum/), 'a reopened dialog starts from today again')
    .toHaveValue(todayBerlin());
  await expect(dialog(page).getByLabel(/^Betrag/), 'and from an empty amount').toHaveValue('');
  const outDescription = 'E2E-WALK Entnahme 1,00';
  const outBefore = await page.getByText(outDescription).count();
  await dialog(page).getByLabel(/^Betrag/).fill('1,00');
  await dialog(page).getByLabel(/^Verwendungszweck/).fill(outDescription);
  await dialog(page).getByRole('button', { name: 'Buchen' }).click();
  await expect(page.getByText('Barzahlung gebucht.'), 'the success toast').toBeVisible();
  expect(bookings, 'exactly two bookings were sent in all').toHaveLength(2);
  expect(JSON.parse(bookings[0]).p_direction, 'the first one is incoming').toBe('in');
  expect(JSON.parse(bookings[1]).p_direction, 'the second one is outgoing').toBe('out');

  await expect.poll(() => balanceCents(page), { message: 'balance fell by exactly 1,00 €, back to the start' })
    .toBe(start);
  await expect(page.getByText(outDescription)).toHaveCount(outBefore + 1);
  const outRow = page.locator('table tbody tr').filter({ hasText: outDescription }).first();
  await expect(outRow).toContainText('-1,00 €');
  await expect(outRow).toContainText('Ausgabe');
  console.log('after Barzahlung:', (await outRow.innerText()).replace(/\s+/g, ' '),
    '| balance', await balanceCents(page), '| manual card', await manualCardCents(page));
  expect(await manualCardCents(page), 'the manual card is back to its start').toBe(startManual ?? 0);

  expect(errors, 'no uncaught page error').toEqual([]);
});
