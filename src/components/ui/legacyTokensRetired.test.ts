import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The legacy theme tokens were retired with the remake's R6 (27.11.2026).
 *
 * Every screen built before Phase 2 painted itself from `--bg-*`, `--text-*`,
 * `--border*`, `--accent*`, `--success*`, `--warning*` and `--danger*`. The last
 * readers moved to the design system's tokens, and `src/index.css` no longer
 * defines any of them. A `var(--accent)` written today would resolve to nothing
 * and the browser would draw it in the inherited colour, or not at all, with no
 * error anywhere. So this file fails instead: a legacy variable is either
 * defined again in `index.css` or read anywhere under `src/`.
 *
 * It replaces `accentLabel.contrast.test.ts`, which paired those tokens' fills
 * with their labels. With the tokens gone there is nothing left to pair.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = join(SRC, '..');
const THIS_FILE = fileURLToPath(import.meta.url);

export const RETIRED_TOKENS = [
  'bg-base', 'bg-surface', 'bg-elevated', 'bg-subtle', 'bg-muted',
  'border', 'border-subtle',
  'text-primary', 'text-secondary', 'text-tertiary', 'text-inverse',
  'accent', 'accent-hover', 'accent-subtle', 'accent-text',
  'success', 'success-solid', 'success-subtle',
  'warning', 'warning-solid', 'warning-subtle',
  'danger', 'danger-solid', 'danger-subtle',
  'shadow-sm', 'shadow-md', 'shadow-lg',
];

const names = RETIRED_TOKENS.map(name => name.replace(/-/g, '\\-')).join('|');
// The name must end there: `--border` must not match `--border-strong`.
const READ = new RegExp(`var\\(\\s*--(?:${names})(?![\\w-])`, 'g');
const DEFINE = new RegExp(`^\\s*--(?:${names})\\s*:`, 'gm');

/** Every line of `src` that reads a retired token. */
export function retiredReads(src: string): string[] {
  return src.split('\n').filter(line => READ.test(line) && ((READ.lastIndex = 0), true));
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, acc);
    else if (/\.(tsx?|css|html)$/.test(entry) && path !== THIS_FILE) acc.push(path);
  }
  return acc;
}

describe('legacy theme tokens are retired', () => {
  it('finds a read in every spelling a screen used', () => {
    // Negative control: if the pattern stopped matching, the scan below would
    // pass on any source.
    const fixture = [
      "style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}",
      'className="border border-[var(--border)] bg-[var(--bg-subtle)]"',
      'onMouseLeave={e => (e.currentTarget.style.background = "var(--danger-solid)")}',
      '  box-shadow: var(--shadow-md);',
      "const ok = 'rgb(var(--line-strong) / 0.5)';",
      "const alsoOk = 'var(--border-strong)';",
    ].join('\n');
    expect(retiredReads(fixture)).toHaveLength(4);
  });

  it('index.css defines none of them', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    expect(css).not.toContain('@legacy-tokens');
    expect(css.match(DEFINE) ?? []).toEqual([]);
  });

  it('nothing under src/ reads one', () => {
    const files = [...sourceFiles(SRC), join(ROOT, 'index.html')];
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap(file =>
      retiredReads(readFileSync(file, 'utf8')).map(line => `${relative(ROOT, file)}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
