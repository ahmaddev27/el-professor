/**
 * The boundary of the Rückkehrpflicht checks, read from their source: they read
 * and report. No database, no clock, no randomness, and nothing that could
 * move, re-time or reassign a ride is reachable from here — the checks exist so
 * the operator can correct the operation, never the record (see
 * fahrtenbuch-analysis-boundary in the project's history: past rides are never
 * changed to fit anything).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES = readdirSync(HERE)
  .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map(name => ({ name, text: readFileSync(join(HERE, name), 'utf8') }));

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('return check boundary', () => {
  it('has sources to check', () => {
    expect(SOURCES.map(s => s.name)).toEqual(expect.arrayContaining(['types.ts', 'parse.ts', 'geo.ts', 'check.ts', 'index.ts']));
  });

  it('imports only the importer’s reading rules, the analysis adapter, and itself', () => {
    const allowed = new Set([
      '../fahrtenbuchImportParser',
      '../tripAnalysis/adapter',
      '../tripAnalysis/types',
      '../tripAnalysis/intervals',
    ]);
    for (const { name, text } of SOURCES) {
      for (const match of code(text).matchAll(/from\s+'([^']+)'/g)) {
        if (match[1].startsWith('./')) continue;
        expect(allowed.has(match[1]), `${name} imports ${match[1]}`).toBe(true);
      }
    }
  });

  it('reads no clock, draws no random number, names no table and calls no RPC', () => {
    for (const { name, text } of SOURCES) {
      const body = code(text);
      expect(body, name).not.toMatch(/Date\.now|Math\.random|performance\.now/);
      // `.from('…')` is a PostgREST table; `Array.from(` is not.
      expect(body, name).not.toMatch(/supabase|fahrtenbuch_trips|\.from\(\s*['"`]|\.rpc\(/);
    }
  });
});
