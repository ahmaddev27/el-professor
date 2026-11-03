#!/usr/bin/env node
/**
 * A responsive sweep: every screen at every width, measured instead of looked at.
 *
 *   node e2e/responsive-sweep.mjs --base <url> --out <dir> [--only belege,fahrer] [--lang de|en] [--deep] [--shots] [--panel]
 *
 * It signs in as the DEMO company (e2e/.env.local), opens each route, resizes
 * through the widths without reloading, and asks the page what is wrong:
 *
 *   overflow   the page scrolls sideways; names what sticks out
 *   cut        a control or text past the edge of a box that hides it and cannot scroll
 *   overlap    two controls or labels drawn on top of each other
 *   squeezed   a text field too narrow to read what is typed in it
 *   clipped    text cut off with no ellipsis
 *   spill      text wider than its own box, running over what is beside it
 *   cramped    a narrow column that breaks a short text into a word per line
 *   broken     a box narrower than one word in it, so the word breaks in the middle
 *   offscreen  a dialog that does not fit, with no way to scroll to its end
 *   tap        on a touch screen, a control too small to press
 *   rawcode    text a person should not have to read: an engine code or an id
 *
 * With --deep it also walks every tab, moves each wizard forward, and presses every
 * button on the page. What a press opens (a dialog, a panel, another page) is measured,
 * then the page is put back. It does not press inside a dialog, so nothing is submitted.
 *
 * --panel measures the platform panel instead, on the invented data of
 * responsive-panel-standin.mjs.
 *
 * Run it behind a proxy that refuses writes (see e2e/README.md). Pressing every
 * button is only safe because the network layer refuses what a button might send.
 *
 * A wide table in its own scrolling frame is not a defect: the frame scrolls, the
 * page does not. Nor is an icon laid over a field: it is positioned on purpose.
 */
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPanelStandIn, PANEL_ROUTES } from './responsive-panel-standin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(here, 'package.json'))('@playwright/test');

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const BASE = arg('base') ?? 'http://127.0.0.1:5199';
const OUT = resolve(arg('out') ?? join(here, '.responsive'));
const ONLY = arg('only')?.split(',').filter(Boolean);
const LANG = arg('lang') ?? 'de';
const DEEP = args.includes('--deep');
const SHOTS = args.includes('--shots');
const PANEL = args.includes('--panel');
if (!['127.0.0.1', 'localhost'].includes(new URL(BASE).hostname)) {
  throw new Error(`refusing ${BASE}: --deep presses buttons, so only a local build behind the read-only proxy`);
}
const envFile = join(here, '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
  }
}

/** Real device sizes: a laptop's height is what decides whether a dialog fits. */
const MOUSE_SIZES = [[1024, 768], [1180, 820], [1280, 720], [1366, 768], [1440, 900], [1536, 864], [1920, 1080], [2560, 1440]];
const TOUCH_SIZES = [[320, 640], [375, 812], [430, 932], [640, 900], [768, 1024], [900, 700]];
const SHOT_WIDTHS = new Set([375, 768, 1280, 1920]);

/** Reached with no session. Signing in comes after these. */
const PUBLIC_ROUTES = ['', 'login', 'signup', 'auth/forgot-password', 'auth/verify-email', 'einladung', 'impressum', 'datenschutz'];

const ROUTES = [
  'overview', 'belege', 'fahrer', 'datenimport', 'cars', 'umsaetze', 'fixkosten', 'bargeldbestand', 'werkstatt',
  'abrechnung', 'notes', 'benachrichtigungen', 'salaries', 'dokumente', 'fahrtenbuch', 'stundennachweis',
  'company-planner', 'monatsplan', 'monatsplan?art=standard', 'monatsplan?art=schichten', 'fahrtenanalyse',
  'users', 'roles', 'billing', 'settings', 'datensicherung', 'mein-konto',
];

/** A press that leaves the page or hands the browser a file measures nothing. */
const NEVER_PRESS = /abmeld|sign out|log ?out|export|download|herunterlad|drucken|print|\bpdf\b|excel|csv|hochlad|upload|importier/i;

