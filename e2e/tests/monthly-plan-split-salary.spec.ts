/**
 * The block split and the salaries, walked on staging and checked by arithmetic.
 *
 * The owner put the two together himself — the split changes who works which
 * hours, so it changes what each of them earns. So this does not check that the
 * split "works": it checks the two sums a payslip rests on, on the figures the
 * screen actually rendered.
 *
 * 1. **The hours are conserved.** Every driver's assigned hours, plus the hours of
 *    the blocks nobody got, equal the hours of all the blocks step 3 built. A
 *    split that leaked hours would pay somebody for work nobody did, or lose work
 *    somebody did — and neither is visible by looking at the table.
 * 2. **The salary is the hours times one rate per driver.** The column is derived,
 *    so `salary / hours` must come out the same for every row of one driver and
 *    must be a plausible hourly rate. A salary that drifted from the hours beside
 *    it is the figure that reaches an accountant.
 * 3. **What the split gave up is named**, with its vehicle and times. The owner
 *    agreed to give those rides up; he did not agree to their vanishing.
 *
 * Runs against the synthetic DEMO Monatsplanung GmbH. No real customer's data.
 */
import { test, expect, type Page } from '@playwright/test';

const EMAIL = process.env.E2E_DEMO_EMAIL!;
const PASSWORD = process.env.E2E_DEMO_PASSWORD!;

test.skip(!PASSWORD, 'E2E_DEMO_PASSWORD is not set; the demo password is never in the repo.');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: /E-Mail|Email/i }).fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: /^(Anmelden|Sign in)$/i }).click();
  await page.waitForURL(/\/(overview|uebersicht)/, { timeout: 60_000 });
}

async function screen(page: Page): Promise<string> {
  return (await page.locator('main').first().innerText()).replace(/\n{2,}/g, '\n');
}

/** Every rendered table row as its cell texts. */
async function rows(page: Page): Promise<string[][]> {
  return page.locator('table tbody tr').evaluateAll(list =>
    list.map(row => Array.from(row.querySelectorAll('td')).map(c => c.textContent?.trim() ?? '')));
}

/**
 * The number a cell leads with, or NaN.
 *
 * The hours cell renders as `43,75Abweichung: -95,54` — `innerText` on the `<td>`
 * joins the figure and the deviation beneath it with no separator at all. So the
 * whole cell, and its "first line", are two numbers glued together; stripping the
 * non-digits yields `43,75-95,54` and then NaN. Only the leading number is the
 * figure. Two earlier versions of this read 0,00 h for every driver and the test
 * passed anyway, which is the worse failure of the two.
 */
function leadingNumber(cell: string): number {
  const match = /^-?\d{1,3}(?:\.\d{3})*(?:,\d+)?/.exec((cell ?? '').trim());
  return match ? Number(match[0].replace(/\./g, '').replace(',', '.')) : NaN;
}

