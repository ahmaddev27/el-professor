#!/usr/bin/env node
/**
 * Style ratchet (phase 5).
 *
 * The legacy screens style themselves with inline style objects and colours
 * spelled out in the source — thousands of each. Phase 5 moves the screens onto
 * the design system batch by batch, and this gate makes that movement one-way:
 * a converted screen cannot quietly grow an inline style again, and an
 * unconverted one cannot gain a new theme-blind colour.
 *
 * It works like scripts/typecheck-ratchet.mjs, per file instead of in total:
 *
 *   - a file with more than its baseline  -> fail, naming the file and the count
 *   - a file with fewer than its baseline -> fail, asking for the baseline to be lowered
 *   - every file exactly at its baseline  -> pass
 *
 * Failing on improvement is deliberate, for the same reason as the typecheck
 * ratchet: a baseline that only moves by an explicit, committed edit stays
 * honest. Per file, so a fix in one screen cannot pay for a regression in
 * another.
 *
 * What counts is defined and tested in style-ratchet-core.mjs.
 *
 *   node scripts/style-ratchet.mjs            check (part of npm run build)
 *   node scripts/style-ratchet.mjs --update   write the current counts (npm run styles:update)
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareToBaseline, countStyleDebt, isCounted, totals } from './style-ratchet-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = join(root, 'style-baseline.json');
const UPDATE = process.argv.includes('--update');

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc;
}

const current = {};
for (const file of walk(join(root, 'src'))) {
  const path = relative(root, file).replace(/\\/g, '/');
  if (!isCounted(path)) continue;
  const counts = countStyleDebt(readFileSync(file, 'utf8'));
  if (counts.style > 0 || counts.color > 0) current[path] = counts;
}

const sum = totals(current);
const summary = `${sum.style} inline styles and ${sum.color} hard-coded colours in ${sum.files} files`;

if (UPDATE) {
  const files = Object.fromEntries(Object.keys(current).sort().map(path => [path, current[path]]));
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify(
      {
        note: 'Per-file counts of inline styles and hard-coded colours (scripts/style-ratchet.mjs). Lower them as screens move to the design system; they must never rise.',
        files,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`styles: baseline written: ${summary}.`);
  process.exit(0);
}

if (!existsSync(BASELINE_FILE)) {
  console.error('styles: no baseline found. Run `npm run styles:update` once to create it.');
  process.exit(1);
}

const { files: baseline } = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
const { worse, better } = compareToBaseline(current, baseline);
const line = ({ path, kind, was, now }) => `  ${path}  ${kind === 'style' ? 'inline styles' : 'colours'} ${was} -> ${now}`;

if (worse.length > 0) {
  console.error(`\nstyles: ${worse.length} count(s) above the baseline.\n`);
  for (const entry of worse) console.error(line(entry));
  console.error(
    '\nUse the design system instead: classes and tokens from src/components/ui and tailwind.config.js, ' +
      'variants for hover, focus and screen size. CLAUDE.md, "Design system and the design preview".',
  );
  process.exit(1);
}

if (better.length > 0) {
  console.error(`\nstyles: ${better.length} count(s) below the baseline.\n`);
  for (const entry of better) console.error(line(entry));
  console.error('\nLower the baseline with `npm run styles:update` and commit style-baseline.json.\n');
  process.exit(1);
}

console.log(`styles: ${summary}, at the baseline.`);
