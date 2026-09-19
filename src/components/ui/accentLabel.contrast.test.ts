import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the call sites, not the tokens.
 *
 * WHY THIS PAIR IS WRONG — do not "fix" this test by deleting the rule:
 *
 *   --accent      is the accent BACKGROUND      (light #2563eb, dark #06b6d4)
 *   --accent-text is accent-coloured TEXT for a NORMAL background
 *                                               (light #2563eb, dark #22d3ee)
 *
 * The two names read as if they belonged together. They do not. In the light
 * theme they hold the SAME value, so
 *
 *     style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
 *
 * paints the label in the button's own colour: contrast 1.00:1, the text is
 * invisible. In the dark theme it is 1.34:1 — readable only as a smudge. The
 * owner reported both from staging: a blue button with no text on it at all,
 * and a cyan "Lohnabrechnung speichern" that could only just be made out.
 *
 * A label sitting ON a filled background uses --text-inverse (light #ffffff,
 * dark #111827), which is what `.btn-primary` in index.css has always done.
 * --accent-text stays correct — and stays in use — for accent-coloured text on
 * a normal surface, which is most of its ~90 call sites.
 *
 * tokens.contrast.test.ts measures the token values. This test is the cheap
 * half: it reads the source and refuses the pairing wherever it reappears,
 * including in files that test never looks at.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));

const BACKGROUND_KEYS = ['background', 'backgroundColor', 'background-color'];

/** Tokens that render as a filled block of colour behind a label. */
const FILLED_BACKGROUND_TOKENS = ['accent', 'accent-hover'];

/** Foregrounds that must never sit on one of those. */
const FORBIDDEN_LABEL_TOKENS = ['accent-text'];

/**
 * The same trap, one token pair along.
 *
 * `--success`, `--warning` and `--danger` are status TEXT colours: light on the
 * dark theme's surfaces, dark on the light theme's. `--success-solid`,
 * `--warning-solid` and `--danger-solid` are the same statuses as a FILL under a
 * white label, and in the dark theme they are a different value, because no
 * single value can be both (a white label needs luminance <= 0.183, readable
 * text on --bg-surface needs >= 0.237, and --danger's own -subtle fill pushes
 * that to >= 0.274).
 *
 * So a filled status background must name the `-solid` token. Painting one with
 * `var(--success)` puts white on #10b981 — 2.54:1 — which is what every one of
 * these call sites did until 17.09.2026.
 */
const STATUS_TEXT_TOKENS = ['success', 'warning', 'danger'];

/** The fills built for a white label. */
const SOLID_FILL_TOKENS = ['success-solid', 'warning-solid', 'danger-solid', 'critical-solid'];

/**
 * `--text-inverse` is #ffffff in the light theme and #111827 in the dark one, so
 * it is the right label for a fill that is dark in one theme and light in the
 * other — `--accent`, and `.btn-primary`. A `-solid` token is dark in BOTH
 * themes by construction, so there `--text-inverse` is near-black on a dark red:
 * #111827 on #D63A40 is 3.83:1.
 *
 * This is not hypothetical. PR #72 fixed a white label failing on the dark
 * `--danger` by moving the label to `--text-inverse` rather than the fill, at
 * six sites. It worked only while `--danger` stayed light in the dark theme;
 * with the 18.09.2026 split it would fail, so this rule exists to stop the
 * earlier shape from being restored out of habit.
 */
const FORBIDDEN_SOLID_LABEL_TOKENS = ['text-inverse'];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Every balanced `{...}` span, skipping strings and comments so braces inside them don't nest. */
function braceSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const open: number[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i); i = n < 0 ? src.length : n + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '{') { open.push(i); i++; continue; }
    if (c === '}') { const s = open.pop(); if (s !== undefined) spans.push([s, i]); i++; continue; }
    i++;
  }
  return spans;
}

