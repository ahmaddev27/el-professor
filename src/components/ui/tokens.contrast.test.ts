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
/** A legacy token may be translucent; the fourth channel is its alpha. */
type Rgba = [number, number, number, number];
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
 *
 * The dark block also spells the `-subtle` fills as `rgba(…)`. Those are
 * translucent, so their rendered colour depends on the surface underneath;
 * `flatten()` below composites one over a given surface before measuring.
 */
function parseLegacyTokens(theme: Theme): Record<string, Rgb | Rgba> {
  const tokens: Record<string, Rgb | Rgba> = {};
  const body = blockAfter(`/* @legacy-tokens ${theme} */`);
  for (const match of body.matchAll(/--([a-z-]+):\s*#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\s*;/g)) {
    const hex = match[2].length === 3 ? match[2].split('').map(c => c + c).join('') : match[2];
    tokens[match[1]] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
  }
  for (const match of body.matchAll(/--([a-z-]+):\s*rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([\d.]+)\s*\)\s*;/g)) {
    tokens[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])] as Rgba;
  }
  return tokens;
}

/** The colour a (possibly translucent) token actually renders as over `surface`. */
function flatten(colour: Rgb | Rgba, surface: Rgb): Rgb {
  if (colour.length === 3) return colour;
  const [r, g, b, a] = colour;
  return [r, g, b].map((c, i) => Math.round(c * a + surface[i] * (1 - a))) as Rgb;
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
  // Phase 5, batch 1. Alert sets its title in the tone's colour (covered above)
  // and its body in fg-muted, with the odd emphasis in fg; the car form marks a
  // chosen driver's row brand-soft under fg text. So both text tokens sit on
  // every soft fill.
  ...['brand-soft', 'positive-soft', 'caution-soft', 'critical-soft'].flatMap(bg => [
    { fg: 'fg', bg, min: TEXT },
    { fg: 'fg-muted', bg, min: TEXT },
  ]),
  // A row's delete icon turns critical on the ghost button's hover fill.
  { fg: 'critical', bg: 'sunken', min: NON_TEXT },
  // Phase 5, batch 2. An amount keeps its sign's colour — paid, Bar zurück,
  // a Beleg — in a table row whose hover fill and totals row are sunken, and
  // the Gehälter screen marks a manually adjusted salary in brand-text there.
  // (Measured on full sunken: the hover is sunken at half strength over
  // raised, so it lies between two measured pairs.)
  ...['positive', 'critical', 'brand-text'].map(fg => ({ fg, bg: 'sunken', min: TEXT })),
  // Phase 5, batch 3. The same fill under a run's exception note on a row's hover.
  // Its other two words on sunken — "Alle löschen" / "Plan endgültig löschen"
  // in critical, a reassigned driver in brand-text — are batch 2's pairs above.
  { fg: 'caution', bg: 'sunken', min: TEXT },
];

/**
 * Phase 5 moves screens onto the design system one at a time, inside the
 * legacy AppLayout, whose page background is the legacy `--bg-base` and not
 * `--canvas`. Until the shell itself moves, a converted screen's page header,
 * tab labels, notes and focus rings sit on that legacy colour: the Phase-2
 * foreground on a legacy background, a pair neither block above measures.
 */
