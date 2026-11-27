#!/usr/bin/env node
/**
 * Design remake R5, MonatsplanungStundennachweisPreview.tsx, proven as text.
 *
 *   node design-harness/identity-r5-snpreview.mjs [--base <ref>] [--file <path>]   (default base: origin/staging)
 *
 * Look only, so three checks, after batch 3's approach (identity-batch3.mjs):
 *
 *   1. Stripped identity. Every `className=…` and `style=…` attribute is removed
 *      from both the old and the new file (braces and quotes balanced), blank
 *      lines are dropped, whitespace is squashed. What is left must be equal,
 *      line for line, except for the declared presentation helpers below. So
 *      every handler, guard, condition, collection, t(...) call, format call
 *      and calculation of the old file is still there, in order, and nothing
 *      but a class string or a style object changed.
 *   2. Sensitive. Every old line that reads data, calls the clock or Math,
 *      formats a number, checks a permission or sets `disabled=` appears in
 *      the new file (whitespace removed).
 *   3. Document regions. This file builds no document markup (the PDF and the
 *      XLSX come from exportStundennachweisAsPdf / exportAppliedRunXlsx /
 *      exportFahreruebersichtImportFormat); every line from the top of the file
 *      to the line before `function MonatsplanungStundennachweisPreview` is
 *      byte-identical, and so is everything from `function GehaltsabweichungSection`
 *      down to its first `const overCount`, the transfer loop included.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('--base', 'origin/staging');
const path = arg('--file', 'src/components/MonatsplanungStundennachweisPreview.tsx');
const squash = s => s.replace(/\s+/g, '');

/** Presentation helpers whose old/new lines may differ: the logic half is named in the comment. */
const ALLOWED = [
  // SOURCE_BADGES: the colours of the badge move from raw rgba/hex pairs to a tone class; the label keys stay.
  [`const SOURCE_BADGES: Record<string, { bg: string; fg: string; label: TranslationKey }> = {`, `const SOURCE_BADGES: Record<string, { tone: string; label: TranslationKey }> = {`],
  [`auto: { bg: 'rgba(34,197,94,0.15)', fg: '#86efac', label: 'stn.source.auto' },`, `auto: { tone: 'bg-positive-soft text-positive', label: 'stn.source.auto' },`],
  [`repair: { bg: 'rgba(59,130,246,0.15)', fg: '#93c5fd', label: 'stn.source.repair' },`, `repair: { tone: 'bg-info-soft text-info', label: 'stn.source.repair' },`],
  [`manual_exception: { bg: 'rgba(245,158,11,0.18)', fg: '#fcd34d', label: 'stn.source.manual' },`, `manual_exception: { tone: 'bg-caution-soft text-caution', label: 'stn.source.manual' },`],
  [`manual: { bg: 'rgba(245,158,11,0.18)', fg: '#fcd34d', label: 'stn.source.manual' },`, `manual: { tone: 'bg-caution-soft text-caution', label: 'stn.source.manual' },`],
  // statusColor: hex strings become text classes; statusChip is new (the chip's tint was `${hex}20`).
  [`s === 'over' ? '#f87171' : s === 'under' ? '#fcd34d' : '#86efac';`, `s === 'over' ? 'text-critical' : s === 'under' ? 'text-caution' : 'text-positive';`],
  [null, `const statusChip = (s: DeviationStatus) =>`],
  [null, `s === 'over' ? 'bg-critical-soft text-critical' : s === 'under' ? 'bg-caution-soft text-caution' : 'bg-positive-soft text-positive';`],
  // vColor / vBg: the validity tone, hex and rgba to classes.
  [`const vColor = vs === 'gueltig' ? '#86efac' : vs === 'nicht_moeglich' ? '#f87171' : '#fcd34d';`, `const vColor = vs === 'gueltig' ? 'text-positive' : vs === 'nicht_moeglich' ? 'text-critical' : 'text-caution';`],
  [`const vBg = vs === 'gueltig' ? 'rgba(134,239,172,0.15)' : vs === 'nicht_moeglich' ? 'rgba(248,113,113,0.15)' : 'rgba(245,158,11,0.18)';`, `const vBg = vs === 'gueltig' ? 'bg-positive-soft' : vs === 'nicht_moeglich' ? 'bg-critical-soft' : 'bg-caution-soft';`],
];

/** Remove every className=… and style=… attribute, with balanced quotes and braces. */
function stripPresentation(text) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const m = /(className|style)=/y;
    m.lastIndex = i;
    const prev = text[i - 1];
    if (!/[\s]/.test(prev ?? ' ') || !m.test(text)) { out += text[i]; i += 1; continue; }
    let j = i + m.lastIndex - i;
    j = m.lastIndex;
    if (text[j] === '"') { j = text.indexOf('"', j + 1) + 1; }
    else if (text[j] === '{') {
      let depth = 0, q = null;
      for (; j < text.length; j += 1) {
        const c = text[j];
        if (q) { if (c === '\\') j += 1; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; if (depth === 0) { j += 1; break; } }
      }
    } else { out += text[i]; i += 1; continue; }
    i = j;
  }
  return out;
}
const lines = text => stripPresentation(text).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

