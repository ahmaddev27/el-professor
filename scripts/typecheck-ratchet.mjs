#!/usr/bin/env node
/**
 * Typecheck ratchet.
 *
 * `npm run build` is `vite build`, which strips types without checking them.
 * The project accumulated 376 TypeScript errors that way, including undefined
 * identifiers that crashed at runtime, permission checks that were always true,
 * and 71 toast calls with their arguments reversed — all of them visible to
 * tsc, none of them visible to anyone.
 *
 * Fixing all of them at once is not realistic, so this gate ratchets instead:
 *
 *   - more errors than the baseline  -> fail, and list the new ones
 *   - fewer errors than the baseline -> fail, and ask for the baseline to be lowered
 *   - exactly the baseline           -> pass
 *
 * The second case is deliberate. A ratchet that silently accepts improvement
 * drifts back up again; making the baseline move only by an explicit edit keeps
 * the number honest.
 *
 * Run `node scripts/typecheck-ratchet.mjs --update` to write the current count.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const BASELINE_FILE = join(root, 'typecheck-baseline.json');
const UPDATE = process.argv.includes('--update');

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  console.error('typecheck: TypeScript is not installed. Run `npm install` first.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [tsc, '--noEmit', '-p', join(root, 'tsconfig.app.json')],
  { cwd: root, encoding: 'utf8' },
);

const output = `${result.stdout || ''}${result.stderr || ''}`;
const errorLines = output
  .split(/\r?\n/)
  .filter(line => / error TS\d+: /.test(line));

const count = errorLines.length;

if (UPDATE) {
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify({ maxErrors: count, note: 'Lower this as errors are fixed. It must never rise.' }, null, 2)}\n`,
  );
  console.log(`typecheck: baseline written at ${count} errors.`);
  process.exit(0);
}

if (!existsSync(BASELINE_FILE)) {
  console.error('typecheck: no baseline found. Run `npm run typecheck:update` once to create it.');
  process.exit(1);
}

const { maxErrors } = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));

if (count > maxErrors) {
  console.error(`\ntypecheck: ${count} errors, baseline is ${maxErrors}. ${count - maxErrors} new.\n`);
  // Group by file so the offending change is easy to spot.
  const byFile = new Map();
  for (const line of errorLines) {
    const file = /^(.+?)\(\d+,\d+\)/.exec(line)?.[1] ?? 'unknown';
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
  for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.error(`  ${String(n).padStart(4)}  ${file}`);
  }
  console.error('\nFix them, or run `npm run typecheck` to see the full list.');
  process.exit(1);
}

if (count < maxErrors) {
  console.error(
    `\ntypecheck: ${count} errors, baseline is ${maxErrors} — ${maxErrors - count} fewer. ` +
      'Lower the baseline with `npm run typecheck:update` and commit it.\n',
  );
  process.exit(1);
}

console.log(`typecheck: ${count} errors, at the baseline.`);