const ON_LEGACY_PAGE: Array<{ fg: string; min: number }> = [
  { fg: 'fg', min: TEXT },
  { fg: 'fg-muted', min: TEXT },
  { fg: 'fg-subtle', min: TEXT },
  // The Fahrzeuge header's active-vehicle count, once the plan's limit is reached.
  { fg: 'critical', min: TEXT },
  // The active tab's underline and every control's focus ring.
  { fg: 'brand', min: NON_TEXT },
  { fg: 'focus', min: NON_TEXT },
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
 * `--success` and `--warning` used to be absent here, because at their old
 * values (#059669 and #d97706) no foreground reached 4.5:1 on them — white was
 * 3.77:1 and 3.19:1. The owner's decision of 17.09.2026 darkened them, and the
 * split that came with it is the second rule this block pins; see SOLID_PAIRS.
 *
 * `--danger` followed on 18.09.2026, and note what left this block with it:
 * `{ fg: 'text-inverse', bg: 'danger' }`. That pair was PR #72's answer to a
 * white label failing on the dark `--danger` — it moved the label to
 * `--text-inverse` instead of moving the fill. With `--danger-solid` there is
 * now a fill built for a white label, all six of those call sites name it, and
 * nothing in the codebase pairs `--text-inverse` with `--danger` any more. An
 * assertion about a combination no screen renders is worse than no assertion:
 * it reads as coverage. The rule that replaced it is in
 * accentLabel.contrast.test.ts, which refuses `--text-inverse` ON a `-solid`
 * fill — in the dark theme that is #111827 on #D63A40, 3.83:1.
 */
const LEGACY_PAIRS: Array<{ fg: string; bg: string; min: number }> = [
  { fg: 'text-inverse', bg: 'accent', min: TEXT },
  { fg: 'text-inverse', bg: 'accent-hover', min: TEXT },
  // accent-coloured text belongs on a neutral background, and must stay legible there
  ...['bg-base', 'bg-surface', 'bg-elevated', 'bg-subtle'].map(bg => ({ fg: 'accent-text', bg, min: TEXT })),
  // ...and so does status-coloured text, which is what --success / --warning /
  // --danger are everywhere except the filled buttons and badges covered by
  // SOLID_PAIRS. --danger is by far the most used of the three: some 157 `color`
  // sites, and at #ef4444 it reached only 4.21:1 on the dark --bg-elevated.
  ...['bg-base', 'bg-surface', 'bg-elevated', 'bg-subtle'].flatMap(bg => [
    { fg: 'success', bg, min: TEXT },
    { fg: 'warning', bg, min: TEXT },
    { fg: 'danger', bg, min: TEXT },
  ]),
];

/** The pale status fills, which are translucent in the dark theme. */
const SUBTLE_SURFACES = ['bg-base', 'bg-surface', 'bg-elevated', 'bg-subtle'];
const SUBTLE_PAIRS: Array<{ fg: string; fill: string; over: string; min: number }> =
  ['success', 'warning', 'danger'].flatMap(fg =>
    SUBTLE_SURFACES.map(over => ({ fg, fill: `${fg}-subtle`, over, min: TEXT })));

/**
 * The filled-background role, and the reason it has its own token.
 *
 * Every filled `--success` / `--warning` / `--danger` button and count badge in
 * the codebase paints its label literally white — `color: 'white'`, `'#fff'`, or
 * Tailwind's `text-white` in the className — so WHITE, not a token, is what has
 * to reach 4.5:1 on the fill. `--text-inverse` cannot stand in for it: it is
 * #111827 in the dark theme, and on --danger-solid that is 3.83:1.
 *
 * In the dark theme that role and the text role are arithmetically
 * incompatible. A white label needs the fill at relative luminance <= 0.183;
 * reading as text on --bg-surface (#111827) needs the token at >= 0.237, and for
 * --danger the binding surface is its own -subtle fill over --bg-elevated, which
 * pushes the text role to >= 0.274. No value satisfies both, so the fill is a
 * separate token — --success-solid, --warning-solid and --danger-solid, named
 * after --critical-solid in the Phase-2 block. In the light theme both roles
 * want the same darkness and the two tokens hold one value; the split exists
 * only where it is forced.
 *
 * Do not "simplify" this by pointing the call sites back at --success.
 */
const WHITE_LABEL: Rgb = [255, 255, 255];
const SOLID_PAIRS = ['success-solid', 'warning-solid', 'danger-solid'];

describe.each<Theme>(['light', 'dark'])('%s legacy theme tokens', theme => {
  const tokens = parseLegacyTokens(theme);

  it('defines every token the legacy pairs refer to', () => {
    const named = [
      ...LEGACY_PAIRS.flatMap(({ fg, bg }) => [fg, bg]),
      ...SUBTLE_PAIRS.flatMap(({ fg, fill, over }) => [fg, fill, over]),
      ...SOLID_PAIRS,
    ];
    expect([...new Set(named.filter(name => !tokens[name]))]).toEqual([]);
  });

  it.each(LEGACY_PAIRS)('$fg on $bg reaches $min:1', ({ fg, bg, min }) => {
    const ratio = contrast(tokens[fg] as Rgb, tokens[bg] as Rgb);
    if (process.env.PRINT_CONTRAST) {
      console.log(`${theme}\tlegacy\t${fg}\t${bg}\t${ratio.toFixed(2)}\t${min}`);
    }
    expect(ratio).toBeGreaterThanOrEqual(min);
  });

  it.each(SUBTLE_PAIRS)('$fg on $fill over $over reaches $min:1', ({ fg, fill, over, min }) => {
    const ratio = contrast(tokens[fg] as Rgb, flatten(tokens[fill], tokens[over] as Rgb));
    if (process.env.PRINT_CONTRAST) {
      console.log(`${theme}\tlegacy\t${fg}\t${fill}/${over}\t${ratio.toFixed(2)}\t${min}`);
    }
    expect(ratio).toBeGreaterThanOrEqual(min);
  });

  it.each(SOLID_PAIRS)('a white label on --%s reaches 4.5:1', solid => {
    const ratio = contrast(WHITE_LABEL, tokens[solid] as Rgb);
    if (process.env.PRINT_CONTRAST) {
      console.log(`${theme}\tlegacy\twhite\t${solid}\t${ratio.toFixed(2)}\t${TEXT}`);
    }
    expect(ratio).toBeGreaterThanOrEqual(TEXT);
  });

  it.each(SOLID_PAIRS)('--%s stays visible as a shape on the surfaces it sits on', solid => {
    // SC 1.4.11: a filled button has to be discernible from the page and from a
    // modal behind it, not only legible inside itself.
    for (const surface of ['bg-surface', 'bg-elevated']) {
      expect(contrast(tokens[solid] as Rgb, tokens[surface] as Rgb)).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it('--accent-text is NOT usable as a label on --accent', () => {
    // Pins the defect itself: if these two ever became far enough apart to pass,
    // the pairing would still be wrong by intent, but this assertion is what
    // documents why the codebase never pairs them. See accentLabel.contrast.test.ts.
    expect(contrast(tokens['accent-text'] as Rgb, tokens['accent'] as Rgb)).toBeLessThan(TEXT);
  });
});

describe.each<Theme>(['light', 'dark'])('%s Phase-2 tokens on the legacy page background', theme => {
  const tokens = parseTokens(theme);
  const page = parseLegacyTokens(theme)['bg-base'];

  it('finds the legacy page background as an opaque colour', () => {
    expect(page).toHaveLength(3);
  });

  it.each(ON_LEGACY_PAGE)('$fg on --bg-base reaches $min:1', ({ fg, min }) => {
    const ratio = contrast(tokens[fg], page as Rgb);
    if (process.env.PRINT_CONTRAST) {
      console.log(`${theme}\t${fg}\tbg-base (legacy)\t${ratio.toFixed(2)}\t${min}`);
    }
    expect(ratio).toBeGreaterThanOrEqual(min);
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