/** The buttons that move a wizard on. "Apply" is not one of them: the proxy would refuse it, and nothing follows. */
const FORWARD = /^(Weiter|Next|Continue|Bestätigen und Plan erzeugen|Confirm and generate the plan|Auf Fahrer verteilen|Share out to drivers|Empfehlung berechnen|Calculate recommendation|Neue Planung starten|Start a new plan|Plan bestätigen|Confirm the plan|Weiter zu den Dokumenten|Continue to the documents)$/i;

/** The month the DEMO company's plan can be confirmed for; a later one stops at step 4. */
const PLAN_MONTH = { 'monatsplan?art=standard': 'November 2026' };

/** A wizard with a fork in it: each list is one way through, pressed in order, then walked forward. */
const FORKS = {
  'company-planner': [
    [/^(Historischen Abgleich starten|Start historical reconciliation)$/, /^(Mit Brutto-Gehältern starten|Start with gross salaries)$/],
    [/^(Historischen Abgleich starten|Start historical reconciliation)$/, /^(Mit Arbeitsstunden starten|Start with working hours)$/],
  ],
};

/** Everything on a page a person can press, a card or a link as much as a button. */
const PRESSABLE = 'main button, main [role="button"], main a[href], main [class*="cursor-pointer"]';

/** Runs in the page. Returns the defects at the current size, scoped to the top layer. */
function inspect() {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const visible = el => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const closed = el.closest('details:not([open])');
    if (closed && !el.closest('summary')) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    // A closed off-canvas menu is drawn past the edge on purpose.
    return r.right > 0 && r.left < vw + 2000;
  };
  const describe = el => {
    const tag = el.tagName.toLowerCase();
    const text = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || '')
      .toString().replace(/\s+/g, ' ').trim().slice(0, 40);
    return text ? `${tag} "${text}"` : `${tag}.${String(el.className).split(' ').slice(0, 3).join('.')}`;
  };
  const closestFixed = el => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const position = getComputedStyle(p).position;
      if (position === 'fixed' || position === 'sticky') return p;
    }
    return null;
  };
  /** The nearest ancestor that clips sideways, and whether a person can scroll it. */
  const clipper = el => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll') return { el: p, scrolls: true };
      if (o === 'hidden' || o === 'clip') return { el: p, scrolls: false };
    }
    return null;
  };

  // The top layer: an open dialog, whichever kind. What is behind it cannot be used.
  const radix = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible);
  const legacy = [...document.querySelectorAll('body *')].filter(el => {
    if (getComputedStyle(el).position !== 'fixed' || !visible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= vw - 1 && r.height >= vh - 1 && el.querySelector('input, select, textarea, button');
  });
  const layers = [...radix, ...legacy];
  const inDialog = layers.length > 0;
  const scope = inDialog ? layers[layers.length - 1] : document.body;
  const defects = [];

  const pageOverflow = document.documentElement.scrollWidth - vw;
  if (pageOverflow > 1) {
    const offenders = [...document.querySelectorAll('body *')]
      .filter(el => {
        if (!visible(el) || el.getBoundingClientRect().right <= vw + 1) return false;
        const c = clipper(el);
        return !c || c.el.getBoundingClientRect().right > vw + 1;
      })
      .filter(el => !el.closest('svg'))
      .slice(-3).map(describe);
    defects.push({ kind: 'overflow', px: pageOverflow, detail: offenders.join(' | ') });
  }

  const controls = [...scope.querySelectorAll('input, select, textarea, button, label, [role="combobox"], [role="tab"], a[class*="button"]')]
    .filter(el => {
      if (!visible(el)) return false;
      if (el.tagName === 'INPUT' && ['hidden', 'file', 'checkbox', 'radio', 'range', 'color'].includes(el.type)) return false;
      return !el.closest('[aria-hidden="true"]') && !el.closest('.sr-only');
    });
  /** What can actually be seen of a box: scrolled under a form's footer is not on top of it. */
  const seenRect = el => {
    const r = el.getBoundingClientRect();
    let { left, right, top, bottom } = r;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const e = p.getBoundingClientRect();
      left = Math.max(left, e.left); right = Math.min(right, e.right);
      top = Math.max(top, e.top); bottom = Math.min(bottom, e.bottom);
    }
    return { left, right, top, bottom };
  };
  const boxes = controls.map(el => ({ el, r: el.getBoundingClientRect(), seen: seenRect(el), s: getComputedStyle(el), fixed: closestFixed(el) }));

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]; const b = boxes[j];
      if (a.fixed !== b.fixed) continue;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.s.position === 'absolute' || b.s.position === 'absolute') continue;
      if ((a.el.htmlFor && a.el.htmlFor === b.el.id) || (b.el.htmlFor && b.el.htmlFor === a.el.id)) continue;
      const w = Math.min(a.seen.right, b.seen.right) - Math.max(a.seen.left, b.seen.left);
      const h = Math.min(a.seen.bottom, b.seen.bottom) - Math.max(a.seen.top, b.seen.top);
      if (w > 2 && h > 2) defects.push({ kind: 'overlap', px: Math.round(w), detail: `${describe(a.el)} x ${describe(b.el)}` });
    }
  }

  for (const { el, r } of boxes) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
      // A select holding a year or a short word needs less than a field holding a sentence.
      const min = el.type === 'number' ? 44 : el.tagName === 'SELECT' ? 64 : 80;
      if (r.width < min) defects.push({ kind: 'squeezed', px: Math.round(r.width), detail: describe(el) });
    }
    // Below a clipping box with no scroll, a control simply cannot be reached.
    const c = clipper(el);
    if (c && !c.scrolls) {
      const edge = c.el.getBoundingClientRect();
      const past = Math.max(r.right - edge.right, edge.left - r.left);
      if (past > 2) defects.push({ kind: 'cut', px: Math.round(past), detail: describe(el) });
    }
    if (coarse && ['BUTTON', 'INPUT', 'SELECT', 'A'].includes(el.tagName) && el.getAttribute('role') !== 'switch' && Math.min(r.height, r.width) < 28) {
      defects.push({ kind: 'tap', px: Math.round(Math.min(r.height, r.width)), detail: describe(el) });
    }
  }

  const ruler = document.createElement('canvas').getContext('2d');
  const widestWord = (text, s) => {
    ruler.font = s.font;
    ruler.letterSpacing = s.letterSpacing === 'normal' ? '0px' : s.letterSpacing;
    const shown = s.textTransform === 'uppercase' ? text.toUpperCase() : text;
    return Math.max(...shown.split(/[\s\-\u2013/_.]+/).map(word => ruler.measureText(word).width));
  };
  const TEXT = 'button, a, label, h1, h2, h3, h4, h5, p, span, td, th, dd, dt, li, [role="tab"]';
  for (const el of scope.querySelectorAll(TEXT)) {
    if (!visible(el) || el.children.length > 2) continue;
    const text = (el.innerText || '').trim();
    if (!text || el.closest('.sr-only')) continue;
    const s = getComputedStyle(el);
    if (s.display === 'inline') continue;
    const over = el.scrollWidth - el.clientWidth;
    if (over > 1 && el.clientWidth > 0) {
      if (s.overflowX === 'hidden' || s.overflowX === 'clip') {
        if (s.textOverflow !== 'ellipsis') defects.push({ kind: 'clipped', px: over, detail: describe(el) });
      } else if (s.overflowX === 'visible' && ![...el.children].some(child => getComputedStyle(child).position === 'absolute')) {
        defects.push({ kind: 'spill', px: over, detail: describe(el) });
      }
    }
    const r = el.getBoundingClientRect();
    const room = r.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    if (el.children.length === 0 && s.whiteSpace !== 'nowrap' && s.textOverflow !== 'ellipsis' && room > 0) {
      const widest = widestWord(text, s);
      // A word that really broke fills two lines. On one line the ruler is only disagreeing with the
      // renderer by a pixel or two, as it does for "Wed" over the shift heatmap.
      const measured = document.createRange();
      measured.selectNodeContents(el);
      const onLines = new Set([...measured.getClientRects()].map(rect => Math.round(rect.top))).size;
      if (onLines > 1 && widest > room + 3) defects.push({ kind: 'broken', px: Math.round(widest - room), detail: describe(el) });
    }
    // Lines of text, not the box's height: a table cell is as tall as the tallest cell in its row.
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
    if (!text.includes('\n') && ((r.width < 90 && text.length >= 10 && lines >= 4) || (r.width < 160 && lines >= 10))) {
      defects.push({ kind: 'cramped', px: Math.round(r.width), detail: describe(el) });
    }
  }

  // A code or an id on the screen means a label is missing somewhere. Inputs hold what was typed.
  const RAW = /\b[a-z]{2,}(?:_[a-z0-9]+)+\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/;
  const texts = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = texts.nextNode(); node; node = texts.nextNode()) {
    const match = RAW.exec(node.textContent ?? '');
    if (!match) continue;
    const owner = node.parentElement;
    if (!owner || !visible(owner) || owner.closest('script, style, code, pre, [aria-hidden="true"], .sr-only, option')) continue;
    defects.push({ kind: 'rawcode', px: 0, detail: `${match[0].slice(0, 40)} in "${(owner.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50)}"` });
  }

  if (inDialog) {
    const r = scope.getBoundingClientRect();
    const out = Math.max(r.right - vw, -r.left, 0);
    if (out > 1) defects.push({ kind: 'offscreen', px: Math.round(out), detail: `${describe(scope)} sideways` });
    const panel = radix[radix.length - 1];
    const box = panel ?? scope;
    const p = box.getBoundingClientRect();
    const ancestors = [];
    for (let a = box.parentElement; a && a !== document.documentElement; a = a.parentElement) ancestors.push(a);
    const scrollable = [box, ...box.querySelectorAll('*'), ...ancestors].some(el => {
      const o = getComputedStyle(el).overflowY;
      return (o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 1;
    });
    if (p.bottom > vh + 1 && !scrollable) defects.push({ kind: 'offscreen', px: Math.round(p.bottom - vh), detail: `${describe(box)} below the screen, no scroll` });
    if (panel && p.top < -1) defects.push({ kind: 'offscreen', px: Math.round(-p.top), detail: `${describe(panel)} above the screen` });
  }
  return { inDialog, defects };
}

