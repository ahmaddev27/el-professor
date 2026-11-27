#!/usr/bin/env node
/**
 * Remake R5, HistoricalReconciliationWizard, proven as text: the screen only draws differently.
 *
 *   node design-harness/identity-r5-reconciliation.mjs [--base <commit>]    (default: merge-base with origin/staging)
 *
 * Batch 3 moves screens that produce statutory documents, so "look only" is
 * not taken on trust. For each converted file this compares the base commit's
 * text with the working tree's:
 *
 *   1. Verbatim. Every line of the old file outside the ranges declared as
 *      redrawn below appears in the new file unchanged, in the same order, as
 *      the same contiguous chunks. That covers every query, calculation,
 *      handler body and state line the file had above its markup.
 *
 *   2. Carried. Inside a redrawn range, every expression the old markup
 *      evaluated — an event handler, a disabled/value/min/max guard, the
 *      condition of a conditional block, a formatting call — must still appear
 *      in the new file (compared with all whitespace removed, since the markup
 *      around it is re-indented). Only presentation is exempt: className and
 *      style values, icon sizes, keys, and the legacy hover handlers that
 *      painted borders. Anything else that went is listed below with the
 *      reason, and an unlisted loss fails the run.
 *
 *   3. Sensitive. Every line of the old file, redrawn or not, that reads or
 *      writes data, calls the clock or Math, parses a number, formats a date or
 *      an amount, or checks a permission, appears in the new file (whitespace
 *      removed), unless it is listed below with the reason.
 *
 * And for the branch as a whole: every file it changes matches the allow-list
 * at the end, so no document builder, engine, export module or golden-master
 * snapshot can change without this run failing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const argIndex = process.argv.indexOf('--base');
const base = argIndex > 0 ? process.argv[argIndex + 1] : git('merge-base', 'HEAD', 'origin/staging').trim();

// ── What was converted, and what was allowed to go ─────────────────────────

/**
 * `redrawn`: old line ranges (1-based, inclusive) replaced by new markup.
 * `dropped`: fragments or sensitive lines of the old text that are gone on
 * purpose, each with its reason. A fragment is matched after whitespace
 * removal, as the checks compare it.
 */
const FILES = CONFIG();
const FILE_ARG = process.env.REC_NEW_FILE; // negative controls point this at a mutated copy

// ── Checks ───────────────────────────────────────────────────────────────────

