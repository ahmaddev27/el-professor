#!/usr/bin/env node
/**
 * Phase 5 batch 2, proven as text: every converted file's logic is the base's
 * logic, byte for byte, except for lines this list names.
 *
 *   node design-harness/prove-batch2.mjs [base commit, default 85d17b9]
 *
 * For each file it takes one or more blocks — from a line that starts the
 * logic to a line that ends it, in the base and in the working tree — and
 * compares them after removing exactly the lines listed as `added` (each must
 * occur in the new block exactly as many times as listed) and `removed` (each
 * must occur in the old block). Presentation that had to reach into the logic
 * — an `onChange` handler, a sum the old markup computed inline — is listed as
 * `carried`: each snippet must appear verbatim in the base file and in the new
 * one, so a handler moved into new markup is still the old handler.
 *
 * It prints the block sizes and exits non-zero on the first difference, with
 * the first differing line of each side.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? '85d17b9';
const PRESENTATION = '  // ── Presentation (phase 5) ────────────────────────────────────────────────';

const FILES = [
  {
    path: 'src/pages/BargeldbestandPage.tsx',
    blocks: [
      // The module's doc comment and constants, then the component through handleExport.
      { from: '/**', oldTo: '  const inputStyle: React.CSSProperties = {', newTo: PRESENTATION },
    ],
    added: [
      '  const [loadFailed, setLoadFailed] = useState(false);',
      '      setLoadFailed(false);',
      '      setLoadFailed(true);',
    ],
    removed: [],
    carried: [
      'onChange={(e) => setSelectedMonth(e.target.value)}',
      'onChange={(e) => setStartDate(e.target.value)}',
      'onChange={(e) => setEndDate(e.target.value)}',
      "{ledgerInScope ? t('bargeld.balanceFormula') : t('bargeld.balanceFormulaNoLedger')}",
      '{ledgerInScope && (',
      '!ledgerInScope &&',
      "selectedDriver !== 'all' || selectedType !== 'all' || startDate || endDate",
      'onClick={handleExport}',
      'onClick={resetFilters}',
    ],
  },
];

const lines = text => text.replace(/\r\n/g, '\n').split('\n');

function block(all, from, to, label) {
  const start = all.indexOf(from);
  if (start < 0) throw new Error(`${label}: start line not found: ${from}`);
  const end = all.indexOf(to, start + 1);
  if (end < 0) throw new Error(`${label}: end line not found: ${to}`);
  return all.slice(start, end);
}

function without(blockLines, remove, label) {
  const out = [...blockLines];
  for (const line of remove) {
    const index = out.indexOf(line);
    if (index < 0) throw new Error(`${label}: listed line not found: ${line}`);
    out.splice(index, 1);
  }
  return out;
}

let failed = false;
for (const file of FILES) {
  const oldText = execFileSync('git', ['show', `${base}:${file.path}`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  const newText = readFileSync(join(root, file.path), 'utf8');
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  const oldNorm = oldText.replace(/\r\n/g, '\n');
  const newNorm = newText.replace(/\r\n/g, '\n');

  try {
    let oldCount = 0;
    let newCount = 0;
    const oldBlocks = [];
    const newBlocks = [];
    for (const spec of file.blocks) {
      const oldBlock = block(oldLines, spec.from, spec.oldTo, `${file.path} (base)`);
      const newBlock = block(newLines, spec.from, spec.newTo, file.path);
      oldCount += oldBlock.length;
      newCount += newBlock.length;
      oldBlocks.push(...oldBlock);
      newBlocks.push(...newBlock);
    }
    const oldKept = without(oldBlocks, file.removed, `${file.path} (base)`);
    const newKept = without(newBlocks, file.added, file.path);
    const length = Math.max(oldKept.length, newKept.length);
    for (let i = 0; i < length; i += 1) {
      if (oldKept[i] !== newKept[i]) {
        throw new Error(`${file.path}: logic differs at kept line ${i + 1}\n  base: ${oldKept[i]}\n  new:  ${newKept[i]}`);
      }
    }
    for (const snippet of file.carried) {
      if (!oldNorm.includes(snippet)) throw new Error(`${file.path}: carried snippet not in the base file: ${snippet}`);
      if (!newNorm.includes(snippet)) throw new Error(`${file.path}: carried snippet not in the new file: ${snippet}`);
    }
    console.log(
      `ok   ${file.path}: logic ${oldCount} lines at ${base}, ${newCount} now; identical after removing ` +
        `${file.added.length} added and ${file.removed.length} removed lines; ${file.carried.length} carried snippets verbatim`,
    );
  } catch (error) {
    failed = true;
    console.log(`FAIL ${error.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
