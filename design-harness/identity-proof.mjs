#!/usr/bin/env node
/**
 * The phase 5 identity proof: a converted screen's logic is the old text.
 *
 *   node design-harness/identity-proof.mjs . origin/staging src/components/ReceiptList.tsx [more files]
 *
 * For each file, OLD is `git show <base-ref>:<file>` and NEW is the working tree.
 *
 * 1. Logic region. NEW's logic is every line after its imports and before the
 *    `// ── Presentation (phase 5)` marker; OLD's is the same span of the old
 *    file. The two are compared line by line (LCS), and every line only in
 *    one of them is printed. "IDENTICAL" means nothing was added, removed or
 *    changed; otherwise the printout is the whole difference, to be read.
 * 2. Inline handlers. Every `onXxx={...}` expression in OLD's markup must
 *    occur verbatim (whitespace-normalised) in NEW. Missing ones are printed.
 * 3. Logic calls in the old markup. Every call, in OLD's markup, of a name
 *    the old logic region declares or destructures (permission checks, VAT,
 *    parsers, handlers …) must occur verbatim in NEW. Missing ones are printed.
 *
 * It proves presence and identity as text; it does not judge whether a
 * missing line was only look. That is the reviewer's reading of the printout.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [repo, baseRef, ...files] = process.argv.slice(2);
const MARKER = '// ── Presentation (phase 5)';
const norm = s => s.replace(/\s+/g, ' ').trim();

function importEnd(lines) {
  // Index of the first line after the leading import block (imports may span lines).
  let i = 0;
  let inImport = false;
  for (; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (inImport) {
      if (/from\s+['"][^'"]+['"];?\s*$/.test(line) || /^['"][^'"]+['"];?$/.test(line)) inImport = false;
      continue;
    }
    if (line === '') continue;
    if (line.startsWith('import ')) {
      if (!/from\s+['"][^'"]+['"];?\s*$/.test(line) && !/^import\s+['"]/.test(line)) inImport = true;
      continue;
    }
    break;
  }
  return i;
}

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['-', i, a[i]]); i += 1; }
    else { out.push(['+', j, b[j]]); j += 1; }
  }
  while (i < n) { out.push(['-', i, a[i]]); i += 1; }
  while (j < m) { out.push(['+', j, b[j]]); j += 1; }
  return out;
}

/** Every `name={ ... }` attribute expression with balanced braces. */
function attributeExpressions(text, namePattern) {
  const found = [];
  const re = new RegExp(`\\b(${namePattern})=\\{`, 'g');
  let match;
  while ((match = re.exec(text))) {
    let depth = 1;
    let k = re.lastIndex;
    while (k < text.length && depth > 0) {
      const c = text[k];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      k += 1;
    }
    found.push({ name: match[1], expr: text.slice(re.lastIndex, k - 1) });
  }
  return found;
}

/** Every call `name(...)` with balanced parentheses. */
function calls(text) {
  const found = [];
  const re = /\b([A-Za-z_$][\w$]*)\(/g;
  let match;
  while ((match = re.exec(text))) {
    let depth = 1;
    let k = re.lastIndex;
    while (k < text.length && depth > 0) {
      const c = text[k];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      k += 1;
    }
    found.push({ name: match[1], text: text.slice(match.index, k) });
  }
  return found;
}

let failures = 0;
for (const file of files) {
  const oldText = execFileSync('git', ['-C', repo, 'show', `${baseRef}:${file}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const newText = readFileSync(join(repo, file), 'utf8');
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  console.log(`\n=== ${file}`);

  const markerAt = newLines.findIndex(line => line.includes(MARKER));
  if (markerAt < 0) {
    console.log('  no presentation marker');
    failures += 1;
    continue;
  }
  const newStart = importEnd(newLines);
  let newEnd = markerAt;
  while (newEnd > newStart && newLines[newEnd - 1].trim() === '') newEnd -= 1;
  const newLogic = newLines.slice(newStart, newEnd);
  const lastLogicLine = newLogic[newLogic.length - 1];

  const oldStart = importEnd(oldLines);
  // The old logic ends at the last occurrence (before its first JSX return of
  // the main component) of NEW's last logic line.
  let oldEnd = -1;
  for (let k = oldStart; k < oldLines.length; k += 1) if (oldLines[k] === lastLogicLine) { oldEnd = k + 1; }
  if (oldEnd < 0) {
    console.log(`  NEW's last logic line is not in OLD: ${JSON.stringify(lastLogicLine)}`);
    failures += 1;
    continue;
  }
  // Take the FIRST occurrence at or after which the rest matches best: use the
  // first occurrence whose index is past the old region's plausible end.
  const occurrences = [];
  for (let k = oldStart; k < oldLines.length; k += 1) if (oldLines[k] === lastLogicLine) occurrences.push(k + 1);
  let best = null;
  for (const end of occurrences) {
    const diff = lcsDiff(oldLines.slice(oldStart, end), newLogic);
    if (!best || diff.length < best.diff.length) best = { end, diff };
  }
  oldEnd = best.end;
  const oldLogic = oldLines.slice(oldStart, oldEnd);
  console.log(`  logic region: OLD lines ${oldStart + 1}-${oldEnd}, NEW lines ${newStart + 1}-${newEnd} (marker at ${markerAt + 1})`);
  if (best.diff.length === 0) console.log('  logic region: IDENTICAL');
  else {
    console.log(`  logic region: ${best.diff.filter(d => d[0] === '-').length} line(s) only in OLD, ${best.diff.filter(d => d[0] === '+').length} only in NEW:`);
    for (const [sign, index, line] of best.diff) {
      console.log(`    ${sign} ${sign === '-' ? oldStart + index + 1 : newStart + index + 1}: ${line}`);
    }
  }

  const oldMarkup = oldLines.slice(oldEnd).join('\n');
  const newAll = norm(newText);

  const handlers = attributeExpressions(oldMarkup, 'on[A-Z][A-Za-z]*');
  const missingHandlers = handlers.filter(h => !newAll.includes(norm(h.expr)));
  console.log(`  inline handlers in OLD markup: ${handlers.length}, present in NEW: ${handlers.length - missingHandlers.length}`);
  for (const h of missingHandlers) console.log(`    missing ${h.name}={${norm(h.expr)}}`);

  // Names the logic region declares, and the props.
  const declared = new Set();
  for (const m of oldLogic.join('\n').matchAll(/\b(?:const|let|function)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of oldLogic.join('\n').matchAll(/const\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim();
      if (name) declared.add(name);
    }
  }
  for (const m of oldLogic.join('\n').matchAll(/^\s{2}([A-Za-z_$][\w$]*),?$/gm)) declared.add(m[1]);
  const logicCalls = calls(oldMarkup).filter(c => declared.has(c.name));
  const seen = new Set();
  const missingCalls = [];
  for (const c of logicCalls) {
    const key = norm(c.text);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!newAll.includes(key)) missingCalls.push(key);
  }
  console.log(`  distinct logic calls in OLD markup: ${seen.size}, present in NEW: ${seen.size - missingCalls.length}`);
  for (const c of missingCalls) console.log(`    missing ${c}`);
}
process.exitCode = failures ? 1 : 0;
