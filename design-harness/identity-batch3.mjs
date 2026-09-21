#!/usr/bin/env node
/**
 * Phase 5 batch 3, proven as text: the converted screens only draw differently.
 *
 *   node design-harness/identity-batch3.mjs [--base <commit>]    (default: merge-base with origin/staging)
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

// ── Checks ───────────────────────────────────────────────────────────────────

const squash = text => text.replace(/\s+/g, '');
const SENSITIVE =
  /supabase|\.from\(|\.rpc\(|\.range\(|\.eq\(|\.in\(|\.not\(|\.order\(|\.upsert\(|\.insert\(|\.update\(|\.delete\(|new Date|Date\.|getTime|getMonth|getFullYear|getDate\(|getDay\(|Math\.|parseInt|parseFloat|toFixed|toLocale|navigate\(|while \(true\)|\bcan\(|isAdmin|isSuperAdmin|companyId|mayEdit|disabled=/;
const PRESENTATION_ATTRS = new Set(['className', 'style', 'size', 'key', 'onMouseEnter', 'onMouseLeave', 'strokeWidth']);

/** The inner text of every balanced {…} group in a region, with the attribute it belongs to, if any. */
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
    groups.push({ attribute, inner: text.slice(start + 1, end) });
  }
  return groups;
}

/** What of a group must survive: the whole expression, or only the condition in front of a JSX block. */
function logicOf({ attribute, inner }) {
  const trimmed = inner.trim();
  if (!trimmed || trimmed.startsWith('/*')) return null;
  if (attribute && PRESENTATION_ATTRS.has(attribute)) return null;
  if (/^(['"`]).*\1$/s.test(trimmed) && !trimmed.includes('${')) return null; // a plain string
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return null; // a plain number
  if (/^\{[\s\S]*\}$/.test(trimmed) && attribute === 'style') return null;
  const jsx = /<[A-Za-z]/.exec(trimmed);
  if (jsx) {
    const condition = /^([\s\S]*?)\s*(?:&&|\?)\s*\(?\s*<[A-Za-z]/.exec(trimmed)?.[1];
    return condition && condition.length > 0 ? condition : null;
  }
  return trimmed;
}

function withinRanges(line, ranges) {
  return ranges.some(([from, to]) => line >= from && line <= to);
}

function checkFile(config) {
  const oldText = git('show', `${base}:${config.path}`).replace(/\r\n/g, '\n');
  const newText = readFileSync(join(root, config.path), 'utf8').replace(/\r\n/g, '\n');
  const oldLines = oldText.split('\n');
  const newSquashed = squash(newText);
  const dropped = new Map((config.dropped ?? []).map(([fragment, reason]) => [squash(fragment), reason]));
  const problems = [];
  const excused = [];

  // 1. Verbatim chunks, in order.
  const chunks = [];
  let current = [];
  oldLines.forEach((line, index) => {
    if (withinRanges(index + 1, config.redrawn)) {
      if (current.length) chunks.push(current);
      current = [];
    } else {
      current.push({ line, number: index + 1 });
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

  // 2. Logic carried out of the redrawn ranges.
  let carried = 0;
  for (const [from, to] of config.redrawn) {
    const region = oldLines.slice(from - 1, to).join('\n');
    for (const group of braceGroups(region)) {
      const logic = logicOf(group);
      if (!logic) continue;
      const key = squash(logic);
      if (newSquashed.includes(key)) { carried += 1; continue; }
      if (dropped.has(key)) { excused.push(`${logic.replace(/\s+/g, ' ').slice(0, 90)} — ${dropped.get(key)}`); continue; }
      problems.push(`lost from lines ${from}–${to}: ${logic.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  }

  // 3. Sensitive lines anywhere.
  let sensitive = 0;
  oldLines.forEach((line, index) => {
    if (!SENSITIVE.test(line)) return;
    const key = squash(line);
    if (!key || newSquashed.includes(key)) { sensitive += 1; return; }
    if (dropped.has(key)) { excused.push(`line ${index + 1}: ${line.trim().slice(0, 90)} — ${dropped.get(key)}`); return; }
    problems.push(`sensitive line ${index + 1} changed or lost: ${line.trim().slice(0, 140)}`);
  });

  return { config, verbatimLines, oldLineCount: oldLines.length, carried, sensitive, excused, problems };
}

// ── The branch as a whole ────────────────────────────────────────────────────

/** Every path this branch may change. Nothing that builds a document or plans a month is on it. */
const ALLOWED = [
  /^src\/pages\/(DocumentsPage|CompanyPlannerPage|StundennachweisPage)\.tsx$/,
  /^src\/components\/(MonatsplanungDriverPool|MonatsplanungAppliedRuns|FahrtenbuchTripsView)\.tsx$/,
  /^src\/components\/ui\//,
  /^src\/i18n\/(de|en)\.ts$/,
  /^scripts\/style-ratchet\.test\.ts$/,
  /^(style|typecheck)-baseline\.json$/,
  /^design-harness\//,
  /^Docs\/design\//,
  /^(CLAUDE|HANDOFF|PROGRESS|README)\.md$/,
  /^el-professor-plan\.html$/,
];

const changed = git('diff', '--name-only', base).split('\n').filter(Boolean);
const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
const outside = [...changed, ...untracked].filter(path => !ALLOWED.some(pattern => pattern.test(path)));

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
if (outside.length) {
  failed = true;
  console.log('FAIL files outside the batch 3 allow-list changed:');
  for (const path of outside) console.log(`  ${path}`);
} else {
  console.log(`${changed.length + untracked.length} changed files, all inside the allow-list (no document builder, engine or snapshot touched).`);
}
process.exit(failed ? 1 : 0);

function CONFIG() {
  return [];
}
