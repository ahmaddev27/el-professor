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
