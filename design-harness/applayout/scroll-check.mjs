/**
 * The frame owns scrolling, so this measures it rather than looking at it.
 *
 * A recent PR found `DataTable` + `scrollClassName` leaking its scroll height
 * to the document root: `documentElement.scrollHeight` read 8592 against a
 * correct `body.scrollHeight` of 1237, and the page really scrolled that far.
 * Eyes do not catch that; two numbers do.
 *
 * For each screen it reports, at 1280 and at 375:
 *   - documentElement.scrollHeight vs body.scrollHeight (they must agree)
 *   - how many elements scroll vertically besides the document (a second
 *     scrollbar is one of them)
 *   - the sticky header's viewport y before and after a long scroll (it must
 *     not move)
 *
 * Usage, against a harness already serving (`npm run harness`):
 *   node design-harness/applayout/scroll-check.mjs [origin]
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ownRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const e2eRequire = createRequire(join(ownRoot, 'e2e', 'package.json'));
const { chromium } = e2eRequire('@playwright/test');

const origin = process.argv[2] ?? 'http://localhost:5199';

const SCREENS = ['fahrzeuge', 'uebersicht', 'belege', 'gehaelter', 'benachrichtigungen', 'werkstatt'];
const WIDTHS = [1280, 375];

const browser = await chromium.launch({ channel: 'chrome' });
let problems = 0;

for (const screen of SCREENS) {
  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: width < 768 ? 812 : 900 },
      isMobile: width < 768,
      hasTouch: width < 768,
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/design-harness/?screen=${screen}&theme=light&lang=de`, {
        waitUntil: 'domcontentloaded',
        timeout: 600_000,
      });
      await page.waitForFunction(
        () => window.__harness && window.__harness.answered > 0 && window.__harness.pending === 0,
        null,
        { timeout: 180_000 },
      );
      await page.waitForTimeout(800);

      const before = await page.evaluate(() => {
        const header = document.querySelector('header');
        return {
          docScroll: document.documentElement.scrollHeight,
          bodyScroll: document.body.scrollHeight,
          viewport: window.innerHeight,
          headerTop: header ? Math.round(header.getBoundingClientRect().top) : null,
          // Anything other than the document that scrolls vertically. The
          // sidebar's own nav is allowed to; a second page-length scroller is not.
          scrollers: Array.from(document.querySelectorAll('*'))
            .filter(el => el.scrollHeight > el.clientHeight + 4 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY))
            .map(el => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').slice(0, 2).join('.')}`),
        };
      });

      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => {
        const header = document.querySelector('header');
        return {
          headerTop: header ? Math.round(header.getBoundingClientRect().top) : null,
          scrollY: Math.round(window.scrollY),
        };
      });

      const mismatch = Math.abs(before.docScroll - before.bodyScroll) > 4;
      // The header is sticky, so once the page has scrolled past it, it sits at
      // the top of the viewport and stays there.
      const stuck = after.headerTop !== null && after.headerTop >= -1 && after.headerTop <= 2;
      const ok = !mismatch && (after.scrollY === 0 || stuck);
      if (!ok) problems += 1;

      console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${screen.padEnd(20)} ${String(width).padStart(4)}  ` +
          `doc=${before.docScroll} body=${before.bodyScroll} vh=${before.viewport}  ` +
          `header ${before.headerTop}→${after.headerTop} (scrollY ${after.scrollY})  ` +
          `other scrollers: ${before.scrollers.length ? before.scrollers.join(', ') : 'none'}`,
      );
    } catch (error) {
      problems += 1;
      console.log(`FAIL ${screen.padEnd(20)} ${String(width).padStart(4)}  ${String(error.message).split('\n')[0]}`);
    } finally {
      await context.close();
    }
  }
}

await browser.close();
console.log(problems === 0 ? '\nall measured pages agree' : `\n${problems} problem(s)`);
process.exitCode = problems === 0 ? 0 : 1;