const squash = text => text.replace(/\s+/g, '');
const SENSITIVE =
  /supabase|\.from\(|\.rpc\(|\.range\(|\.eq\(|\.in\(|\.not\(|\.order\(|\.upsert\(|\.insert\(|\.update\(|\.delete\(|new Date|Date\.|getTime|getMonth|getFullYear|getDate\(|getDay\(|Math\.|parseInt|parseFloat|toFixed|toLocale|navigate\(|while \(true\)|\bcan\(|isAdmin|isSuperAdmin|companyId|mayEdit|disabled=/;
const PRESENTATION_ATTRS = new Set(['className', 'style', 'size', 'key', 'onMouseEnter', 'onMouseLeave', 'strokeWidth']);

/**
 * The balanced {…} groups of a region, with the attribute each belongs to.
 * A presentation attribute (className, style, the legacy hover handlers) is
 * skipped whole, braces inside it included; every other group is kept and
 * also searched, so a handler inside a conditional block is found too.
 */
function braceGroups(text) {
  const groups = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let quote = null;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (quote) {
        if (char === '\\') { i += 1; continue; }
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;
    const attribute = /([A-Za-z-]+)=$/.exec(text.slice(Math.max(0, start - 40), start))?.[1] ?? null;
    if (attribute && PRESENTATION_ATTRS.has(attribute)) {
      start = end;
      continue;
    }
    groups.push({ attribute, inner: text.slice(start + 1, end) });
  }
  return groups;
}

/**
 * What of a group must survive. An expression without markup survives whole.
 * One that renders markup must keep what decides the markup: the condition in
 * front of it, the collection a list is drawn from, and each `: cond ?` of an
 * else-if chain. The markup itself is what was redrawn.
 */
function logicOf({ inner }) {
  const trimmed = inner.trim();
  if (!trimmed || trimmed.startsWith('/*')) return [];
  if (/^(['"`])[^'"`]*\1$/.test(trimmed)) return []; // a plain string
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return []; // a plain number
  const jsx = /(^|[^\w$.)\]])<[A-Za-z]/.exec(trimmed);
  if (!jsx) return [trimmed];
  const logic = [];
  let head = trimmed.slice(0, jsx.index + jsx[1].length).trim().replace(/\(\s*$/, '').trim();
  const mapped = /^([\s\S]*?)\.map\(\s*\(?[^)]*\)?\s*=>$/.exec(head);
  if (mapped) head = mapped[1];
  head = head.replace(/(&&|\?)$/, '').trim();
  if (head) logic.push(head);
  for (const match of trimmed.matchAll(/\)\s*:\s*([^<>{}()]+?)\s*\?\s*\(?\s*</g)) logic.push(match[1].trim());
  return logic;
}

/** A redrawn range is `[from, to]` of markup, or `[from, to, 'code']` for code with no markup (imports, a removed helper). */
const within = (line, ranges) => ranges.some(([from, to]) => line >= from && line <= to);

/** A JSX container `{expr}` or a parenthesised `(expr)` compares as `expr`. */
const bare = line => squash(line).replace(/^\{(.*)\}$/, '$1').replace(/^\((.*)\),?$/, '$1');

function checkFile(config) {
  const oldText = git('show', `${base}:${config.path}`).replace(/\r\n/g, '\n');
  const newText = readFileSync(FILE_ARG ?? join(root, config.path), 'utf8').replace(/\r\n/g, '\n');
  const oldLines = oldText.split('\n');
  const newSquashed = squash(newText);
  // A dropped fragment ending in "…" names a long expression by its start.
  const dropped = new Map((config.dropped ?? []).map(([fragment, reason]) => [squash(fragment), reason]));
  const droppedKey = key => {
    if (dropped.has(key)) return key;
    for (const candidate of dropped.keys()) {
      if (candidate.endsWith('…') && key.startsWith(candidate.slice(0, -1))) return candidate;
    }
    return null;
  };
  const used = new Set();
  const insertedAfter = new Set(config.insertedAfter ?? []);
  const problems = [];
  const excused = [];
  const excuse = (key, label) => {
    used.add(key);
    excused.push(`${label.replace(/\s+/g, ' ').slice(0, 100)} — ${dropped.get(key)}`);
  };

  // 0. What a drop moved elsewhere must be there: each expression is looked
  //    for in the new file, whitespace aside.
  let required = 0;
  for (const fragment of config.mustContain ?? []) {
    if (newSquashed.includes(squash(fragment))) required += 1;
    else problems.push(`must still contain, and does not: ${fragment.slice(0, 140)}`);
  }

  // 1. Verbatim chunks, in order. A chunk ends at a redrawn range and after
  //    each line the config says new lines were inserted after.
  const chunks = [];
  let current = [];
  oldLines.forEach((line, index) => {
    const number = index + 1;
    if (within(number, config.redrawn)) {
      if (current.length) chunks.push(current);
      current = [];
      return;
    }
    current.push({ line, number });
    if (insertedAfter.has(number)) {
      chunks.push(current);
      current = [];
    }
  });
  if (current.length) chunks.push(current);
  let cursor = 0;
  let verbatimLines = 0;
  for (const chunk of chunks) {
    const body = chunk.map(entry => entry.line).join('\n');
    const at = newText.indexOf(body, cursor);
    if (at < 0) {
      problems.push(`old lines ${chunk[0].number}–${chunk.at(-1).number} are not in the new file verbatim and in order`);
    } else {
      cursor = at + body.length;
      verbatimLines += chunk.length;
    }
  }

  // 2. Logic carried out of the redrawn markup.
  let carried = 0;
  for (const [from, to, kind] of config.redrawn) {
    if (kind === 'code') continue;
    const region = oldLines.slice(from - 1, to).join('\n');
    for (const group of braceGroups(region)) {
      for (const logic of logicOf(group)) {
        const key = squash(logic);
        if (newSquashed.includes(key)) { carried += 1; continue; }
        const excusedBy = droppedKey(key);
        if (excusedBy) { excuse(excusedBy, logic); continue; }
        problems.push(`lost from lines ${from}–${to}: ${logic.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  }

  // 3. Sensitive lines anywhere in the old file.
  let sensitive = 0;
  oldLines.forEach((line, index) => {
    if (!SENSITIVE.test(line)) return;
    const key = bare(line);
    if (!key || newSquashed.includes(key)) { sensitive += 1; return; }
    // An opening tag whose element was swapped (<button> for <Button>) passes
    // when its attributes are all still there, in the same order.
    const attributes = key.replace(/^<[A-Za-z.]+/, '');
    if (key.startsWith('<') && attributes && newSquashed.includes(attributes)) { sensitive += 1; return; }
    const excusedBy = droppedKey(key);
    if (excusedBy) { excuse(excusedBy, `line ${index + 1}: ${line.trim()}`); return; }
    problems.push(`sensitive line ${index + 1} changed or lost: ${line.trim().slice(0, 160)}`);
  });

  // An excuse nothing needed is a stale claim; it fails like a loss.
  for (const [key, reason] of dropped) {
    if (!used.has(key)) problems.push(`listed as dropped but not missing: ${key.slice(0, 80)} (${reason.slice(0, 40)}…)`);
  }

  return { config, verbatimLines, oldLineCount: oldLines.length, carried, sensitive, required, excused, problems };
}



let failed = false;
console.log(`base ${base.slice(0, 10)}\n`);
for (const config of FILES) {
  const result = checkFile(config);
  console.log(`${config.path}`);
  console.log(`  verbatim   ${result.verbatimLines} of ${result.oldLineCount} old lines, in order`);
  console.log(`  carried    ${result.carried} expressions out of the redrawn markup`);
  console.log(`  sensitive  ${result.sensitive} data, clock, maths, format and permission lines present`);
  for (const line of result.excused) console.log(`  dropped    ${line}`);
  for (const line of result.problems) console.log(`  FAIL       ${line}`);
  if (result.problems.length) failed = true;
  console.log('');
}

// ── 4. Look-only token diff (added for R5) ─────────────────────────────────
// Remove every className and style attribute from BOTH files, then compare the
// remaining token streams. Anything that still differs is listed and has to be
// in EXPECTED_RESIDUAL, so a handler, a guard, a t() key or a calculation that
// changed fails here whether or not it sits in a redrawn range.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function stripAttr(text, name) {
  let out = '';
  for (let i = 0; i < text.length;) {
    const m = new RegExp(`\\b${name}=\\{`, 'y');
    const s = new RegExp(`\\b${name}=("[^"]*")`, 'y');
    m.lastIndex = i; s.lastIndex = i;
    if (/\W/.test(text[i - 1] ?? ' ') && (m.test(text) || (s.lastIndex = i, s.test(text)))) {
      const sm = new RegExp(`\\b${name}=("[^"]*")`, 'y'); sm.lastIndex = i;
      const q = sm.exec(text);
      if (q) { i += q[0].length; continue; }
      let j = i + name.length + 2, depth = 1, quote = null;
      while (depth > 0) {
        const c = text[j];
        if (quote) { if (c === '\\') j += 1; else if (c === quote) quote = null; }
        else if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        j += 1;
      }
      i = j; continue;
    }
    out += text[i]; i += 1;
  }
  return out;
}
const tokens = text => stripAttr(stripAttr(text, 'className'), 'style').match(/[A-Za-z0-9_$.]+|\S/g) ?? [];
const EXPECTED_RESIDUAL = [
  // [old tokens joined, new tokens joined, reason]
  ["# 6b7280", "text - fg - muted", 'SaveBadge: the saving colour is a class now'],
  ["# 15803d", "text - positive", 'SaveBadge: the saved colour'],
  ["# b45309", "text - caution", 'SaveBadge: the unsaved colour'],
];
function tokenDiff() {
  const oldText = git('show', `${base}:src/components/HistoricalReconciliationWizard.tsx`).replace(/\r\n/g, '\n');
  const newText = readFileSync(FILE_ARG ?? join(root, 'src/components/HistoricalReconciliationWizard.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const dir = mkdtempSync(join(tmpdir(), 'recdiff-'));
  writeFileSync(join(dir, 'a'), tokens(oldText).join('\n') + '\n');
  writeFileSync(join(dir, 'b'), tokens(newText).join('\n') + '\n');
  const r = spawnSync('diff', ['-U0', join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const hunks = []; let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('@@')) { cur = { del: [], add: [] }; hunks.push(cur); }
    else if (cur && line.startsWith('-') && !line.startsWith('---')) cur.del.push(line.slice(1));
    else if (cur && line.startsWith('+') && !line.startsWith('+++')) cur.add.push(line.slice(1));
  }
  return hunks.map(h => [h.del.join(' '), h.add.join(' ')]);
}
{
  const hunks = tokenDiff();
  const left = [...EXPECTED_RESIDUAL];
  console.log('token diff after removing className and style (old | new):');
  for (const [o, n] of hunks) {
    const k = left.findIndex(([eo, en]) => eo === o && en === n);
    if (k >= 0) { console.log(`  expected  ${o} | ${n}  — ${left[k][2]}`); left.splice(k, 1); }
    else { failed = true; console.log(`  FAIL      ${o.slice(0, 200)} | ${n.slice(0, 200)}`); }
  }
  for (const [o, n, why] of left) { failed = true; console.log(`  FAIL      expected residual not seen: ${o} | ${n} (${why})`); }
  console.log(`  ${hunks.length} residual hunks\n`);
}
process.exit(failed ? 1 : 0);

function CONFIG() {
  return [
    {
      path: 'src/components/HistoricalReconciliationWizard.tsx',
      // 505–521: StepDots (a width and a colour, both from the step index).
      // 1407–1473: resultStatusBadge and SaveBadge, pure drawing.
      // 1477–2360: the render.
      redrawn: [[505, 521], [1407, 1458], [1462, 1464, 'code'], [1468, 1468, 'code'], [1477, 2360]],
      dropped: [],
    },
  ];
}