const dialogOpen = page => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(el => el.getBoundingClientRect().width > 1)) return true;
  return [...document.querySelectorAll('body *')].some(el => {
    if (getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width >= vw - 1 && r.height >= vh - 1 && !!el.querySelector('input, select, textarea, button');
  });
});

const unique = list => {
  const seen = new Set();
  return list.filter(d => { const k = `${d.kind}|${d.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
};

async function signIn(page) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const email = page.getByRole('textbox', { name: /E-Mail|Email/i });
    await email.waitFor({ timeout: 30000 }).catch(() => {});
    if (!/\/login/.test(page.url())) return;
    await email.fill(process.env.E2E_DEMO_EMAIL);
    await page.locator('input[type="password"]').first().fill(process.env.E2E_DEMO_PASSWORD);
    await page.getByRole('button', { name: /^(Anmelden|Sign in)$/i }).click();
    try {
      await page.waitForURL(PANEL ? /\/admin/ : /\/(overview|uebersicht)/, { timeout: 60000 });
      if (!PANEL) await page.getByRole('button', { name: /Demo Administrator/ }).first().waitFor({ state: 'attached', timeout: 30000 });
      return;
    } catch { console.log(`sign-in attempt ${attempt} failed`); }
  }
  throw new Error('sign-in failed');
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
}

const slug = text => text.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'root';

async function sweep(page, sizes, report, where, shots = false) {
  appendFileSync(join(OUT, `visited-${LANG}.txt`), `${where}\n`);
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(180);
    const { defects } = await page.evaluate(inspect);
    for (const d of unique(defects)) report({ where, width, ...d });
    if (shots && SHOTS && SHOT_WIDTHS.has(width)) {
      await page.screenshot({ path: join(OUT, 'shots', `${slug(where)}--${width}.png`), fullPage: !where.includes('>') }).catch(() => {});
    }
  }
}

/** Leaves whatever a press opened, and puts the page back if the press left it. */
async function recover(page, url, changed = false) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  if (changed || page.url() !== url || await dialogOpen(page)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
    await settle(page);
  }
}

const mainText = page => page.evaluate(() => document.querySelector('main')?.innerText ?? '');

/** Moves a wizard forward as far as it goes on its own, measuring each step. */
async function walkForward(page, route, sizes, report) {
  if (PLAN_MONTH[route]) {
    await page.locator('main select').first().selectOption({ label: new RegExp(PLAN_MONTH[route]) }).catch(async () => {
      const option = page.locator('main select').first().locator('option').filter({ hasText: PLAN_MONTH[route] }).first();
      const value = await option.getAttribute('value').catch(() => null);
      if (value) await page.locator('main select').first().selectOption(value).catch(() => {});
    });
    await page.waitForTimeout(800);
  }
  let stalled = 0;
  for (let step = 1; step <= 12; step++) {
    await page.evaluate(() => {
      for (const select of document.querySelectorAll('main select')) {
        if (select.value || select.options.length < 2) continue;
        select.value = select.options[1].value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.waitForTimeout(300);
    const names = await buttonNames(page);
    const index = names.findIndex(n => n && FORWARD.test(n));
    if (index < 0) return;
    const before = await mainText(page);
    const clicked = await page.locator(PRESSABLE).nth(index).click({ timeout: 2500 }).then(() => true).catch(() => false);
    if (!clicked) return;
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    // The plan's steps 4 and 6 show the same words and the same button, so one quiet press is not the end.
    if (await mainText(page) === before) {
      stalled += 1;
      if (stalled > 1) return;
      continue;
    }
    stalled = 0;
    await sweep(page, sizes, report, `${route} step ${step} ${names[index].slice(0, 30)}`, true);
    await page.setViewportSize({ width: sizes[0][0] >= 1000 ? 1440 : sizes[sizes.length - 1][0], height: 900 });
  }
}

/** A button's name, the same way each time it is asked for. */
const buttonNames = page => page.evaluate(selector => [...document.querySelectorAll(selector)].map(b => {
  const r = b.getBoundingClientRect();
  const usable = r.width > 1 && r.height > 1 && !b.disabled;
  return usable ? (b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}), PRESSABLE);

async function pressEverything(page, sizes, report, where, seen) {
  const url = page.url();
  for (const name of new Set(await buttonNames(page))) {
    if (!name || (name.length <= 40 && NEVER_PRESS.test(name)) || FORWARD.test(name) || seen.has(name)) continue;
    seen.add(name);
    let changed = false;
    const before = await mainText(page);
    // Asked again for each press: a press can reload the rows, which moves every later button.
    const index = (await buttonNames(page)).indexOf(name);
    if (index < 0) continue;
    const clicked = await page.locator(PRESSABLE).nth(index).click({ timeout: 2500 }).then(() => true).catch(() => false);
    if (!clicked) continue;
    await page.waitForTimeout(350);
    // A sheet still sliding in reads as off the screen by its own width.
    await page.evaluate(() => Promise.race([
      Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))),
      new Promise(done => setTimeout(done, 1500)),
    ])).catch(() => {});
    if (await dialogOpen(page)) {
      await sweep(page, sizes, report, `${where} > ${name.slice(0, 40)}`, true);
    } else if (page.url() !== url) {
      await sweep(page, sizes, report, `${where} -> ${new URL(page.url()).pathname}`, true);
    } else if (await mainText(page) !== before) {
      // A panel opened in place, a row expanded, a filter came up. Not every width: there are many of these.
      await sweep(page, sizes.filter((_, i) => i % 3 === 0), report, `${where} ~ ${name.slice(0, 40)}`);
      changed = true;
    }
    await recover(page, url, changed);
  }
}

async function walkRoute(page, route, sizes, report) {
  await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(e => console.log(route, e.message));
  await settle(page);
  // A screen that never opened has no defects, and that must not read as a clean screen.
  // A lazy screen can still be a spinner when the network goes quiet: its chunk is parsing.
  await page.locator('main').first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  const landed = new URL(page.url()).pathname;
  const wanted = `/${route.split('?')[0]}`;
  const opened = landed.startsWith(wanted) && await page.locator('main').count().catch(() => 0) > 0;
  if (!opened) {
    report({ where: route, width: sizes[0][0], kind: 'unreached', px: 0, detail: `landed on ${landed}` });
    return;
  }
  await sweep(page, sizes, report, route, true);
  if (!DEEP) return;
  const seen = new Set();
  await page.setViewportSize({ width: sizes[0][0] >= 1000 ? 1440 : sizes[sizes.length - 1][0], height: 900 });
  await pressEverything(page, sizes, report, route, seen);
  const tabs = await page.locator('main [role="tab"]').allInnerTexts().catch(() => []);
  for (const raw of tabs) {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const tab = page.locator('main [role="tab"]').filter({ hasText: name }).first();
    const clicked = await tab.click({ timeout: 2500 }).then(() => true).catch(() => false);
    if (!clicked) continue;
    await settle(page);
    const where = `${route} #${name.slice(0, 30)}`;
    await sweep(page, sizes, report, where, true);
    await page.setViewportSize({ width: sizes[0][0] >= 1000 ? 1440 : sizes[sizes.length - 1][0], height: 900 });
    await pressEverything(page, sizes, report, where, seen);
  }
  await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  await settle(page);
  await walkForward(page, route, sizes, report);
  for (const [number, fork] of (FORKS[route] ?? []).entries()) {
    await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
    await settle(page);
    let reached = true;
    for (const name of fork) {
      const index = (await buttonNames(page)).findIndex(n => name.test(n));
      if (index < 0) { reached = false; break; }
      await page.locator(PRESSABLE).nth(index).click({ timeout: 2500 }).catch(() => { reached = false; });
      await settle(page);
    }
    if (!reached) { console.log(`${route}: fork ${number} not reached`); continue; }
    await sweep(page, sizes, report, `${route} fork ${number}`, true);
    await page.setViewportSize({ width: sizes[0][0] >= 1000 ? 1440 : sizes[sizes.length - 1][0], height: 900 });
    await walkForward(page, `${route} fork ${number}`, sizes, report);
  }
}

mkdirSync(join(OUT, 'shots'), { recursive: true });
const jsonl = join(OUT, `defects-${LANG}.jsonl`);
writeFileSync(jsonl, '');
writeFileSync(join(OUT, `visited-${LANG}.txt`), '');
const totals = {};
const report = d => {
  appendFileSync(jsonl, `${JSON.stringify(d)}\n`);
  totals[d.kind] = (totals[d.kind] ?? 0) + 1;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [LANG === 'en' ? '--lang=en-GB' : '--lang=de-DE'] });
