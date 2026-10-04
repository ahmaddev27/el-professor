/**
 * Monatsplan, the screen after "Auf Fahrer verteilen": the owner's free time
 * (mplan.ownerFree.*, src/utils/monthlyPlan/ownerFreeTime.ts), walked in a
 * browser.
 *
 * Checks: the "Freie Zeit des Inhabers" panel renders; its summary names hours
 * the owner has taken, hours free and a number of windows; the list shows
 * windows as "TT.MM.JJJJ HH:MM – HH:MM · X,X h" with German formatting; the
 * listed hours agree with the stated total; and the panel does NOT claim to have
 * assigned anything - its own sentence says the blocks are not moved, and the
 * walk sends no write to the database.
 *
 * ## What this writes
 *
 * Nothing. Planning is computed in memory until "Plan speichern"/"bestätigen",
 * which this spec never presses; any non-GET request to the REST API other than
 * the CORS preflight fails it. It still refuses to run unless the signed-in
 * account is the demo administrator, because the screen is one click from a save.
 *
 * ## Defects are recorded softly
 *
 * A defect this walk found is asserted with expect.soft, so it keeps failing the
 * run, and names itself, until the screen is fixed - but the rest of the walk
 * still runs and reports. See the "DEFECT" messages.
 *
 * Runs against the synthetic DEMO Monatsplanung GmbH ("Inhaber Demo" is its
 * owner driver). No real customer's data.
 */
import { test, expect, type Page } from '@playwright/test';
import { DEMO_PASSWORD, assertDemoAccount, signInAsDemo } from '../lib/demoSession';

test.skip(!DEMO_PASSWORD, 'E2E_DEMO_PASSWORD is not set; the demo password is never in the repo.');

const main = async (page: Page) => (await page.locator('main').first().innerText()).replace(/\n{2,}/g, '\n');

