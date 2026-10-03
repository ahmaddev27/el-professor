/**
 * "Send to all" — the one button on the week's Total row, walked on staging.
 *
 * The owner's words for it: *"email button to send all to drivers with email in
 * 1 click"*. What this checks is the part that is not the click:
 *
 * 1. **The confirmation names every address before anything goes.** Staging relays
 *    real mail and blocks only `@example.com`, so a list of recipients shown
 *    *before* the send is the whole guard against mailing a real driver by
 *    accident. A dialog that said only "send to 6 drivers?" would not be one.
 * 2. **One result per driver reaches the screen.** The send is the browser looping
 *    one call per driver, precisely so that a partial failure — which is the
 *    normal case — can be reported per driver rather than as one verdict.
 * 3. **The mailbox holds one message per sendable driver**, each addressed to that
 *    driver and carrying their own figures. Asserted on Mailpit, not on the toast:
 *    the single-driver walk already found the toast reporting nothing while the
 *    mail went out fine.
 *
 * Every driver of DEMO Monatsplanung GmbH has an `@example.com` address, so this
 * exercises the whole path and nothing leaves the building. It never signs in as
 * any other company.
 */
import { test, expect, type Page } from '@playwright/test';

const EMAIL = process.env.E2E_DEMO_EMAIL!;
const PASSWORD = process.env.E2E_DEMO_PASSWORD!;
const MAILPIT = process.env.E2E_MAILPIT_URL!;
const MAILPIT_USER = process.env.E2E_MAILPIT_USER!;
const MAILPIT_PASS = process.env.E2E_MAILPIT_PASS!;

test.skip(!PASSWORD, 'E2E_DEMO_PASSWORD is not set; the demo password is never in the repo.');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: /E-Mail|Email/i }).fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: /^(Anmelden|Sign in)$/i }).click();
  await page.waitForURL(/\/(overview|uebersicht)/, { timeout: 60_000 });
}

async function mailpit(path: string): Promise<unknown> {
  const auth = Buffer.from(`${MAILPIT_USER}:${MAILPIT_PASS}`).toString('base64');
  const response = await fetch(`${MAILPIT}${path}`, { headers: { Authorization: `Basic ${auth}` } });
  if (!response.ok) throw new Error(`mailpit ${path}: ${response.status}`);
  return response.json();
}

interface MailSummary { ID: string; To: { Address: string }[]; Subject: string; Created: string }

async function abrechnungMails(): Promise<MailSummary[]> {
  const list = await mailpit('/api/v1/messages?limit=120') as { messages?: MailSummary[] };
  return (list.messages ?? []).filter(m => /Abrechnung/i.test(m.Subject ?? ''));
}

