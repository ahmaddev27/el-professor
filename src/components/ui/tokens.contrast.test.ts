import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 2.1 contrast for the design-system tokens in src/index.css.
 *
 * Text pairs need 4.5:1 (AA, normal-size text). Non-text pairs need 3:1 (SC
 * 1.4.11): input borders, the focus outline, chart marks. The pairs are the
 * ones the components actually render, not every combination.
 *
 * Since the design remake (27.11.2026) most surfaces are TRANSLUCENT glass, so
 * a token's own value is not what a reader sees. `rendered()` builds what is
 * actually under a pair — the canvas, the canvas under each ambient glow at its
 * peak, the content sheet over those, a card over all of them, a dialog over
 * the scrim over all of those — and a pair must pass on EVERY one of them: the
 * ratio is the worst case, not an average. A translucent foreground (a line, a
 * border) is composited onto each before it is measured.
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

/**
 * A token is RGB channels, and a translucent one has its alpha in a sibling
 * `--<name>-a` (tailwind.config.js multiplies the two). An opaque token comes
 * back as three channels, a translucent one as four.
 */
function parseTokens(theme: Theme): Record<string, Rgb | Rgba> {
  const body = blockAfter(`/* @tokens ${theme} */`);
  const tokens: Record<string, Rgb | Rgba> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/g)) {
    tokens[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])];
  }
  for (const match of body.matchAll(/--([a-z0-9-]+)-a:\s*([\d.]+)\s*;/g)) {
    const colour = tokens[match[1]];
    if (!colour) throw new Error(`--${match[1]}-a has no --${match[1]} beside it`);
    tokens[match[1]] = [colour[0], colour[1], colour[2], Number(match[2])] as Rgba;
  }
  return tokens;
}