const allRoutes = PANEL ? PANEL_ROUTES : ROUTES;
const routes = ONLY ? allRoutes.filter(r => ONLY.some(o => r.includes(o))) : allRoutes;
const publicRoutes = PANEL ? [] : ONLY ? PUBLIC_ROUTES.filter(r => r && ONLY.includes(r)) : PUBLIC_ROUTES;
for (const [sizes, touch] of [[MOUSE_SIZES, false], [TOUCH_SIZES, true]]) {
  const context = await browser.newContext({
    viewport: { width: sizes[0][0], height: sizes[0][1] }, locale: LANG === 'en' ? 'en-GB' : 'de-DE', hasTouch: touch, isMobile: touch,
  });
  const page = await context.newPage();
  await page.addInitScript(lang => { try { localStorage.setItem('ya-language', lang); } catch { /* a storage that refuses */ } }, LANG);
  if (PANEL) await installPanelStandIn(page);
  await page.route('**/rest/v1/rpc/monthly_plan_save', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, plan_id: '00000000-0000-4000-8000-000000000099' }),
  }));
  await page.route('**/rest/v1/rpc/monthly_plan_confirm', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, plan_id: '00000000-0000-4000-8000-000000000099', superseded_plan_id: null }),
  }));
  for (const route of publicRoutes) {
    await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(e => console.log(route, e.message));
    await settle(page);
    await sweep(page, sizes, report, `/${route}`, true);
    console.log(`${touch ? 'touch' : 'mouse'} public /${route}`);
  }
  await signIn(page);
  for (const route of routes) {
    const started = Date.now();
    await walkRoute(page, route, sizes, report).catch(e => console.log(`${route} failed: ${e.message.slice(0, 200)}`));
    console.log(`${touch ? 'touch' : 'mouse'} ${route} ${Math.round((Date.now() - started) / 1000)}s`);
  }
  await context.close();
}
await browser.close();
writeFileSync(join(OUT, `totals-${LANG}.json`), JSON.stringify(totals, null, 2));
console.log('totals', JSON.stringify(totals));
if (totals.unreached) {
  console.error(`${totals.unreached} screens were never reached, so this run says nothing about them`);
  process.exit(2);
}
