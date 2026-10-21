import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest.config.ts aliases `date-fns` to tests/support/date-fns-shim.ts so the
// test run does not load the package's ~1000 modules. A name src/ starts using
// that the shim does not re-export would be `undefined` in tests only.

const root = new URL('../../', import.meta.url);
const text = (path: string) => readFileSync(new URL(path, root), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function usedNames(from: string): Set<string> {
  const names = new Set<string>();
  const pattern = new RegExp(`import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'${from}'`, 'g');
  for (const file of sources(new URL('src', root).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
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
  it('re-export every name src/ imports from date-fns', () => {
    const shim = exported('tests/support/date-fns-shim.ts');
    expect([...usedNames('date-fns')].filter(n => !shim.has(n))).toEqual([]);
  });

  it('re-export every name src/ imports from date-fns/locale', () => {
    const shim = exported('tests/support/date-fns-locale-shim.ts');
    expect([...usedNames('date-fns/locale')].filter(n => !shim.has(n))).toEqual([]);
  });
});
