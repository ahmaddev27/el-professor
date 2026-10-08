/**
 * Every header the installed storage client sends must be on the storage
 * route's CORS allow-list in deploy/kong.yml.
 *
 * Kong's cors plugin answers the browser's preflight itself, so a header the
 * list does not name fails the upload in the tab with no server log at all.
 * That is what happened from 12.09.2026, when the list was tightened, until
 * 08.10.2026: storage-js adds Cache-Control and x-upsert to every upload, the
 * list named neither, and not one object was written to storage on either
 * stack in those four weeks — every Fahrtenbuch import was refused at its last
 * step, "Original-XLSX-Datei konnte nicht gespeichert werden".
 *
 * The client's headers are read from the installed package rather than written
 * down here, so an upgrade that adds one fails this test instead of a customer's
 * import.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

/** The `headers:` list of the cors plugin on the storage-v1 service. */
function storageAllowedHeaders(): string[] {
  const kong = readFileSync(join(ROOT, 'deploy', 'kong.yml'), 'utf8');
  const start = kong.indexOf('- name: storage-v1');
  expect(start, 'kong.yml has a storage-v1 service').toBeGreaterThan(-1);
  const next = kong.indexOf('\n  - name: ', start + 1);
  const block = kong.slice(start, next === -1 ? undefined : next);
  const headers = /\n {10}headers:\n((?: {12}(?:#.*|- .+)\n)+)/.exec(block);
  expect(headers, 'the storage service has a cors headers list').not.toBeNull();
  return [...(headers as RegExpExecArray)[1].matchAll(/^ {12}- (.+)$/gm)].map(m => m[1].trim().toLowerCase());
}

/** The header names the installed storage-js writes, read from its own build. */
function storageClientHeaders(): string[] {
  const source = readFileSync(require.resolve('@supabase/storage-js'), 'utf8');
  const names = [...source.matchAll(/["'](x-[a-z-]+|cache-control|content-type)["']/g)].map(m => m[1]);
  return [...new Set(names)].sort();
}

describe('the storage route admits every header the storage client sends', () => {
  it('reads the client headers it guards (cache-control and x-upsert at least)', () => {
    expect(storageClientHeaders()).toEqual(expect.arrayContaining(['cache-control', 'x-upsert']));
  });

  it('names each of them in the cors allow-list, so an upload passes its preflight', () => {
    const allowed = new Set(storageAllowedHeaders());
    const missing = storageClientHeaders().filter(header => !allowed.has(header));
    expect(missing, 'headers storage-js sends that kong.yml does not allow on /storage/v1').toEqual([]);
  });
});
