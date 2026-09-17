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

function parseTokens(theme: Theme): Record<string, Rgb> {
  const marker = `/* @tokens ${theme} */`;
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`index.css has no "${marker}" block`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const tokens: Record<string, Rgb> = {};
  for (const match of css.slice(open + 1, close).matchAll(/--([a-z-]+):\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/g)) {
    tokens[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])];
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