/** The two stops of a gradient token, written as hex in the same block. */
function gradientStops(theme: Theme, name: string): Rgb[] {
  const line = new RegExp(`--${name}:\\s*linear-gradient\\(([^;]+)\\);`).exec(blockAfter(`/* @tokens ${theme} */`));
  if (!line) throw new Error(`the ${theme} block has no --${name}`);
  return [...line[1].matchAll(/#([0-9a-fA-F]{6})/g)].map(m => [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) as Rgb);
}

/**
 * Every colour a surface token can render as, worst cases included. Opaque
 * tokens render as themselves. The layering is the shells' (PLAN.md §2): the
 * page is the canvas with the glow over it; the sidebar and the content sheet
 * sit on the page; cards sit on the page (the signed-out screens) or on the
 * sheet; a dialog sits on the scrim over any of those; an inset fill (sunken)
 * and a field sit inside a pane; the table header's wash sits on a card.
 */
function rendered(tokens: Record<string, Rgb | Rgba>): (name: string) => Rgb[] {
  const canvas = tokens.canvas as Rgb;
  const over = (layer: string, under: Rgb[]) => under.map(surface => flatten(tokens[layer], surface));
  const pages = [canvas, ...['amb-1', 'amb-2', 'amb-3', 'amb-4'].map(glow => flatten(tokens[glow], canvas))];
  const sheets = over('sheet', pages);
  const raised = over('raised', [...pages, ...sheets]);
  const dialogs = over('overlay', over('scrim', [...pages, ...sheets, ...raised]));
  const stacks: Record<string, Rgb[]> = {
    canvas: pages,
    sheet: sheets,
    raised,
    overlay: dialogs,
    sunken: over('sunken', [...sheets, ...raised, ...dialogs]),
    field: over('field', [...pages, ...sheets, ...raised, ...dialogs]),
    wash: over('wash', raised),
    toast: over('toast', [...pages, ...sheets, ...raised]),
  };
  return name => {
    if (stacks[name]) return stacks[name];
    const colour = tokens[name];
    if (colour.length === 4) throw new Error(`--${name} is translucent and has no layering in rendered()`);
    return [colour];
  };
}

/** The worst ratio of `fg` over every colour `bg` renders as. */
function worst(tokens: Record<string, Rgb | Rgba>, fg: string, bg: string): number {
  return Math.min(...rendered(tokens)(bg).map(surface => contrast(flatten(tokens[fg], surface), surface)));
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
const SURFACES = ['canvas', 'sheet', 'raised', 'overlay', 'sunken', 'field', 'wash', 'solid'];

const PAIRS: Array<{ fg: string; bg: string; min: number }> = [
  ...['fg', 'fg-muted', 'fg-subtle'].flatMap(fg => SURFACES.map(bg => ({ fg, bg, min: TEXT }))),
  ...['canvas', 'sheet', 'raised', 'overlay', 'solid', 'brand-soft'].map(bg => ({ fg: 'brand-text', bg, min: TEXT })),
  { fg: 'brand-fg', bg: 'brand', min: TEXT },
  { fg: 'brand-fg', bg: 'brand-hover', min: TEXT },
  // Since the remake the dark brand label is dark green, so the destructive
  // fill carries its own white label token rather than borrowing brand-fg.
  { fg: 'critical-fg', bg: 'critical-solid', min: TEXT },
  ...['positive', 'caution', 'critical'].flatMap(fg => [
    { fg, bg: 'canvas', min: TEXT },
    { fg, bg: 'raised', min: TEXT },
    { fg, bg: 'overlay', min: TEXT },
    { fg, bg: `${fg}-soft`, min: TEXT },
  ]),
  ...['canvas', 'sheet', 'raised', 'overlay', 'field'].flatMap(bg => [
    { fg: 'line-strong', bg, min: NON_TEXT },
    { fg: 'focus', bg, min: NON_TEXT },
    { fg: 'brand', bg, min: NON_TEXT },
    { fg: 'signal', bg, min: NON_TEXT },
  ]),
  // Phase 5, batch 1. Alert sets its title in the tone's colour (covered above)
  // and its body in fg-muted, with the odd emphasis in fg; the car form marks a
  // chosen driver's row brand-soft under fg text. So both text tokens sit on
  // every soft fill.
  // The remake (27.11.2026) gives the neutral Alert the neutral tone's own soft fill.
  ...['brand-soft', 'positive-soft', 'caution-soft', 'critical-soft', 'neutral-soft'].flatMap(bg => [
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
  // The remake (27.11.2026): a table's header row and totals row are the wash,
  // so a signed amount in the totals row, and the header's fg-subtle, sit on it.
  ...['positive', 'critical', 'caution', 'brand-text', 'fg-subtle'].map(fg => ({ fg, bg: 'wash', min: TEXT })),
  // Phase 5, batch 1b renders batch 2's three sunken pairs too: the Beleg
  // form's OCR candidates (the chosen value positive, a rejected one critical)
  // and its idle drop zone (brand-text). New here: a field the OCR read with low
  // confidence is framed caution beside a "Bitte prüfen" badge, and an Umsätze
  // amount that will be saved is framed positive — a border that carries a
  // state, on the field's own fill.
  { fg: 'caution', bg: 'field', min: NON_TEXT },
  { fg: 'positive', bg: 'field', min: NON_TEXT },
  // Phase 5, the frame. The support session's reason is the first field outside
  // `Input` to frame itself critical when it is refused, which is the primitive's
  // own `aria-[invalid=true]:border-critical` — the third state of that border.
  { fg: 'critical', bg: 'field', min: NON_TEXT },
  // Phase 5, batch 4. The chosen tier's card is brand-soft, under fg and
  // fg-muted text (above) and a brand border and check. Its price unit was
  // fg-subtle first, which this list caught at 4.38:1 in dark; it is fg-muted.
  // The price box and the activation code's countdown row are sunken, and carry
  // the discounts in positive and the countdown in positive, caution or
  // critical as it runs out: batches 2 and 3's three sunken pairs above.
  { fg: 'brand', bg: 'brand-soft', min: NON_TEXT },
  // The design remake (27.11.2026). The status colours read on the content
  // sheet as well as on a card; the four tones the remake adds (a badge or a
  // callout: the tone's text on the tone's soft fill, or on any pane) read like
  // the first three; the toast is its own dark pane in both themes. The tones'
  // `-dot` colours are not here on purpose: a dot always sits beside the word it
  // marks, so it carries no information of its own (SC 1.4.11 exempts it).
  ...['positive', 'caution', 'critical'].map(fg => ({ fg, bg: 'sheet', min: TEXT })),
  ...['info', 'violet', 'teal', 'neutral'].flatMap(fg => [
    { fg, bg: 'canvas', min: TEXT },
    { fg, bg: 'sheet', min: TEXT },
    { fg, bg: 'raised', min: TEXT },
    { fg, bg: 'overlay', min: TEXT },
    { fg, bg: `${fg}-soft`, min: TEXT },
  ]),
  { fg: 'toast-fg', bg: 'toast', min: TEXT },
  // R1 (the Overview's charts). A series line, bar or slice carries meaning on
  // its own, apart from its legend, so unlike a tone's dot it needs 3:1
  // (SC 1.4.11) on every pane a chart is drawn on.
  ...['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'].flatMap(fg =>
    ['canvas', 'sheet', 'raised', 'overlay'].map(bg => ({ fg, bg, min: NON_TEXT })),
  ),
];

/*
 * `ON_LEGACY_SURFACE` (Phase-2 foregrounds on the legacy card `--bg-surface`)
 * was removed with the remake's R3, 27.11.2026: it existed for batch 4's
 * one-time-code block inside Mein Konto, the last screen in the company frame
 * that painted its own legacy card. Mein Konto draws glass panes on tokens now,
 * and every other screen that renders the block (signup, forgot password,
 * verify email, the invitation) was already on the design system.
 */

/*
 * `ON_LEGACY_PAGE` (Phase-2 foregrounds on the legacy page background
 * `--bg-base`) was removed with the design remake, 27.11.2026: AdminLayout was
 * the last frame that painted `--bg-base`, it paints nothing now, and nothing in
 * `src/` reads that variable. The platform screens' design-system controls sit
 * on the canvas and the sheet, which the PAIRS below measure over the glow.
 */

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

/**
 * Two colours no token owns, on screens batch 4 moved and in both themes.
 *
 * The staging banner is the same orange bar in light and dark: its white label
 * must read on it. The Google button keeps Google's own colours, which its
 * branding guidelines fix — the light button (#FFFFFF, border #747775, text
 * #1F1F1F) and the dark one (#131314, #8E918F, #E3E3E3): each label must read on
 * its fill, and each border must stand out from the page it sits on.
 *
 * Both read the colours from the component's source, so changing one there
 * without looking here fails.
 */
describe('fixed colours on the signed-out screens', () => {
  const hex = (value: string): Rgb => [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16)) as Rgb;
  const banner = readFileSync(new URL('../EnvironmentBanner.tsx', import.meta.url), 'utf8');
  const google = readFileSync(new URL('../auth/GoogleButton.tsx', import.meta.url), 'utf8');

  it('the staging banner\'s white label reaches 4.5:1 on its orange', () => {
    const fill = /background:\s*'#([0-9a-fA-F]{6})'/.exec(banner)?.[1];
    const label = /color:\s*'#([0-9a-fA-F]{6})'/.exec(banner)?.[1];
    expect(fill).toBeDefined();
    expect(label).toBeDefined();
    expect(contrast(hex(label!), hex(fill!))).toBeGreaterThanOrEqual(TEXT);
  });

  it.each([
    { theme: 'light' as Theme, prefix: '', fill: 'FFFFFF', border: '747775', label: '1F1F1F' },
    { theme: 'dark' as Theme, prefix: 'dark:', fill: '131314', border: '8E918F', label: 'E3E3E3' },
  ])('the $theme Google button: its label on its fill, its border on the page', ({ theme, prefix, fill, border, label }) => {
    expect(google).toContain(`${prefix}bg-[#${fill}]`);
    expect(google).toContain(`${prefix}border-[#${border}]`);
    expect(google).toContain(`${prefix}text-[#${label}]`);
    expect(contrast(hex(label), hex(fill))).toBeGreaterThanOrEqual(TEXT);
    for (const surface of [...rendered(parseTokens(theme))('canvas'), ...rendered(parseTokens(theme))('raised')]) {
      expect(contrast(hex(border), surface)).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });
});

describe.each<Theme>(['light', 'dark'])('%s theme tokens', theme => {
  const tokens = parseTokens(theme);

  it('defines every token the pairs refer to', () => {
    const missing = PAIRS.flatMap(({ fg, bg }) => [fg, bg]).filter(name => !tokens[name]);
    expect([...new Set(missing)]).toEqual([]);
  });

  it.each(PAIRS)('$fg on $bg reaches $min:1', ({ fg, bg, min }) => {
    const ratio = worst(tokens, fg, bg);
    if (process.env.PRINT_CONTRAST) {
      console.log(`${theme}\t${fg}\t${bg}\t${ratio.toFixed(2)}\t${min}`);
    }
    expect(ratio).toBeGreaterThanOrEqual(min);
  });
});

/**
 * The primary button is a gradient since the remake, so its label has to read
 * on both stops, at rest and on hover. The stops are hex in the token blocks;
 * the spec's light top stop (#0B9068) was 4.04:1 under white and is darkened.
 */
describe.each<Theme>(['light', 'dark'])('%s primary button gradient', theme => {
  const label = parseTokens(theme)['brand-fg'] as Rgb;
  it.each(['brand-gradient', 'brand-gradient-hover'])('brand-fg reads on both stops of --%s', name => {
    const stops = gradientStops(theme, name);
    expect(stops).toHaveLength(2);
    for (const stop of stops) expect(contrast(label, stop)).toBeGreaterThanOrEqual(TEXT);
  });
});
