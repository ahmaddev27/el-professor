#!/usr/bin/env node
/**
 * Phase 5 batch 1, clicked through: every write, refusal and filter of the
 * converted Fahrzeuge and Fixkosten screens, run against the harness's
 * in-memory store. Screenshots show a screen; this shows it still works.
 *
 *   npm run harness:flows
 *
 * A later batch copies this file for its own screens. It needs the e2e
 * package's Playwright (npm install in e2e/ once).
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ configFile: join(root, 'design-harness', 'vite.config.ts'), logLevel: 'warn', server: { strictPort: false } });
await server.listen();
const ORIGIN = new URL(server.resolvedUrls.local[0]).origin;
const { chromium, expect } = createRequire(join(root, 'e2e', 'package.json'))('@playwright/test');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--lang=de-DE'] });
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message.split('\n').filter(Boolean).slice(0, 8).join(' | ')}`); }
};
async function open(query, touch = false) {
  const context = await browser.newContext({ viewport: { width: touch ? 375 : 1280, height: 900 }, isMobile: touch, hasTouch: touch, locale: 'de-DE' });
  await context.clock.install({ time: new Date('2026-09-14T10:00:00+02:00') });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${ORIGIN}/design-harness/?${new URLSearchParams({ theme: 'light', lang: 'de', ...query })}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__harness && window.__harness.answered > 0 && window.__harness.pending === 0);
  return { page, context, errors };
}
const idle = page => page.waitForFunction(() => window.__harness.pending === 0);
const rows = page => page.locator('[role="region"] tbody tr');

try {
  await check('Fahrzeuge: add a vehicle with one driver', async () => {
    const { page, context, errors } = await open({ screen: 'fahrzeuge' });
    await page.getByRole('button', { name: 'Fahrzeug hinzufügen' }).click();
    await page.getByLabel(/^Kennzeichen/).fill('b-sl 1111');
    await page.getByLabel('Anja Schubert').check();
    await expect(page.getByText('1/2 Fahrer ausgewählt')).toBeVisible();
    await page.getByRole('button', { name: 'Speichern' }).click();
    await idle(page); await page.waitForTimeout(400); await idle(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'B-SL 1111', exact: true })).toBeVisible();
    await expect(page.getByText('15 von 15 aktiven Fahrzeugen')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fahrzeug hinzufügen' })).toBeDisabled();
    if (errors.length) throw new Error(errors.join('; '));
    await context.close();
  });

  await check('Fahrzeuge: an empty plate is stopped by the field, the sheet stays', async () => {
    const { page, context } = await open({ screen: 'fahrzeuge' });
    await page.getByRole('button', { name: 'Fahrzeug hinzufügen' }).click();
    await page.waitForTimeout(300); await idle(page);
    const before = await page.evaluate(() => window.__harness.answered);
    await page.getByRole('button', { name: 'Speichern' }).click();
    await page.waitForTimeout(400);
    await expect(page.getByRole('dialog')).toHaveCount(1);
    const valid = await page.getByLabel(/^Kennzeichen/).evaluate(el => el.validity.valueMissing);
    if (!valid) throw new Error('required not enforced');
    const after = await page.evaluate(() => window.__harness.answered);
    if (after !== before) throw new Error(`a query ran: ${before} -> ${after}`);
    await context.close();
  });

  await check('Fahrzeuge: a third driver is locked once two are chosen', async () => {
    const { page, context } = await open({ screen: 'fahrzeuge' });
    await page.getByRole('button', { name: 'Fahrzeug hinzufügen' }).click();
    await page.getByLabel('Anja Schubert').check();
    await page.getByLabel('Ahmad Haddad').check();
    await expect(page.getByLabel('Bernd Hartmann')).toBeDisabled();
    await page.getByRole('dialog').getByText('Bernd Hartmann').click({ force: true });
    await expect(page.getByText('2/2 Fahrer ausgewählt')).toBeVisible();
    await context.close();
  });

  await check('Fahrzeuge: edit keeps the existing drivers ticked', async () => {
    const { page, context } = await open({ screen: 'fahrzeuge' });
    await page.getByRole('button', { name: 'B-SL 2041 bearbeiten' }).click();
    await expect(page.getByRole('heading', { name: 'Fahrzeug bearbeiten' })).toBeVisible();
    await expect(page.getByLabel(/^Kennzeichen/)).toHaveValue('B-SL 2041');
    await expect(page.getByLabel('Mehmet Yıldız')).toBeChecked();
    await expect(page.getByLabel('Svenja Krüger')).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await context.close();
  });

  await check('Fahrzeuge: delete asks, then removes the row', async () => {
    const { page, context } = await open({ screen: 'fahrzeuge' });
    await page.getByRole('button', { name: 'B-SL 2041 löschen' }).click();
    await expect(page.getByRole('dialog')).toContainText('B-SL 2041');
    await page.getByRole('dialog').getByRole('button', { name: 'Löschen' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await idle(page); await page.waitForTimeout(400); await idle(page);
    await expect(page.getByRole('cell', { name: 'B-SL 2041', exact: true })).toHaveCount(0);
    await expect(rows(page)).toHaveCount(13);
    await context.close();
  });

  await check('Fahrzeuge: cancel in the delete dialog deletes nothing', async () => {
    const { page, context } = await open({ screen: 'fahrzeuge' });
    await page.getByRole('button', { name: 'B-SL 2041 löschen' }).click();
    const before = await page.evaluate(() => window.__harness.answered);
    await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click();
    await page.waitForTimeout(400);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if ((await page.evaluate(() => window.__harness.answered)) !== before) throw new Error('a query ran');
    await expect(rows(page)).toHaveCount(14);
    await context.close();
  });

  await check('Fahrzeuge: the TÜV tabs filter, and the counts match', async () => {
    const { page, context } = await open({ screen: 'fahrzeuge' });
    await page.getByRole('tab', { name: /Abgelaufen/ }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('B-SL 3472');
    await page.getByRole('tab', { name: /Bald ablaufend/ }).click();
    await expect(rows(page)).toHaveCount(2);
    await page.getByRole('tab', { name: /Unbekannt/ }).click();
    await expect(rows(page)).toHaveCount(1);
    await page.getByRole('tab', { name: /Gültig/ }).click();
    await expect(rows(page)).toHaveCount(10);
    await context.close();
  });

  await check('Fahrzeuge: the empty fleet offers the add button', async () => {
    const { page, context } = await open({ screen: 'fahrzeuge', data: 'empty' });
    await expect(page.getByText('Keine Fahrzeuge vorhanden')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fahrzeug hinzufügen' })).toHaveCount(2);
    await context.close();
  });

  await check('Fixkosten: add a cost, the total follows', async () => {
    const { page, context } = await open({ screen: 'fixkosten' });
    await page.getByRole('button', { name: 'Neue Fixkosten hinzufügen' }).click();
    await expect(page.getByLabel('Beschreibung', { exact: true })).toBeFocused();
    await page.getByLabel('Beschreibung', { exact: true }).fill('Reinigung');
    await page.getByLabel('Betrag (€)').fill('100.5');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await idle(page); await page.waitForTimeout(400); await idle(page);
    await expect(page.getByRole('cell', { name: 'Reinigung', exact: true })).toBeVisible();
    await expect(page.getByText('100,50 €')).toBeVisible();
    await expect(page.getByText('4.759,76 €').first()).toBeVisible();
    await context.close();
  });

  await check('Fixkosten: edit a row in place', async () => {
    const { page, context } = await open({ screen: 'fixkosten' });
    await page.getByRole('button', { name: 'Taxameter-Wartung bearbeiten' }).click();
    await page.getByLabel('Betrag (€)').fill('90.1');
    await page.getByRole('button', { name: 'Änderungen an Taxameter-Wartung speichern' }).click();
    await idle(page); await page.waitForTimeout(400); await idle(page);
    await expect(page.getByText('90,10 €')).toBeVisible();
    await expect(page.getByText('4.659,46 €').first()).toBeVisible();
    await context.close();
  });

  await check('Fixkosten: an empty edit is refused with the old warning, nothing written', async () => {
    const { page, context } = await open({ screen: 'fixkosten' });
    await page.getByRole('button', { name: 'Taxameter-Wartung bearbeiten' }).click();
    await page.getByLabel('Betrag (€)').fill('');
    const before = await page.evaluate(() => window.__harness.answered);
    await page.getByRole('button', { name: 'Änderungen an Taxameter-Wartung speichern' }).click();
    await page.waitForTimeout(400);
    if ((await page.evaluate(() => window.__harness.answered)) !== before) throw new Error('a query ran');
    await expect(page.getByText('Bitte füllen Sie alle Felder aus').first()).toBeVisible();
    await context.close();
  });

  await check('Fixkosten: delete asks, then removes the row', async () => {
    const { page, context } = await open({ screen: 'fixkosten' });
    await page.getByRole('button', { name: 'Telefon und Internet löschen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Löschen' }).click();
    await idle(page); await page.waitForTimeout(400); await idle(page);
    await expect(page.getByRole('cell', { name: 'Telefon und Internet', exact: true })).toHaveCount(0);
    await expect(page.getByText('4.594,27 €').first()).toBeVisible();
    await context.close();
  });

  await check('Fixkosten: a viewer sees no write control', async () => {
    const { page, context } = await open({ screen: 'fixkosten', role: 'viewer' });
    await expect(page.getByRole('button', { name: /bearbeiten|löschen|hinzufügen/ })).toHaveCount(0);
    await expect(page.getByText('Keine Berechtigung')).toBeVisible();
    await context.close();
  });

  await check('Fixkosten: a failed load claims neither "no costs" nor 0,00 €', async () => {
    const { page, context } = await open({ screen: 'fixkosten', data: 'error' });
    await expect(page.getByText('Die Daten konnten nicht geladen werden')).toBeVisible();
    await expect(page.getByText('Keine Fixkosten vorhanden')).toHaveCount(0);
    await expect(page.getByText('0,00 €')).toHaveCount(0);
    await context.close();
  });

  await check('Phone: every row action is reachable without scrolling the table', async () => {
    for (const screen of ['fahrzeuge', 'fixkosten']) {
      const { page, context } = await open({ screen }, true);
      const over = await page.locator('[role="region"]').first().evaluate(el => el.scrollWidth - el.clientWidth);
      if (over > 0) throw new Error(`${screen}: table scrolls ${over}px`);
      const box = await page.getByRole('button', { name: /löschen$/ }).first().boundingBox();
      if (!box || box.x + box.width > 375 || box.height < 40) throw new Error(`${screen}: delete button ${JSON.stringify(box)}`);
      await context.close();
    }
  });
} finally {
  await browser.close();
  await server.close();
}
console.log(results.join('\n'));
if (results.some(line => line.startsWith('FAIL'))) process.exitCode = 1;
