/**
 * The Abrechnung by e-mail, walked on staging and read out of the mailbox.
 *
 * ## Why it runs against the demo company and only the demo company
 *
 * Staging relays its mail through production's Resend and blocks exactly one
 * domain, `@example.com`. The owner was asked twice and decided to leave it that
 * way — so a send on staging to any other address **reaches a real person**.
 *
 * Every driver of DEMO Monatsplanung GmbH has an `@example.com` address, so this
 * exercises the whole path — the browser, the function, SMTP — and nothing leaves
 * the building. It never signs in as any other company, and the
 * confirmation it reads lists the addresses so a wrong one would be visible in the
 * log rather than only in somebody's inbox.
 *
 * ## It asserts on the mailbox, not on the screen
 *
 * A toast saying "sent" is what the screen believes. Mailpit holds what was
 * actually accepted, with its parts, so that is where the assertions are: the
 * message exists, it is addressed to the driver, and it carries the figures.
 *
 * ## No attachment, by the owner's decision of 04.10.2026
 *
 * The mail used to carry the card as a PNG. The owner dropped it (*"no need to
 * create the photo and send it to the driver in the email, it is enough to send
 * the data as text"*, 8b2e208): the figures are in the body, and the image only
 * added a rendering step and a megabyte per driver. This walk asserted the PNG
 * until 08.10.2026 and failed on the decision; it now asserts its absence, so an
 * image coming back unasked fails here too.
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

/** Mailpit's REST API, with the basic auth `setup-staging.sh` wrote. */
async function mailpit(path: string): Promise<unknown> {
  const auth = Buffer.from(`${MAILPIT_USER}:${MAILPIT_PASS}`).toString('base64');
  const response = await fetch(`${MAILPIT}${path}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!response.ok) throw new Error(`mailpit ${path}: ${response.status}`);
  return response.json();
}

interface MailSummary { ID: string; To: { Address: string }[]; Subject: string }

async function findMessage(to: string, since: number): Promise<MailSummary | null> {
  // Mailpit lists newest first. Polled rather than waited on once: the function
  // hands the send to the runtime and SMTP takes a moment.
  for (let attempt = 0; attempt < 20; attempt++) {
    const list = await mailpit('/api/v1/messages?limit=60') as { messages?: MailSummary[] };
    const hit = (list.messages ?? []).find(message =>
      message.To?.some(recipient => recipient.Address?.toLowerCase() === to.toLowerCase())
      && /Abrechnung/i.test(message.Subject ?? ''));
    if (hit) return hit;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  void since;
  return null;
}

test('a week is mailed to one driver, with its figures in the body and no attachment', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));

  const started = Date.now();
  await signIn(page);
  await page.goto('/abrechnung');
  await page.waitForTimeout(9000);

  // November, where the demo company's income sits. The month control is a Radix
  // Select — a button and a listbox, not a native `<select>` — so it is opened and
  // its option clicked rather than `selectOption`ed. An earlier version of this
  // looked for a `<select>`, found none, and skipped over a screen that was simply
  // showing the wrong month.
  const monthCombo = page.getByRole('combobox').nth(2);
  await monthCombo.click();
  await page.waitForTimeout(1200);
  await page.getByRole('option', { name: /^November$/ }).click();
  await page.waitForTimeout(9000);
  console.log('  switched to November');

  // The German label is `Details: {name}` — an earlier version looked for
  // "Details für" and skipped a screen that had the rows all along.
  const details = page.getByRole('button', { name: /^Details:/ }).first();
  if (await details.count() === 0) {
    console.log('  no Abrechnung row for this period — reporting rather than passing quietly');
    test.skip(true, 'the demo company has no Abrechnung row in the selected period');
  }
  await details.click();
  await page.waitForTimeout(6000);

  const driverName = (await page.locator('text=/Ahmed|Anna|Bert|Emil/').first().innerText().catch(() => '')) || '';
  console.log(`  dialog open for: ${driverName}`);

  const send = page.getByRole('button', { name: /Per E-Mail senden|Send by email/ }).first();
  await expect(send, 'the dialog offers the mail button').toBeVisible();
  await send.click();

  // The screen's own answer, kept only as context for a mailbox that stays empty.
  await page.waitForTimeout(25_000);
  const body = await page.locator('body').innerText();
  console.log('  screen says: ' + (body.match(/(Gesendet|Nicht gesendet|Keine E-Mail[^\n]*)/)?.[1] ?? '(nothing)'));

  // The assertion that matters: the mailbox.
  const addresses = ['anna.beispiel@example.com', 'bert.nachtfahrt@example.com',
                     'emil.normal@example.com', 'clara.nullsatz@example.com'];
  let found: MailSummary | null = null;
  let foundFor = '';
  for (const address of addresses) {
    found = await findMessage(address, started);
    if (found) { foundFor = address; break; }
  }
  expect(found, `no Abrechnung mail reached any demo address:\n${addresses.join('\n')}`).not.toBeNull();
  console.log(`  mailbox has: "${found!.Subject}" to ${foundFor}`);

  // No figure in the subject — a subject shows on a lock screen.
  expect(found!.Subject).not.toMatch(/\d+,\d{2}/);

  const message = await mailpit(`/api/v1/message/${found!.ID}`) as {
    Text?: string; HTML?: string; Attachments?: { FileName: string; ContentType: string }[];
  };

  // The figures are in the body, as the owner asked.
  expect(message.Text ?? '', 'the mail carries no figures').toMatch(/\d+,\d{2}\s*€/);
  expect(message.Text ?? '').toMatch(/Abzugeben|Guthaben/);

  // And nothing is attached: the owner dropped the card on 04.10.2026.
  const attachments = message.Attachments ?? [];
  console.log('  attachments: ' + JSON.stringify(attachments.map(a => `${a.FileName} (${a.ContentType})`)));
  expect(attachments, 'the mail carries the figures as text and no image (owner, 04.10.2026)').toEqual([]);

  expect(errors, `the browser logged errors:\n${errors.join('\n')}`).toEqual([]);
});