/** Top-level `key: value` entries of an object body, ignoring nested objects and strings. */
function topLevelEntries(body: string): Record<string, string> {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const push = (end: number) => { const s = body.slice(start, end).trim(); if (s) parts.push(s); };
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < body.length) {
        if (body[i] === '\\') { i += 2; continue; }
        if (body[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
    else if ((c === ',' || c === ';') && depth === 0) { push(i); start = i + 1; }
    i++;
  }
  push(body.length);

  const entries: Record<string, string> = {};
  for (const part of parts) {
    const m = part.match(/^['"]?([A-Za-z-]+)['"]?\s*:\s*([\s\S]+)$/);
    if (m) entries[m[1]] = m[2];
  }
  return entries;
}

const usesToken = (value: string, tokens: string[]) =>
  tokens.some(token => new RegExp(`var\\(\\s*--${token}\\s*[,)]`).test(value));

/**
 * A background written as a bare name — `background: btnColor` or
 * `background: getConfirmBgColor()` — rather than as a literal.
 *
 * Three of the nine filled `--danger` sites are written this way —
 * `CompaniesPage.tsx:268` (`btnColor`), `TrialBanner.tsx:59` (`fill`) and
 * `ConfirmationModal.tsx:117` (`getConfirmBgColor()`) — and the same three
 * carried three `--warning` fills and one `--success` fill that PR #76 left
 * standing, because it read literals only. A scanner that stops at the literal
 * reports "no offences" while the defect is one line up.
 *
 * Deliberately narrow: a bare identifier or a zero-argument call, nothing else.
 * `bg ?? \`${color}18\`` and `s.color` are a tint and a member expression, not a
 * status fill, and admitting them turned the scan into noise.
 */
const INDIRECT_BACKGROUND = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\(\))?$/;

/**
 * Every `const|let|var <name> = …` initializer in a file, to its terminating
 * `;`, brackets and strings respected — so a ternary and an arrow function body
 * both come back whole.
 *
 * It resolves by name across the whole file, not by scope, so two `const color`
 * in two components are read as one. That errs towards refusing, which for a
 * guard is the safe direction; there is no such collision in the codebase today
 * and the self-check below would surface one as a spurious offence.
 */
function initializersOf(src: string, name: string): string[] {
  const out: string[] = [];
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=;]*)?=`, 'g');
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src))) {
    let i = m.index + m[0].length;
    const from = i;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
      if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i); i = n < 0 ? src.length : n + 2; continue; }
      if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        i++;
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === quote) { i++; break; }
          i++;
        }
        continue;
      }
      if ('{(['.includes(c)) depth++;
      else if ('})]'.includes(c)) { if (depth === 0) break; depth--; }
      else if (c === ';' && depth === 0) break;
      i++;
    }
    out.push(src.slice(from, i));
  }
  return out;
}

/** What a background expression resolves to: itself, or the initializers behind its name. */
function backgroundValues(src: string, expression: string): string[] {
  const name = expression.trim().match(INDIRECT_BACKGROUND)?.[1];
  return name ? [expression, ...initializersOf(src, name)] : [expression];
}

function findBadPairs(): string[] {
  const offences: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const [start, end] of braceSpans(src)) {
      const body = src.slice(start + 1, end);
      if (body.length > 2500) continue;
      const entries = topLevelEntries(body);
      const backgroundKey = BACKGROUND_KEYS.find(key => entries[key]);
      if (!backgroundKey || !entries.color) continue;
      if (!usesToken(entries[backgroundKey], FILLED_BACKGROUND_TOKENS)) continue;
      if (!usesToken(entries.color, FORBIDDEN_LABEL_TOKENS)) continue;
      const line = src.slice(0, start).split('\n').length;
      offences.push(`${file.slice(SRC.length).replace(/\\/g, '/')}:${line}`);
    }
  }
  return offences.sort();
}

/** Every place a status TEXT token is used as a filled background. */
function findStatusFills(): string[] {
  const offences: string[] = [];
  const imperative = new RegExp(
    `style\\.background(?:Color)?\\s*=\\s*['"\`]\\s*var\\(\\s*--(?:${STATUS_TEXT_TOKENS.join('|')})\\s*[,)]`,
  );
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    const rel = file.slice(SRC.length).replace(/\\/g, '/');
    for (const [start, end] of braceSpans(src)) {
      const body = src.slice(start + 1, end);
      if (body.length > 2500) continue;
      const entries = topLevelEntries(body);
      const backgroundKey = BACKGROUND_KEYS.find(key => entries[key]);
      if (!backgroundKey) continue;
      const values = backgroundValues(src, entries[backgroundKey]);
      if (!values.some(value => usesToken(value, STATUS_TEXT_TOKENS))) continue;
      offences.push(`${rel}:${src.slice(0, start).split('\n').length}`);
    }
    // A hover handler assigning the fill imperatively is the same defect, and no
    // style object holds it — SalaryDetailsModal.tsx:906 was exactly that.
    src.split('\n').forEach((text, i) => {
      if (imperative.test(text)) offences.push(`${rel}:${i + 1}`);
    });
  }
  return [...new Set(offences)].sort();
}