test('the owner free-time panel shows windows and hours, and assigns nothing', async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));
  const writes: string[] = [];
  page.on('request', r => {
    const u = r.url();
    // supabase-js calls read RPCs (get_app_config, get_weekly_abrechnung, ...) with POST,
    // so a POST to rpc/get_* is a read; everything else that is not a GET is a write.
    const readRpc = /\/rest\/v1\/rpc\/get_[a-z_]+$/.test(u);
    if (/\/rest\/v1\//.test(u) && !readRpc && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) {
      writes.push(`${r.method()} ${u}`);
    }
  });

  await signInAsDemo(page);
  await assertDemoAccount(page);

  // Steps 1 to 4, as monthly-plan-walk.spec.ts does them.
  await page.goto('/monatsplan');
  await page.waitForTimeout(8000);
  await page.getByRole('button', { name: /^Weiter$/ }).click();
  await page.waitForTimeout(5000);

  // The demo owner is NOT in the driver pool by default ("Nicht ausgewählt 1"),
  // and a plan without an owner correctly shows no panel. Select him, as an
  // operator who wants to see his free time would.
  const ownerBox = page.getByRole('checkbox', { name: /Inhaber Demo/ });
  await expect(ownerBox, 'step 2 offers the owner driver "Inhaber Demo" as a checkbox').toHaveCount(1);
  await ownerBox.check();
  await expect(ownerBox).toBeChecked();
  await page.getByRole('button', { name: /Bestätigen und Plan erzeugen/ }).click();
  await page.waitForTimeout(12_000);
  await page.getByRole('button', { name: /Auf Fahrer verteilen|verteilen/ }).first().click();

  const title = page.getByText('Freie Zeit des Inhabers', { exact: true });
  await expect(title, 'the owner free-time panel is on the screen after the blocks are shared out')
    .toBeVisible({ timeout: 90_000 });

  const panel = title.locator('xpath=ancestor::*[.//ul][1]');
  const text = (await panel.innerText()).replace(/\s+/g, ' ');
  console.log('panel:', text.slice(0, 900));

  // Summary: "Der Inhaber hat X Stunden übernommen und ist in diesem Monat Y Stunden frei, verteilt auf N Zeitfenster. ..."
  const summary = /Der Inhaber hat ([\d.]+,\d) Stunden übernommen und ist in diesem Monat ([\d.]+,\d) Stunden frei, verteilt auf (\d+) Zeitfenster/
    .exec(text);
  expect(summary, `the summary sentence is not as specified:\n${text.slice(0, 500)}`).not.toBeNull();
  const num = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));
  const [assigned, free, windows] = [num(summary![1]), num(summary![2]), Number(summary![3])];
  console.log(`owner took ${assigned} h, is free ${free} h in ${windows} windows`);
  expect(windows, 'at least one window, or the panel would not render').toBeGreaterThan(0);
  expect(free, 'free hours are positive').toBeGreaterThan(0);

  // It states what it does NOT do.
  expect(text, 'the panel says the blocks are not moved').toContain('Die Blöcke werden hier nicht verschoben');
  expect(text, 'and an unfitting block stays unassigned').toContain('bleibt unzugeteilt');

  // The window list: German date and time, hours with a decimal comma.
  const items = panel.locator('ul li');
  const listed = await items.allInnerTexts();
  console.log(`${listed.length} windows listed; first three: ${JSON.stringify(listed.slice(0, 3))}`);
  expect(listed.length, 'at most 14 windows are listed, the rest summarised').toBe(Math.min(windows, 14));
  for (const item of listed) {
    expect(item.replace(/\s+/g, ' ').trim(), 'a window line is DD.MM.YYYY HH:MM – HH:MM · X,X h')
      .toMatch(/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2} – \d{2}:\d{2} · [\d.]+,\d h$/);
  }
  // DEFECT (found 04.10.2026): a whole-day window is drawn "02.11.2026 00:00 –
  // 00:00 · 24,0 h". The end carries no date, so start and end read identical and
  // the line looks like a window of no length. It should say 24:00 or name the
  // next day.
  const wholeDay = listed.map(i => i.replace(/\s+/g, ' ').trim()).filter(i => /· 24,0 h$/.test(i));
  for (const item of wholeDay.slice(0, 1)) {
    const [, from, to] = /(\d{2}:\d{2}) – (\d{2}:\d{2})/.exec(item)!;
    expect.soft(from === to,
      `DEFECT: a 24,0 h window reads "${item}": start and end are the same clock time with no date on the end`)
      .toBe(false);
  }

  // The owner's assigned hours in the summary agree with his row in the table.
  const ownerRow = page.locator('table tbody tr').filter({ hasText: 'Inhaber Demo' }).first();
  const rowHours = num(/(\d[\d.]*,\d{2})/.exec((await ownerRow.innerText()).replace(/\s+/g, ' '))![1]);
  expect(Math.abs(rowHours - assigned), `summary says ${assigned} h taken, his table row ${rowHours} h`)
    .toBeLessThanOrEqual(0.05);

  // DEFECT (found 04.10.2026): "in diesem Monat X Stunden frei" counts only the days
  // on which the fleet drove (21 windows of 24 h = 504 h in a 30-day November),
  // by design in ownerFreeTime.ts, so "in diesem Monat" overstates what is counted.
  // Recorded, not asserted: whether the sentence or the figure should change is a
  // product decision.
  if (windows > 14) {
    expect(text, 'the remainder is counted').toContain(`… und ${windows - 14} weitere Zeitfenster.`);
  } else {
    const sum = listed.reduce((acc, item) => acc + num(/· ([\d.]+,\d) h/.exec(item)![1]), 0);
    expect(Math.abs(sum - free), `listed windows (${sum.toFixed(1)} h) agree with the stated total (${free} h)`)
      .toBeLessThanOrEqual(0.05 * windows + 0.1);
  }

  // Assigns nothing: no write, and the panel never says it did.
  const everything = await main(page);
  expect(text, 'the panel never claims an assignment').not.toMatch(/wurde[n]? (zugeteilt|zugewiesen|verschoben)|automatisch zugewiesen/i);
  expect(writes, 'walking to this screen sent no write').toEqual([]);
  console.log('screen after the panel mentions "Plan speichern":', /speichern/i.test(everything));

  expect(errors, 'no uncaught page error').toEqual([]);
});
