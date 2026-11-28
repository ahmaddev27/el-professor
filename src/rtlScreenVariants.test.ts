import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * An `rtl:` class must not race a screen variant of the same utility.
 *
 * Tailwind 3.4 writes `rtl:x` as `.rtl\:x:where([dir="rtl"], [dir="rtl"] *)`: the
 * `:where()` adds no specificity, so the rule weighs one class, exactly like
 * `.lg\:y` inside its media query, and the later rule wins. Tailwind emits the
 * `rtl:` variant AFTER every screen variant. So a drawer closed with
 * `-translate-x-full rtl:translate-x-full` and opened on a wide screen with
 * `lg:translate-x-0` stayed closed there in Arabic: both shells' sidebars slid
 * out past the right edge on every wide screen (owner's screenshot, 27.11.2026).
 * Measured in the compiled CSS, not reasoned from Tailwind's documentation.
 *
 * The fix is to give the `rtl:` class the same screen limit (`max-lg:rtl:…`),
 * so the two rules never apply at the same width. This test fails a file that
 * carries a bare `rtl:` class and a screen-variant class of the same utility
 * family, which is the shape that bit. It reads whole files, not elements,
 * because the sidebar's two halves sat in different branches of a conditional.
 */

const SRC = fileURLToPath(new URL('./', import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);
const SCREENS = new Set(['sm', 'md', 'lg', 'xl', '2xl']);
const FAMILIES = ['translate-x', 'translate-y', 'scale-x', 'space-x', 'rotate', 'animate', 'tracking', 'inset', 'start', 'end'];

/** The utility family a class token belongs to, or null if it is none of FAMILIES. */
function family(token: string): string | null {
  const utility = token.slice(token.lastIndexOf(':') + 1).replace(/^-/, '');
  return FAMILIES.find(name => utility === name || utility.startsWith(`${name}-`)) ?? null;
}

/** Every conflict in one source text: `rtl:` token and screen token sharing a family. */
export function rtlScreenConflicts(source: string): string[] {
  const tokens = source.match(/[\w:[\]\-/.()%]+/g) ?? [];
  const bareRtl = new Map<string, string>();
  const screened = new Map<string, string>();
  for (const token of tokens) {
    if (!token.includes(':')) continue;
    const variants = token.split(':').slice(0, -1);
    const name = family(token);
    if (!name) continue;
    const hasScreen = variants.some(v => SCREENS.has(v) || /^max-(sm|md|lg|xl|2xl)$/.test(v));
    if (variants.includes('rtl') && !hasScreen) bareRtl.set(name, token);
    else if (hasScreen && !variants.includes('rtl')) screened.set(name, token);
  }
  return [...bareRtl].filter(([name]) => screened.has(name)).map(([name, token]) => `${token} vs ${screened.get(name)}`);
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, acc);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && path !== THIS_FILE) acc.push(path);
  }
  return acc;
}

describe('rtl: classes and screen variants', () => {
  it('finds the shape that hid the sidebar, and passes its fix', () => {
    const before = "'lg:sticky lg:translate-x-0', open ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full'";
    const after = "'lg:sticky lg:translate-x-0', open ? 'translate-x-0' : 'max-lg:-translate-x-full max-lg:rtl:translate-x-full'";
    expect(rtlScreenConflicts(before)).toEqual(['rtl:translate-x-full vs lg:translate-x-0']);
    expect(rtlScreenConflicts(after)).toEqual([]);
    // A different family on the same element is not a race.
    expect(rtlScreenConflicts("'rtl:-scale-x-100 lg:translate-x-0'")).toEqual([]);
  });

  it('no file under src/ carries one', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap(file =>
      rtlScreenConflicts(readFileSync(file, 'utf8')).map(conflict => `${relative(SRC, file)}: ${conflict}`),
    );
    expect(offenders).toEqual([]);
  });
});
