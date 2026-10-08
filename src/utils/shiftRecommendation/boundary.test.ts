/**
 * The boundary of the shift recommendation, read from its source: it is pure,
 * it reaches no database, and it cannot reach anything that writes, moves or
 * assigns a ride. The recommendation produces shifts and estimates; the day a
 * module here imports a trip writer or a ride builder is the day it could
 * start producing records of rides that never happened, and that is a line
 * this product does not cross (owner's brief of 08.10.2026, declined in part).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES = readdirSync(HERE)
  .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map(name => ({ name, text: readFileSync(join(HERE, name), 'utf8') }));

/** Strip comments, so a header that names a forbidden thing to forbid it does not trip the check. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('shift recommendation boundary', () => {
  it('has sources to check', () => {
    expect(SOURCES.map(s => s.name)).toEqual(
      expect.arrayContaining(['types.ts', 'settings.ts', 'timeline.ts', 'profile.ts', 'recommend.ts', 'hourly.ts', 'index.ts']),
    );
  });

  it('imports only from itself, money, local time and the analysis engine’s types and interval order', () => {
    const allowed = new Set(['../money', '../localDayWindow', '../tripAnalysis/types', '../tripAnalysis/intervals']);
    for (const { name, text } of SOURCES) {
      for (const match of code(text).matchAll(/from\s+'([^']+)'/g)) {
        const target = match[1];
        if (target.startsWith('./')) continue;
        expect(allowed.has(target), `${name} imports ${target}`).toBe(true);
      }
    }
  });

  it('reads no clock, draws no random number and names no table', () => {
    for (const { name, text } of SOURCES) {
      const body = code(text);
      expect(body, name).not.toMatch(/Date\.now|Math\.random|performance\.now/);
      // `.from('…')` is a PostgREST table; `Array.from(` is not.
      expect(body, name).not.toMatch(/supabase|fahrtenbuch_trips|\.from\(\s*['"`]|\.rpc\(/);
    }
  });
});