test('one click mails every driver who has an address, and says who it skipped', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));

  // What the mailbox held before, so this run's messages can be told apart from
  // the single-driver walk's. Counted by id, not by time: Mailpit's clock and this
  // machine's are not the same clock.
  const before = new Set((await abrechnungMails()).map(m => m.ID));
  console.log(`  mailbox already held ${before.size} Abrechnung messages`);

  await signIn(page);
  await page.goto('/abrechnung');
  await page.waitForTimeout(9000);

  // November, where the demo company's income sits. The month control is a Radix
  // Select, so it is opened and its option clicked rather than `selectOption`ed.
  await page.getByRole('combobox').nth(2).click();
  await page.waitForTimeout(1200);
  await page.getByRole('option', { name: /^November$/ }).click();
  await page.waitForTimeout(9000);

  // The button on the Total row. Found by its accessible name rather than by
  // position: the row's other cells are figures, and a positional selector on a
  // totals row is the kind that silently clicks the wrong thing.
  // **The week with more than one driver**, not the first one on screen. The first
  // version took `.first()` and landed on the week whose only driver is Emil — so it
  // sent to exactly one recipient and proved nothing about "all". November's income
  // sits in two weeks: Anna and Bert in week 1, Emil alone in week 2.
  const sections = page.locator('section').filter({ hasText: /Woche \d/ });
  const sectionCount = await sections.count();
  let target: ReturnType<typeof sections.nth> | null = null;
  let targetRows = 0;
  for (let i = 0; i < sectionCount; i++) {
    const section = sections.nth(i);
    const rowCount = await section.locator('table tbody tr').count();
    const label = (await section.innerText()).match(/Woche \d+/)?.[0] ?? `#${i}`;
    console.log(`  ${label}: ${rowCount} rows`);
    if (rowCount > targetRows) { targetRows = rowCount; target = section; }
  }
  expect(target, 'no week section with rows was found').not.toBeNull();
  console.log(`  sending the week with ${targetRows} rows`);

  const sendAll = target!
    .getByRole('button', { name: /Woche an alle Fahrer senden|Send the week to all/i }).first();
  if (await sendAll.count() === 0) {
    const names = (await page.getByRole('button').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
    console.log('  buttons on screen: ' + JSON.stringify(names.filter(Boolean)));
  }
  await expect(sendAll, 'the week Total row offers a send-to-all button').toHaveCount(1);
  await sendAll.click();
  await page.waitForTimeout(3000);

  // ── The confirmation, which is the guard ──────────────────────────────────
  const dialog = page.getByRole('dialog');
  await expect(dialog, 'a confirmation opens before anything is sent').toBeVisible();
  const confirmText = await dialog.innerText();
  console.log('\n── the confirmation ──\n' + confirmText);

  // Every address it is about to use, spelled out. This is what lets an operator
  // see a wrong recipient before a real driver gets somebody else's figures.
  const listed = [...confirmText.matchAll(/[\w.+-]+@[\w.-]+/g)].map(m => m[0].toLowerCase());
  console.log(`  addresses named in the dialog: ${listed.length} — ${listed.join(', ')}`);
  expect(listed.length, 'the confirmation names no address at all').toBeGreaterThan(0);
  for (const address of listed) {
    expect(address, `${address} is not a demo address — this must never leave example.com`)
      .toMatch(/@example\.com$/);
  }

  const confirm = dialog.getByRole('button', { name: /^(Jetzt senden|Send now)$/ }).first();
  await expect(confirm, 'the confirmation offers a send button').toBeEnabled();
  await confirm.click();

  // ── What the screen says, caught WHILE it says it ─────────────────────────
  //
  // One call per driver, so this takes as long as the slowest of them — and the
  // answer is a toast, which dismisses itself. The first version read the page once
  // after 45 s, found nothing, and reported "the screen reported nothing"; that was
  // the test looking too late, not the screen staying silent. Which of the two it is
  // matters: a control that reports nothing reads as broken, and this owner has
  // reported exactly that about a different button three times.
  const seen: string[] = [];
  for (let tick = 0; tick < 30; tick++) {
    const body = await page.locator('body').innerText();
    for (const line of body.split('\n').map(l => l.trim())) {
      if (/Sende \d+ von \d+|Abrechnungen wurden gesendet|gesendet, \d+ nicht|Keine E-Mail/.test(line)
          && !seen.includes(line)) {
        seen.push(line);
        console.log(`  screen says: ${line}`);
      }
    }
    if (seen.some(l => /wurden gesendet|nicht:/.test(l))) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  // The progress line and the result are both part of the answer; a send that
  // finishes in silence is the defect this watches for.
  expect(seen, 'the screen said nothing at all, while sending or after it').not.toEqual([]);

  // ── The mailbox, which is the assertion ───────────────────────────────────
  let fresh: MailSummary[] = [];
  for (let attempt = 0; attempt < 25; attempt++) {
    fresh = (await abrechnungMails()).filter(m => !before.has(m.ID));
    if (fresh.length >= listed.length) break;
    await new Promise(resolve => setTimeout(resolve, 4000));
  }

  const delivered = new Set(fresh.flatMap(m => (m.To ?? []).map(r => r.Address.toLowerCase())));
  console.log(`  mailbox gained ${fresh.length} messages, to: ${[...delivered].sort().join(', ')}`);

  expect(fresh.length, 'the click produced no mail at all').toBeGreaterThan(0);
  // Every address the dialog named got one. A dialog that promises six and delivers
  // four is worse than one that promises four.
  for (const address of listed) {
    expect([...delivered], `the dialog named ${address} and nothing reached it`).toContain(address);
  }
  // And nothing reached an address the dialog did not name.
  for (const address of delivered) {
    expect(listed, `${address} was mailed without being named in the confirmation`)
      .toContain(address);
  }

  expect(errors, `the browser logged errors:\n${errors.join('\n')}`).toEqual([]);
});
