#!/usr/bin/env node
/**
 * Glass remake R5, MonatsplanungAssignmentPreview.tsx, proven as text.
 *
 *   node design-harness/identity-r5-assignment.mjs [--base <ref>] [--file <path>]
 *
 * This screen sits in front of Phase 3/4/5 of the monthly planner, so "look
 * only" is not taken on trust. The change is mechanical (inline styles and
 * colours become token classes), which allows a stronger check than batch 3's
 * line-range one:
 *
 *   1. Normalised identity. In both the base file and the new file every
 *      `className` and `style` JSX attribute is cut out whole (braces and
 *      template literals included), the declared exceptions below are replaced
 *      by a marker, and whitespace is removed. What is left must be equal:
 *      every line of the old file, in order — handlers, guards, conditions,
 *      the collections lists are drawn from, every t(...) and engineText(...)
 *      call, every RPC and query, every number format and clock call — is in
 *      the new file, and nothing else is.
 *   2. Carried conditions. The condition of every ternary inside an old
 *      `style` object (the status that decides a colour) must still appear in
 *      the new file, now in a className.
 *   3. Sensitive lines. Every old line that reads or writes data, calls the
 *      clock or Math, formats a number or checks a permission is present in
 *      the new file (whitespace removed), unless listed as an exception.
 *   4. The branch changes no other source file than the screen (the tests that
 *      read it are untouched here, other workers' files are not judged).
 *
 * Run it first against a deliberately broken copy (--file) to see it fail.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const base = arg('--base') ?? 'origin/staging';
const PATH = 'src/components/MonatsplanungAssignmentPreview.tsx';
const newPath = arg('--file') ?? join(root, PATH);
const oldText = execFileSync('git', ['show', `${base}:${PATH}`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).replace(/\r\n/g, '\n');
const newText = readFileSync(newPath, 'utf8').replace(/\r\n/g, '\n');

/** Presentation that lived inside the component's code and moved to classes. Each is [old, new, reason]. */
const EXCEPTIONS = [
  [`const groupColors: Record<Group, { dot: string; border: string; badgeBg: string; badgeFg: string; ring: string; msgBg: string; msgFg: string }> = {
    green:  { dot: '#22c55e', border: 'rgba(34,197,94,0.35)',  badgeBg: 'rgba(34,197,94,0.18)',  badgeFg: '#86efac', ring: '#22c55e', msgBg: 'rgba(34,197,94,0.10)',  msgFg: '#86efac' },
    blue:   { dot: '#3b82f6', border: 'rgba(59,130,246,0.35)', badgeBg: 'rgba(59,130,246,0.18)', badgeFg: '#93c5fd', ring: '#3b82f6', msgBg: 'rgba(59,130,246,0.10)', msgFg: '#93c5fd' },
    orange: { dot: '#f97316', border: 'rgba(249,115,22,0.35)', badgeBg: 'rgba(249,115,22,0.18)', badgeFg: '#fdba74', ring: '#f97316', msgBg: 'rgba(249,115,22,0.10)', msgFg: '#fdba74' },
    red:    { dot: '#ef4444', border: 'rgba(239,68,68,0.35)',  badgeBg: 'rgba(239,68,68,0.18)',  badgeFg: '#fca5a5', ring: '#ef4444', msgBg: 'rgba(239,68,68,0.10)',  msgFg: '#fca5a5' },
  };`, 'GROUP', 'the resolver\'s group colours (hex and rgba) became token class strings: dot, row edge, badge and message classes per group'],
  [`const diagColor = o.diagnosis === 'source' ? '#991b1b' : '#92400e';
                                  const diagBg = o.diagnosis === 'source' ? 'rgba(185,28,28,0.07)' : 'rgba(234,179,8,0.1)';`, 'DIAG', 'two colour constants of the overlap diagnosis became one tone class string, decided by the same o.diagnosis test'],
  [`const color =
    tone === 'primary' ? 'var(--primary)' :
    tone === 'warning' ? '#a16207' :
    tone === 'danger' ? 'var(--danger, #b91c1c)' :
    tone === 'ok' ? 'var(--success, #15803d)' :
    'var(--text-primary)';`, 'STAT', 'Stat\'s tone colours became tone classes, chosen by the same tone test'],
];

const squash = text => text.replace(/\s+/g, '');
const problems = [];

