import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 2.1 contrast for the design-system tokens in src/index.css.
 *
 * Text pairs need 4.5:1 (AA, normal-size text). Non-text pairs need 3:1 (SC
 * 1.4.11): input borders, the focus outline, chart marks. The pairs are the
 * ones the components actually render, not every combination.
 *
 * Run with PRINT_CONTRAST=1 to print the full table.
 */

type Rgb = [number, number, number];
type Theme = 'light' | 'dark';

const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

function blockAfter(marker: string): string {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`index.css has no "${marker}" block`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

function parseTokens(theme: Theme): Record<string, Rgb> {
  const tokens: Record<string, Rgb> = {};
  for (const match of blockAfter(`/* @tokens ${theme} */`).matchAll(/--([a-z-]+):\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/g)) {
    tokens[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])];
  }
  return tokens;
}

/**
 * The legacy blocks spell their tokens as hex, not RGB channels. Every screen
 * built before Phase 2 still renders from them, so they need the same guard.
 */
function parseLegacyTokens(theme: Theme): Record<string, Rgb> {
  const tokens: Record<string, Rgb> = {};
  for (const match of blockAfter(`/* @legacy-tokens ${theme} */`).matchAll(/--([a-z-]+):\s*#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\s*;/g)) {
    const hex = match[2].length === 3 ? match[2].split('').map(c => c + c).join('') : match[2];
    tokens[match[1]] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
  }
  return tokens;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const TEXT = 4.5;
const NON_TEXT = 3;
const SURFACES = ['canvas', 'raised', 'overlay', 'sunken', 'field'];

const PAIRS: Array<{ fg: string; bg: string; min: number }> = [
  ...['fg', 'fg-muted', 'fg-subtle'].flatMap(fg => SURFACES.map(bg => ({ fg, bg, min: TEXT }))),
  ...['canvas', 'raised', 'overlay', 'brand-soft'].map(bg => ({ fg: 'brand-text', bg, min: TEXT })),
  { fg: 'brand-fg', bg: 'brand', min: TEXT },
  { fg: 'brand-fg', bg: 'brand-hover', min: TEXT },
  { fg: 'brand-fg', bg: 'critical-solid', min: TEXT },
  ...['positive', 'caution', 'critical'].flatMap(fg => [
    { fg, bg: 'canvas', min: TEXT },
    { fg, bg: 'raised', min: TEXT },
    { fg, bg: 'overlay', min: TEXT },
    { fg, bg: `${fg}-soft`, min: TEXT },
  ]),
  ...['canvas', 'raised', 'overlay'].flatMap(bg => [
    { fg: 'line-strong', bg, min: NON_TEXT },
    { fg: 'focus', bg, min: NON_TEXT },
    { fg: 'brand', bg, min: NON_TEXT },
    { fg: 'signal', bg, min: NON_TEXT },
  ]),
];

/**
 * Legacy on-a-filled-background pairs.
 *
 * `--accent` is the accent BACKGROUND; `--accent-text` is accent-coloured text
 * for a NORMAL background. The names look interchangeable and are not: in the
 * light theme both hold #2563eb, so `color: var(--accent-text)` on
 * `background: var(--accent)` renders the label in the button's own colour and
 * it disappears completely (1.00:1). In the dark theme it is #22d3ee on
 * #06b6d4 — 1.34:1, just legible enough to look like a rendering glitch rather
 * than a bug. A label sitting ON one of these filled backgrounds must use
 * `--text-inverse`, which is what `.btn-primary` in index.css already does.
 *
 * `--success` and `--warning` are deliberately absent: at their current light
 * values no foreground token reaches 4.5:1 on them (white is 3.77:1 and
 * 3.19:1), so listing them here would fail the build rather than guard it.
 * Fixing those needs the token values themselves darkened — a design decision,
 * recorded in HANDOFF.md, not a token swap.
 */
const LEGACY_PAIRS: Array<{ fg: string; bg: string; min: number }> = [
  { fg: 'text-inverse', bg: 'accent', min: TEXT },
  { fg: 'text-inverse', bg: 'accent-hover', min: TEXT },
  { fg: 'text-inverse', bg: 'danger', min: TEXT },
  // accent-coloured text belongs on a neutral background, and must stay legible there
  ...['bg-base', 'bg-surface', 'bg-elevated', 'bg-subtle'].map(bg => ({ fg: 'accent-text', bg, min: TEXT })),
];

describe.each<Theme>(['light', 'dark'])('%s legacy theme tokens', theme => {
  const tokens = parseLegacyTokens(theme);

  it('defines every token the legacy pairs refer to', () => {
    const missing = LEGACY_PAIRS.flatMap(({ fg, bg }) => [fg, bg]).filter(name => !tokens[name]);
    expect([...new Set(missing)]).toEqual([]);
  });

  it.each(LEGACY_PAIRS)('$fg on $bg reaches $min:1', ({ fg, bg, min }) => {
    const ratio = contrast(tokens[fg], tokens[bg]);
    if (process.env.PRINT_CONTRAST) {
      console.log(`${theme}\tlegacy\t${fg}\t${bg}\t${ratio.toFixed(2)}\t${min}`);
    }
    expect(ratio).toBeGreaterThanOrEqual(min);
  });

  it('--accent-text is NOT usable as a label on --accent', () => {
    // Pins the defect itself: if these two ever became far enough apart to pass,
    // the pairing would still be wrong by intent, but this assertion is what
    // documents why the codebase never pairs them. See accentLabel.contrast.test.ts.
    expect(contrast(tokens['accent-text'], tokens['accent'])).toBeLessThan(TEXT);
  });
});

describe.each<Theme>(['light', 'dark'])('%s theme tokens', theme => {
  const tokens = parseTokens(theme);

  it('defines every token the pairs refer to', () => {
    const missing = PAIRS.flatMap(({ fg, bg }) => [fg, bg]).filter(name => !tokens[name]);
    expect([...new Set(missing)]).toEqual([]);
  });

  it.each(PAIRS)('$fg on $bg reaches $min:1', ({ fg, bg, min }) => {
    const ratio = contrast(tokens[fg], tokens[bg]);
    if (process.env.PRINT_CONTRAST) {
      console.log(`${theme}\t${fg}\t${bg}\t${ratio.toFixed(2)}\t${min}`);
    }
    expect(ratio).toBeGreaterThanOrEqual(min);
  });
});