/** Every `-solid` fill whose label is `--text-inverse` rather than white. */
function findSolidFillsWithInverseLabel(): string[] {
  const offences: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    const rel = file.slice(SRC.length).replace(/\\/g, '/');
    for (const [start, end] of braceSpans(src)) {
      const body = src.slice(start + 1, end);
      if (body.length > 2500) continue;
      const entries = topLevelEntries(body);
      const backgroundKey = BACKGROUND_KEYS.find(key => entries[key]);
      if (!backgroundKey || !entries.color) continue;
      const values = backgroundValues(src, entries[backgroundKey]);
      if (!values.some(value => usesToken(value, SOLID_FILL_TOKENS))) continue;
      if (!usesToken(entries.color, FORBIDDEN_SOLID_LABEL_TOKENS)) continue;
      offences.push(`${rel}:${src.slice(0, start).split('\n').length}`);
    }
  }
  return [...new Set(offences)].sort();
}

/** Backgrounds that reach a `-solid` token only through a name. */
function indirectSolidFills(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    const rel = file.slice(SRC.length).replace(/\\/g, '/');
    for (const [start, end] of braceSpans(src)) {
      const body = src.slice(start + 1, end);
      if (body.length > 2500) continue;
      const entries = topLevelEntries(body);
      const backgroundKey = BACKGROUND_KEYS.find(key => entries[key]);
      if (!backgroundKey) continue;
      const expression = entries[backgroundKey];
      if (!INDIRECT_BACKGROUND.test(expression.trim())) continue;
      if (usesToken(expression, SOLID_FILL_TOKENS)) continue;
      if (!backgroundValues(src, expression).some(value => usesToken(value, SOLID_FILL_TOKENS))) continue;
      found.push(`${rel}:${src.slice(0, start).split('\n').length}`);
    }
  }
  return [...new Set(found)].sort();
}

describe('accent label pairing', () => {
  it('finds the style objects it is meant to read', () => {
    // Guards the scanner itself: if the parser silently stopped matching style
    // objects, findBadPairs() would return [] and the rule above would pass
    // while checking nothing.
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    const anyAccentButton = files.some(f => /background:\s*'var\(--accent\)'/.test(readFileSync(f, 'utf8')));
    expect(anyAccentButton).toBe(true);
  });

  it('never paints a label with --accent-text on an --accent background', () => {
    expect(findBadPairs()).toEqual([]);
  });
});

describe('status fill tokens', () => {
  it('finds the style objects it is meant to read', () => {
    // Same self-check as above: a parser that stopped matching would report no
    // offences and the rule below would pass while checking nothing.
    const anySolidFill = sourceFiles(SRC).some(f =>
      /background:\s*'var\(--(success|warning|danger)-solid\)'/.test(readFileSync(f, 'utf8')));
    expect(anySolidFill).toBe(true);
  });

  it('resolves a ternary and an arrow body behind a name', () => {
    // The parser itself, on a fixture rather than on production code, so the
    // check cannot drift when a screen is rewritten. Both shapes occur: a
    // ternary ending at its `;`, and an arrow body whose inner `;` must not end
    // the initializer early — ConfirmationModal's switch reaches --danger-solid
    // only in its third case.
    const fixture = [
      "const btnColor = bad ? 'var(--warning-solid)' : 'var(--danger-solid)';",
      "const pick = () => { switch (t) {",
      "  case 'a': return 'var(--accent)';",
      "  case 'b': return 'var(--danger-solid)';",
      "} };",
    ].join('\n');
    expect(initializersOf(fixture, 'btnColor')).toHaveLength(1);
    expect(usesToken(initializersOf(fixture, 'btnColor')[0], ['danger-solid'])).toBe(true);
    expect(usesToken(initializersOf(fixture, 'pick')[0], ['danger-solid'])).toBe(true);
  });

  it('is still wired into the scan of the real source', () => {
    // A parser that works on a fixture but is no longer reached by
    // findStatusFills() would leave the three sites that hid from PR #76
    // unguarded — CompaniesPage.tsx:268, TrialBanner.tsx:59,
    // ConfirmationModal.tsx:117 — and the rule below would still report [].
    expect(indirectSolidFills().length).toBeGreaterThan(0);
  });

  it('fills with the -solid token, never with the status text token', () => {
    expect(findStatusFills()).toEqual([]);
  });

  it('labels a -solid fill with white, never with --text-inverse', () => {
    expect(findSolidFillsWithInverseLabel()).toEqual([]);
  });
});