const oldText = git('show', `${base}:${path}`).replace(/\r\n/g, '\n');
const newText = readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const problems = [];

// 1. stripped identity
const o = lines(oldText), n = lines(newText);
const allowOld = new Set(ALLOWED.map(a => a[0]).filter(Boolean).map(squash));
const allowNew = new Set(ALLOWED.map(a => a[1]).filter(Boolean).map(squash));
let a = 0, b = 0, identical = 0;
const onlyOld = [], onlyNew = [];
while (a < o.length || b < n.length) {
  if (a < o.length && b < n.length && o[a] === n[b]) { a += 1; b += 1; identical += 1; continue; }
  // resync: look ahead for the next line equal on both sides within a small window
  let found = false;
  for (let d = 1; d <= 12 && !found; d += 1) {
    for (let x = 0; x <= d && !found; x += 1) {
      const y = d - x;
      if (a + x < o.length && b + y < n.length && o[a + x] === n[b + y] && o[a + x + 1] === n[b + y + 1]) {
        for (let k = 0; k < x; k += 1) onlyOld.push(o[a + k]);
        for (let k = 0; k < y; k += 1) onlyNew.push(n[b + k]);
        a += x; b += y; found = true;
      }
    }
  }
  if (!found) { onlyOld.push(o[a] ?? ''); onlyNew.push(n[b] ?? ''); a += 1; b += 1; }
}
const usedOld = new Set(), usedNew = new Set();
for (const l of onlyOld) { const k = squash(l); if (allowOld.has(k)) usedOld.add(k); else problems.push(`only in OLD (not declared): ${l.slice(0, 200)}`); }
for (const l of onlyNew) { const k = squash(l); if (allowNew.has(k)) usedNew.add(k); else problems.push(`only in NEW (not declared): ${l.slice(0, 200)}`); }
for (const k of allowOld) if (!usedOld.has(k)) problems.push(`declared as OLD-only but not missing: ${k.slice(0, 80)}`);
for (const k of allowNew) if (!usedNew.has(k)) problems.push(`declared as NEW-only but not present: ${k.slice(0, 80)}`);

// 2. sensitive lines
const SENSITIVE = /supabase|\.from\(|\.rpc\(|\.range\(|\.eq\(|\.in\(|\.not\(|\.order\(|\.upsert\(|\.insert\(|\.update\(|\.delete\(|new Date|Date\.|getTime|getMonth|getFullYear|getDate\(|getDay\(|Math\.|parseInt|parseFloat|toFixed|toLocale|navigate\(|while \(true\)|\bcan\(|isAdmin|isSuperAdmin|companyId|disabled=|reassign_fahrtenbuch_trip|onClick|onChange/;
const newSq = squash(stripPresentation(newText));
let sensitive = 0;
for (const line of stripPresentation(oldText).split('\n')) {
  if (!SENSITIVE.test(line)) continue;
  const k = squash(line);
  if (!k || newSq.includes(k)) { sensitive += 1; continue; }
  problems.push(`sensitive line lost or changed: ${line.trim().slice(0, 160)}`);
}

// 3. byte-identical regions
const region = (text, from, to) => { const s = text.indexOf(from); const e = to ? text.indexOf(to, s) : text.length; return text.slice(s, e); };
for (const [label, from, to] of [
  ['module top (imports, helpers, builders, exports)', '// Monatsplanung', 'function MonatsplanungStundennachweisPreview({'],
  ['component logic, state to the transfer-free handlers', 'function MonatsplanungStundennachweisPreview({', '  return (\n    <div\n      className="fixed inset-0 z-[55]'],
  ['analysis, transfer rules and validateTransfer', 'const SALARY_TOLERANCE_DEFAULT', 'function GehaltsabweichungSection('],
  ['GehaltsabweichungSection logic incl. reassign loop', 'function GehaltsabweichungSection(', '  const statusColor ='],
]) {
  const oldR = region(oldText, from, to), newR = region(newText, from, to);
  if (!oldR || oldR !== newR) problems.push(`region "${label}" is not byte-identical`);
}

console.log(`base ${base}  file ${path}`);
console.log(`  identical after stripping className/style: ${identical} of ${o.length} old lines`);
console.log(`  sensitive lines present: ${sensitive}`);
console.log(`  declared presentation-helper lines: ${usedOld.size} old / ${usedNew.size} new`);
for (const p of problems) console.log(`  FAIL ${p}`);
if (!problems.length) console.log('  OK');
process.exit(problems.length ? 1 : 0);
