/**
 * The landing page's twelve feature cards must render in their own colours.
 *
 * `FeatureCard` declared `accentColor` and the twelve card literals below it all
 * pass `accent`, spread with `{...f}`. So `accentColor` was `undefined` in every
 * one of them and the component built its strings out of it:
 *
 *   background:   `${accentColor}18`            ->  'undefined18'
 *   border:       `1px solid ${accentColor}30`  ->  '1px solid undefined30'
 *   hover border: `${accentColor}33`            ->  'undefined33'
 *   color:        accentColor                   ->  undefined, the icon inherited
 *
 * An invalid CSS colour is dropped by the browser, so the twelve icon tiles lost
 * their tint and their border silently — on the product's own front page, on
 * every visit, signed in or not.
 *
 * `tsc` does catch this (the spread supplies no `accentColor` and an excess
 * `accent`). It shipped because the typecheck ratchet's baseline carries 376
 * pre-existing errors, so one more was invisible. Clearing it lowers the
 * baseline by one, which is what stops it coming back — this file is the second
 * wall, and the one that says *why* when it fails.
 *
 * **It is a source test because the page cannot be rendered here**:
 * `vitest.config.ts` sets `environment: 'node'` and the project has no jsdom and
 * no testing-library.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PAGE = fileURLToPath(new URL('../pages/LandingPage.tsx', import.meta.url));
const source = readFileSync(PAGE, 'utf8');

/**
 * A key of an inline object literal: an identifier that follows `{` or `,` and is
 * followed by `:`.
 *
 * Narrow on purpose. It does not match a JSX attribute (`size={18}` has no
 * colon) or a string argument (`t('landing.feature.revenue.title')` has no colon
 * either), which is everything else the twelve lines contain. A card that grows
 * a nested object would over-match and fail here — which is the right way round:
 * a human then reads the line.
 */
const OBJECT_KEY = /[{,]\s*([A-Za-z_]\w*)\s*:/g;

/** The prop names `FeatureCard` declares, read from its type literal. */
function declaredProps(): string[] {
  const marker = 'const FeatureCard: React.FC<';
  const start = source.indexOf(marker);
  expect(start, 'FeatureCard is not declared in LandingPage.tsx').toBeGreaterThan(-1);
  const open = source.indexOf('{', start + marker.length - 1);
  const close = source.indexOf('}>', open);
  expect(close, "FeatureCard's prop type does not close").toBeGreaterThan(open);

  return source
    .slice(open + 1, close)
    .split(';')
    .map(part => part.split(':')[0].trim())
    .filter(name => name.length > 0);
}

/** The twelve card literals, as the text of the array passed to `.map`. */
function cardArray(): string {
  const anchor = source.indexOf('<FeatureCard key={i} {...f} />');
  expect(anchor, 'the feature-card map is not where this test expects it').toBeGreaterThan(-1);

  // The array is the `[ … ].map(…)` immediately above the tag.
  const mapCall = source.lastIndexOf('].map(', anchor);
  const open = source.lastIndexOf('{[', mapCall);
  expect(open, 'the feature-card array was not found above the map').toBeGreaterThan(-1);
  return source.slice(open + 2, mapCall);
}

describe('LandingPage — every feature card is passed the props the card declares', () => {
  it('declares exactly the four props the literals carry', () => {
    // A fifth prop has to be added to the twelve literals too, or the assertion
    // below catches it.
    expect(declaredProps().sort()).toEqual(['accent', 'desc', 'icon', 'title']);
  });

  it('spreads twelve literals, each naming the same keys as the component', () => {
    const props = new Set(declaredProps());
    const lines = cardArray()
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('{'));

    // Twelve cards, measured. A thirteenth is welcome and an eleventh means one
    // was lost, so the count is a floor rather than a pin.
    expect(lines.length).toBeGreaterThanOrEqual(12);

    for (const line of lines) {
      const keys = [...line.matchAll(OBJECT_KEY)].map(match => match[1]);
      expect(keys.length, `no object keys found in ${line}`).toBeGreaterThan(0);

      for (const key of keys) {
        // The assertion that failed before: the cards passed `accent` while the
        // component declared `accentColor`, so each one handed over a prop that
        // was never read and withheld the one that was.
        expect(props.has(key), `card passes '${key}', which FeatureCard does not declare: ${line}`).toBe(true);
      }

      // And every declared prop is actually supplied — the other half, because a
      // missing one is `undefined` inside a template literal, not an error.
      for (const prop of props) {
        expect(keys, `card does not pass '${prop}': ${line}`).toContain(prop);
      }
    }
  });

  it('never builds a colour out of a prop name no card passes', () => {
    // NEGATIVE CONTROL for the exact defect. `accentColor` survives in this file
    // only as the CSS property of the pricing slider's range input
    // (`style={{ width: 140, accentColor: '#06b6d4' }}`) — a real CSS key that
    // must stay. What must not come back is the *prop*.
    expect(source).not.toContain('accentColor: string');
    expect(source).not.toMatch(/\$\{accentColor\}/);
    expect(source).not.toMatch(/color:\s*accentColor\s*,/);

    // The slider's CSS property is still there, so this is not passing by having
    // deleted the wrong thing.
    expect(source).toContain("accentColor: '#06b6d4'");
  });
});
