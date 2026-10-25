import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest.config.ts aliases `date-fns` to tests/support/date-fns-shim.ts and
// `date-fns/locale` to date-fns-locale-shim.ts, so the test run loads the 20
// functions and the one locale the product uses instead of both barrels. A name
// src/ starts using that a shim does not re-export would be `undefined` in tests
// only — the production bundle imports the real barrel and would be fine, which
// is exactly the kind of divergence that is worth a gate.
//
// Two things are asserted here, and the second is the one that makes the alias
// safe rather than merely fast:
//
//   1. every name src/ imports from either barrel is re-exported by its shim;
//   2. what the shim hands a test is the *same function object* as the barrel's,
//      so a test and the shipped bundle cannot be running different code.
//
// (2) imports the real barrel by absolute file path, which the alias cannot
// match — its two `find` patterns are anchored regexes over bare specifiers.

const root = new URL('../../', import.meta.url);
const fsPath = (url: URL) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
const text = (path: string) => readFileSync(new URL(path, root), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// One walk, read once: the first version of this file walked all 695 files twice
// and cost 9.4 s for two assertions.
const FILES = sources(fsPath(new URL('src', root))).map(file => readFileSync(file, 'utf8'));

function usedNames(from: string): Set<string> {
  // Built with escaped backslashes on purpose. Written as `import\s+` inside a
  // template literal, `\s` is a NonEscapeCharacter and collapses to a bare `s`,
  // giving `imports+(?:types+)?{...}s+froms+'date-fns'` — a pattern that matches
  // no real import line, so every assertion below passed over an empty set. That
  // is how this guard shipped green while guarding nothing.
  const pattern = new RegExp(
    `import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+'${from.replace('/', '\\/')}'`,
    'g',
  );
  const names = new Set<string>();
  for (const source of FILES) {
    for (const match of source.matchAll(pattern)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
        if (name) names.add(name);
      }
    }
  }
  return names;
}

const exported = (shim: string) =>
  new Set([...text(shim).matchAll(/export \{ (\w+) \} from/g)].map(m => m[1]));

describe('the date-fns test shims', () => {
  it('see the imports at all — the regex matches real source', () => {
    // Guards the guard: a pattern that matches nothing makes every other
    // assertion in this file vacuous, and silently.
    expect(usedNames('date-fns').size).toBeGreaterThan(0);
    expect(usedNames('date-fns/locale').size).toBeGreaterThan(0);
  });

  it('re-export every name src/ imports from date-fns', () => {
    const shim = exported('tests/support/date-fns-shim.ts');
    expect([...usedNames('date-fns')].filter(n => !shim.has(n)).sort()).toEqual([]);
  });

  it('re-export every name src/ imports from date-fns/locale', () => {
    const shim = exported('tests/support/date-fns-locale-shim.ts');
    expect([...usedNames('date-fns/locale')].filter(n => !shim.has(n)).sort()).toEqual([]);
  });

  it('hand tests the same function objects as the real barrels', async () => {
    // `date-fns` here is the alias — the shim. The barrels are loaded as
    // `file://` URLs, which no `find` regex in vitest.config.ts matches.
    //
    // A `file://` URL rather than a bare absolute path, and the honest reason is
    // narrower than the one first written here. Both forms work on both
    // platforms — a claim that the bare path would break on Linux was written
    // into this comment and is **withdrawn**: CI ran it green twice. What the URL
    // form buys is speed, and only on Windows:
    //
    //   Windows (dev box)   bare path 12-25 s, once 49 s   file:// 2.0-2.5 s
    //   Linux (CI)          bare path 2433 ms              file:// 2470 ms
    //
    // The whole suite on CI is 130.08 s against 129.88 s, so on Linux this is a
    // no-op. The mechanism of the Windows asymmetry is **not established** — see
    // the shim's header for why no further guess belongs here.
    const shim = await import('date-fns');
    const localeShim = await import('date-fns/locale');
    const barrel = await import(new URL('node_modules/date-fns/index.js', root).href);
    const localeBarrel = await import(new URL('node_modules/date-fns/locale.js', root).href);

    const names = [...exported('tests/support/date-fns-shim.ts')].sort();
    expect(names.length).toBeGreaterThan(0);

    const differing = names.filter(
      n => (shim as Record<string, unknown>)[n] !== (barrel as Record<string, unknown>)[n],
    );
    expect(differing).toEqual([]);
    expect(localeShim.de).toBe(localeBarrel.de);
    // An explicit timeout because this is the only test left that loads the real
    // barrels at all, and against vitest's 5 s default it failed as a timeout
    // rather than on its assertion — which is how it first behaved. 60 s is ~25x
    // the 2.4 s it costs, which is headroom for a loaded run, not a hint that it
    // is slow.
  }, 60_000);
});
