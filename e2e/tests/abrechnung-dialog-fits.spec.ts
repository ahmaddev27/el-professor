/**
 * The Abrechnung detail dialog stays inside its own panel.
 *
 * The owner photographed it spilling: the finance cards and the button row
 * painted past the dialog's right edge, with "Schließen" outside the box.
 *
 * ## Why it happened, and why a test rather than a look
 *
 * `DialogContent` is a CSS **grid** with `max-w-*`. A grid item's `min-width` is
 * `auto`, so a child wider than the track cannot shrink — and because the track
 * is capped by `max-width`, it does not grow either. It simply paints outside.
 * The footer's row of buttons was that child.
 *
 * Reading it off a screenshot is how the first diagnosis went wrong twice. This
 * measures `getBoundingClientRect()` on the panel and on every one of its
 * descendants, at three widths, and fails with the names of whatever sticks out.
 * A layout rule nobody can measure is a layout rule that comes back.
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

/** Every descendant of the dialog that paints outside it, with how far. */
async function overflowing(page: Page): Promise<{ tag: string; text: string; by: number }[]> {
  return page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"]');
    if (!panel) return [];
    const box = panel.getBoundingClientRect();
    const out: { tag: string; text: string; by: number }[] = [];
    for (const el of Array.from(panel.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // One pixel of tolerance: a focus ring or a sub-pixel border is not a defect.
      const by = Math.max(r.right - box.right, box.left - r.left);
      if (by > 1) {
        out.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50),
          by: Math.round(by),
        });
      }
    }
    // The widest offender first, and only the outermost of a nest — a child that
    // sticks out usually drags its parent with it, and listing both is noise.
    return out.sort((a, b) => b.by - a.by).slice(0, 8);
  });
}

for (const width of [1440, 768, 375]) {
  test(`the detail dialog fits its panel at ${width} px`, async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width, height: 900 });

    await signIn(page);
    await page.goto('/abrechnung');
    await page.waitForTimeout(9000);

    // November, where the demo company's income sits. Without this the screen
    // opens on the current month, has no rows, and all three cases **skip** —
    // which is how this spec first reported "3 skipped" and proved nothing. The
    // month control is a Radix Select, so it is opened and its option clicked
    // rather than `selectOption`ed.
    const monthCombo = page.getByRole('combobox').nth(2);
    if (await monthCombo.count() > 0) {
      await monthCombo.click();
      await page.waitForTimeout(1200);
      const november = page.getByRole('option', { name: /^November$/ });
      if (await november.count() > 0) await november.click();
      await page.waitForTimeout(9000);
    }

    // The German row label is `Details: {name}` — an earlier spec looked for
    // "Details für", found nothing, and skipped a screen that had the rows.
    const details = page.getByRole('button', { name: /^Details:/ }).first();
    expect(await details.count(),
      'no Abrechnung row to open — the demo data or the month picker moved').toBeGreaterThan(0);
    await details.click();
    await page.waitForTimeout(4000);

    const panel = page.getByRole('dialog');
    await expect(panel, 'the detail dialog opened').toBeVisible();

    const spill = await overflowing(page);
    const box = await panel.boundingBox();
    console.log(`  ${width} px — panel ${Math.round(box!.width)} px wide, `
      + `${spill.length} element(s) outside it`);
    for (const s of spill) console.log(`    ${s.tag} "${s.text}" by ${s.by} px`);

    expect(spill, `content paints outside the dialog at ${width} px`).toEqual([]);

    // And the dialog must not have forced a horizontal scrollbar on the page.
    const scrolls = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(scrolls, `the page scrolls sideways at ${width} px`).toBe(false);
  });
}