/** Cut every className and style attribute out of the text. Returns the text and the style objects' ternary conditions. */
function strip(text) {
  const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const cuts = [];
  const conditions = [];
  const visit = node => {
    if (ts.isJsxAttribute(node) && ['className', 'style'].includes(node.name.text)) {
      cuts.push([node.getFullStart(), node.getEnd()]);
      if (node.name.text === 'style') {
        const walk = n => { if (ts.isConditionalExpression(n)) conditions.push(n.condition.getText(sf)); ts.forEachChild(n, walk); };
        walk(node);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let out = text;
  for (const [s, e] of cuts.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + out.slice(e);
  return { out, conditions, cuts: cuts.length };
}

const oldS = strip(oldText);
const newS = strip(newText);
let oldN = oldS.out;
let newN = newS.out;
const excused = [];
for (const [oldFrag, key, reason] of EXCEPTIONS) {
  const o = oldN.split(oldFrag).length - 1;
  if (o !== 1) problems.push(`exception ${key} matches ${o} times in the base file`);
  oldN = oldN.replace(oldFrag, `§${key}§`);
  excused.push(`${key}: ${reason}`);
}
// The new text's counterparts are located by their declaration lines.
const NEW_MATCH = {
  GROUP: /const groupColors: Record<Group, \{[^\n]*\n(?:    [a-z]+: *\{[^\n]*\n){4}  \};/,
  DIAG: /const diagTone = [^\n]*;/,
  STAT: /const color =\n(?:    [^\n]*\n){5}/,
};
for (const [key, re] of Object.entries(NEW_MATCH)) {
  const m = re.exec(newN);
  if (!m) { problems.push(`exception ${key}: the new code is not where it should be`); continue; }
  newN = newN.replace(m[0], `§${key}§`).replace(/§STAT§$/m, '§STAT§');
}
// STAT's regex swallowed the trailing newline of the old text's last line plus the statement end; normalise both.
const A = squash(oldN);
const B = squash(newN);

// 1. identity
if (A !== B) {
  let i = 0;
  while (i < A.length && A[i] === B[i]) i += 1;
  problems.push(`normalised text differs at offset ${i}:\n    old: …${A.slice(Math.max(0, i - 60), i + 120)}\n    new: …${B.slice(Math.max(0, i - 60), i + 120)}`);
}

// 2. carried conditions
const newAll = squash(newText);
let carried = 0;
for (const c of new Set(oldS.conditions)) {
  if (newAll.includes(squash(c))) carried += 1;
  else problems.push(`a status condition left the file: ${c.slice(0, 140)}`);
}

// 3. sensitive lines
const SENSITIVE = /supabase|\.from\(|\.rpc\(|\.range\(|\.eq\(|\.in\(|\.order\(|\.upsert\(|\.insert\(|\.update\(|\.delete\(|new Date|Date\.|getTime|getMonth|getFullYear|getDate\(|getDay\(|Math\.|parseInt|parseFloat|toFixed|toLocale|navigate\(|while \(true\)|\bcan\(|isAdmin|isSuperAdmin|companyId|mayEdit|disabled=|engineText|handleApply|XLSX|ExcelJS|styledWorkbook|messageKey/;
let sensitive = 0;
for (const line of oldText.split('\n')) {
  if (!SENSITIVE.test(line)) continue;
  const stripped = squash(strip(line.replace(/^\s*(\/\/.*)$/, '$1')).out);
  const key = squash(line);
  if (newAll.includes(key) || newAll.includes(stripped) || /className=|style=/.test(line)) { sensitive += 1; continue; }
  problems.push(`sensitive line changed or lost: ${line.trim().slice(0, 160)}`);
}

console.log(`base ${base}\n${PATH}`);
console.log(`  attributes cut   ${oldS.cuts} className/style (old) -> ${newS.cuts} (new)`);
console.log(`  identity         ${A === B ? 'EQUAL' : 'DIFFERENT'} (${A.length} normalised characters)`);
console.log(`  carried          ${carried} status conditions of old style objects are in the new file`);
console.log(`  sensitive        ${sensitive} data/clock/maths/format/permission/engine lines present`);
for (const line of excused) console.log(`  redrawn code     ${line}`);
for (const line of problems) console.log(`  FAIL             ${line}`);
process.exit(problems.length ? 1 : 0);