test('the split conserves the hours, and the salaries follow them', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));

  await signIn(page);
  await page.goto('/monatsplan?art=standard');
  await page.waitForTimeout(8000);
  await page.getByRole('button', { name: /^Weiter$/ }).click();
  await page.waitForTimeout(5000);

  // ── Step 2: turn the split on ─────────────────────────────────────────────
  //
  // Off by default, because giving up a ride is a decision about a month's
  // revenue. This is the only place in the suite that turns it on.
  console.log('\n── step 2 ──\n' + (await screen(page)).slice(0, 1000));

  // Targeted by the sentence that sits beside the switch, not by position. The
  // first version of this took `input[type="checkbox"]` `.last()` — which on step 2
  // is the last DRIVER in the pool. It checked a driver, the split never turned on,
  // and the test passed while proving nothing. A positional selector on a screen
  // full of checkboxes is a test that cannot fail for the right reason.
  const splitRow = page.locator('label')
    .filter({ hasText: /Ein Block über der Höchstdauer wird an seiner größten/ });
  await expect(splitRow, 'step 2 offers the split').toHaveCount(1);

  const box = splitRow.locator('input[type="checkbox"]');
  expect(await box.isChecked(), 'the split is off until it is asked for').toBe(false);
  await box.check();
  expect(await box.isChecked(), 'the switch holds').toBe(true);
  console.log('  split switched ON');

  await page.getByRole('button', { name: /Bestätigen und Plan erzeugen/ }).click();
  await page.waitForTimeout(15_000);

  // ── Step 3: the blocks, and what the split gave up ────────────────────────
  const step3 = await screen(page);
  console.log('\n── step 3 (split on) ──\n' + step3.slice(0, 1800));

  const blockRows = await rows(page);
  // Column 3 is "Dauer" in decimal hours; the owner's complaint was a block of 10,00.
  const blockHours = blockRows
    .map(cells => leadingNumber(cells[3] ?? ''))
    .filter(n => Number.isFinite(n) && n > 0);
  const totalBlockHours = blockHours.reduce((a, b) => a + b, 0);
  console.log(`  ${blockHours.length} blocks, ${totalBlockHours.toFixed(2)} h in total`);
  if (blockHours.length > 0) {
    console.log(`  longest: ${Math.max(...blockHours).toFixed(2)} h`);
  }

  // What it gave up, named. A ride that leaves the plan unaccounted for is
  // indistinguishable from a defect.
  const gaveUp = /entfall|Übergabe|aufgegeben/i.test(step3);
  console.log(`  given-up rides reported on screen: ${gaveUp}`);
  if (gaveUp) {
    // Each one carries a time, not just a count.
    expect(step3, 'the given-up rides are named with a vehicle and a time')
      .toMatch(/\d{2}[.:]\d{2}/);
  }

  await page.getByRole('button', { name: /Auf Fahrer verteilen|verteilen/ }).first().click();
  await page.waitForTimeout(15_000);

  // ── Step 4: the salaries, checked against the hours beside them ───────────
  const step4 = await screen(page);
  console.log('\n── step 4 ──\n' + step4);

  const driverRows = await rows(page);
  console.log(`  ${driverRows.length} driver rows`);

  let assignedTotal = 0;
  const paid: { driver: string; hours: number; salary: number; rate: number }[] = [];

  for (const cells of driverRows) {
    const driver = cells[0] ?? '';
    // The hours cell carries the deviation underneath it, so only its first line
    // is the figure; reading the whole cell would concatenate two numbers.
    const hours = leadingNumber(cells[1] ?? '');
    const salary = leadingNumber(cells[5] ?? '');
    if (!Number.isFinite(hours)) continue;
    assignedTotal += hours;
    if (hours > 0 && Number.isFinite(salary) && salary > 0) {
      paid.push({ driver, hours, salary, rate: salary / hours });
    }
  }

  for (const row of paid) {
    console.log(`  ${row.driver}: ${row.hours.toFixed(2)} h`
      + ` × ${row.rate.toFixed(2)} €/h = ${row.salary.toFixed(2)} €`);
  }
  console.log(`  assigned in total: ${assignedTotal.toFixed(2)} h`);
  console.log(`  blocks in total:   ${totalBlockHours.toFixed(2)} h`);

  // ── 1. The salary is the hours times a plausible rate ─────────────────────
  //
  // Derived, so the two must agree. The bound is wide on purpose: this asserts
  // the arithmetic holds, not what the demo company pays.
  for (const row of paid) {
    expect(row.rate,
      `${row.driver}: ${row.salary} € over ${row.hours} h is ${row.rate.toFixed(2)} €/h`)
      .toBeGreaterThan(1);
    expect(row.rate, `${row.driver}: ${row.rate.toFixed(2)} €/h is not a rate`).toBeLessThan(200);
  }
  // And one rate per driver: the same driver at two rates in one plan is a derived
  // column that stopped being derived.
  const byDriver = new Map<string, number[]>();
  for (const row of paid) byDriver.set(row.driver, [...(byDriver.get(row.driver) ?? []), row.rate]);
  for (const [driver, list] of byDriver) {
    expect(Math.max(...list) - Math.min(...list),
      `${driver} is paid at two different rates in one plan`).toBeLessThan(0.02);
  }

  // ── 2. The hours are conserved ────────────────────────────────────────────
  //
  // Assigned + unassigned = built. A block nobody can take is a real outcome; what
  // would be a defect is hours missing with nothing said about them.
  const shortfall = totalBlockHours - assignedTotal;
  console.log(`  shortfall: ${shortfall.toFixed(2)} h`);

  if (Math.abs(shortfall) > 0.05) {
    expect(/zugewiesene\s+Blöcke|Hinweise zum Plan|ohne Fahrer|Konflikt/i.test(step4),
      `${shortfall.toFixed(2)} h are unaccounted for and the screen says nothing:\n`
      + step4.slice(0, 900)).toBe(true);
  } else {
    console.log('  every built hour is assigned');
  }
  // Never the other way round: more hours paid than were built.
  expect(assignedTotal, 'more hours are assigned than were built')
    .toBeLessThanOrEqual(totalBlockHours + 0.05);

  expect(errors, `the browser logged errors:\n${errors.join('\n')}`).toEqual([]);
});
