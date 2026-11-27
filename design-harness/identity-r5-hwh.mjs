#!/usr/bin/env node
/**
 * R5, HistoricalWorkingHoursWizard.tsx, proven as text.
 *
 *   node design-harness/identity-r5-hwh.mjs [--base <commit>] [--new <path>]
 *
 * The screen was redrawn by a mechanical pass: every inline `style={{…}}` became
 * Tailwind token classes in `className`. A look-only change of that kind has a
 * stronger proof than batch 3's "carried expressions" list:
 *
 *   1. STRIP. In both the base file and the working file, every JSX attribute
 *      named `className` or `style` is removed (balanced, by the TypeScript
 *      parser, not by regex). Those two attributes hold everything that was
 *      repainted, including the conditions that chose a colour.
 *   2. TOKENISE. What is left is cut into whitespace-separated tokens, one per
 *      line, so a re-indented line is not a change.
 *   3. DIFF. The two token streams are compared with `diff`. Every hunk that
 *      remains must be matched by one entry of ALLOWED below, which names the
 *      old tokens, the new tokens and the reason. An unmatched hunk fails the
 *      run, and so does an entry that matched nothing (a stale claim).
 *
 * So every handler, guard, query, engine call, calculation, format and `t(...)`
 * of the old file is present, in the same order, in the new one. The only text
 * that may differ is the list below, and all of it is the look of a value that a
 * second line of code reads.
 *
 * Run a negative control first: `--new` takes any other file, and the script
 * must fail on one in which a single comparison or constant was changed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const ts = require('typescript');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const base = arg('--base') ?? git('merge-base', 'HEAD', 'origin/staging').trim();
const PATH = 'src/components/HistoricalWorkingHoursWizard.tsx';

const STRIPPED = new Set(['className', 'style']);

function strip(text) {
  const sf = ts.createSourceFile(PATH, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const cuts = [];
  const visit = node => {
    if (ts.isJsxAttribute(node) && STRIPPED.has(node.name.text)) cuts.push([node.getFullStart(), node.getEnd()]);
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  let out = '';
  let at = 0;
  for (const [from, to] of cuts) { out += text.slice(at, from); at = to; }
  return { text: out + text.slice(at), removed: cuts.length };
}

/** The `style` attributes a text still carries, squashed. */
function styleAttributes(text) {
  const sf = ts.createSourceFile(PATH, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = node => {
    if (ts.isJsxAttribute(node) && node.name.text === 'style') {
      const object = node.initializer?.expression;
      if (object && ts.isObjectLiteralExpression(object)) object.properties.forEach(property => found.push(property.getText(sf).replace(/\s+/g, '')));
      else found.push(node.getText(sf).replace(/\s+/g, ''));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const tokens = text => text.split(/\s+/).filter(Boolean);

const oldText = git('show', `${base}:${PATH}`).replace(/\r\n/g, '\n');
const newText = readFileSync(arg('--new') ?? join(root, PATH), 'utf8').replace(/\r\n/g, '\n');
const oldStripped = strip(oldText);
const newStripped = strip(newText);
const dir = mkdtempSync(join(tmpdir(), 'hwh-proof-'));
writeFileSync(join(dir, 'old'), tokens(oldStripped.text).join('\n') + '\n');
writeFileSync(join(dir, 'new'), tokens(newStripped.text).join('\n') + '\n');

let raw = '';
try { execFileSync('diff', ['--unchanged-line-format=', '--old-line-format=-%L', '--new-line-format=+%L', join(dir, 'old'), join(dir, 'new')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
catch (error) { raw = error.stdout ?? ''; }

// Hunks: the unified diff, so the position and the neighbours are visible.
let unified = '';
try { execFileSync('diff', ['-U0', join(dir, 'old'), join(dir, 'new')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
catch (error) { unified = error.stdout ?? ''; }
const hunks = [];
let current = null;
for (const line of unified.split('\n')) {
  if (line.startsWith('@@')) { current = { removed: [], added: [] }; hunks.push(current); }
  else if (current && line.startsWith('-') && !line.startsWith('---')) current.removed.push(line.slice(1));
  else if (current && line.startsWith('+') && !line.startsWith('+++')) current.added.push(line.slice(1));
}

// ── The only text allowed to differ ─────────────────────────────────────────
// Each entry: `old` and `new` are regular expressions over the hunk's tokens
// joined by one space; `reason` says why the look of a value moved with it.
const OLD_COLOUR = /^(INHABER_COLOR|'(?:#[0-9a-fA-F]{3,8}|var\(--[a-z-]+(?:,[^)]*)?\)|rgba?\([^)]*\))')([,;)]*)$/;
const NEW_COLOUR = /^'((?:text|bg|border)-[\w[\].\/-]+|rgb\(var\(--[a-z-]+\)\))'([,;)]*)$/;

/** A colour literal replaced one for one by a token class (or a token variable): the value a second line of code reads. */
function colourSwap(hunk) {
  if (!hunk.removed.length || hunk.removed.length !== hunk.added.length) return false;
  return hunk.removed.every((token, i) => {
    const before = OLD_COLOUR.exec(token);
    const after = NEW_COLOUR.exec(hunk.added[i]);
    return before && after && before[2] === after[2];
  });
}

const ALLOWED = [
  { name: 'colour literal -> token class', test: colourSwap, reason: 'STATUS_COLORS, the stat cards\' `color`, statusColor, decisionColor, headerColor, dColor (decision), statusColors: each held a colour that a style attribute painted; it now holds the token class its className writes. Same condition, same position.' },
  ...[
    ["INHABER_COLOR = '#7c3aed'; const", '', 'the owner colour constant: its last readers (stat cards, badges) now name `text-violet` and the violet token classes, so it is unused'],
    ["'#15803d'", "'bg-positive-soft text-positive border-positive/30'", 'badgeColor, the window badge: one colour that a style attribute used three times (fill, text, outline) is now the three token classes, written by one className'],
    ["'#0891b2' : '#9ca3af';", "'bg-brand-soft text-brand-text border-brand/30' : 'bg-sunken text-fg-subtle border-edge';", 'badgeColor, the other two branches'],
    ['', 'badge: string;', 'statusColors: the status badge was filled with the border colour; a class cannot serve as both, so the map names the badge fill'],
    ["'rgba(21,128,61,0.25)',", "'border-positive/25', badge: 'bg-positive/25',", 'statusColors, ok: border and badge fill as token classes'],
    ["'rgba(220,38,38,0.3)',", "'border-critical/30', badge: 'bg-critical/30',", 'statusColors, below_min'],
    ["'rgba(217,119,6,0.35)',", "'border-caution/35', badge: 'bg-caution/35',", 'statusColors, above_max'],
    ['inp: React.CSSProperties', 'inp', 'the date selects\' and the rate table\'s input look, a style object, is a class string now'],
    ["{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.375rem', color: 'var(--text-primary)', fontSize: '0.8rem', padding: '0.3rem 0.5rem', outline: 'none', width: '100%', };", "'rounded-md border border-edge bg-sunken px-2 py-1 text-[0.8rem] text-fg outline-none';", 'the same object as classes (the width went to each field, which names w-full or w-auto)'],
    ['React.CSSProperties', 'string', 'nodeStyle, the auto-run step node\'s look (two screens): a style object is a class string now'],
    ["{ background: 'rgba(21,128,61,0.08)', border: '1.5px solid #16a34a' }", "'bg-positive-soft/60 border-[1.5px] border-positive'", 'nodeStyle, a finished step'],
    ["{ background: 'rgba(37,99,235,0.10)', border: '1.5px solid #2563eb', boxShadow: '0 0 0 3px rgba(37,99,235,0.12)' } : { background: 'var(--bg-subtle)', border: '1.5px solid var(--border)' };", "'bg-info-soft border-[1.5px] border-info ring-[3px] ring-info/15' : 'bg-sunken border-[1.5px] border-edge';", 'nodeStyle, the running step and the waiting step'],
    ["{ background: 'rgba(37,99,235,0.10)', border: '1.5px solid #2563eb', boxShadow: '0 0 0 3px rgba(37,99,235,0.10)' } : { background: 'var(--bg-subtle)', border: '1.5px solid var(--border)' };", "'bg-info-soft border-[1.5px] border-info ring-[3px] ring-info/15' : 'bg-sunken border-[1.5px] border-edge';", 'the same, the phone layout'],
    ["stroke={done ? '#16a34a' : 'var(--text-tertiary, #9ca3af)'}", 'stroke="currentColor"', 'an arrow\'s stroke colour: the svg\'s className now carries the same condition as a text colour'],
    ["stroke={autoRunStepIndex >= 5 ? '#16a34a' : 'var(--border)'}", 'stroke="currentColor"', 'a connector\'s stroke colour: likewise'],
  ].map(([from, to, reason]) => ({
    name: `${from.slice(0, 40)} -> ${to.slice(0, 40)}`,
    test: hunk => hunk.removed.join(' ') === from && hunk.added.join(' ') === to,
    reason,
  })),
];

const matched = new Set();
const unmatched = [];
const describe = hunk => `- ${hunk.removed.join(' ').slice(0, 220)}\n    + ${hunk.added.join(' ').slice(0, 220)}`;
for (const hunk of hunks) {
  const hit = ALLOWED.find(entry => entry.test(hunk));
  if (hit) matched.add(hit.name);
  else unmatched.push(hunk);
}

// A `style` that survives is data (a width computed from a figure, a driver's series colour). Its
// expressions were stripped above, so each property must be in the old file as it stands, except the one
// default colour written as a token below.
const oldSquashed = oldText.replace(/\s+/g, '');
const SURVIVOR_REWRITES = [["'rgb(var(--fg))'", "'var(--text-primary)'"]];
const survivors = styleAttributes(newText);
const strayStyles = survivors.filter(attr => {
  const restored = SURVIVOR_REWRITES.reduce((text, [now, was]) => text.replace(now, was), attr);
  return !oldSquashed.includes(restored);
});

console.log(`base ${base.slice(0, 10)}  ${PATH}`);
console.log(`  attributes stripped   old ${oldStripped.removed}, new ${newStripped.removed} (className and style only)`);
console.log(`  tokens compared       old ${tokens(oldStripped.text).length}, new ${tokens(newStripped.text).length}`);
for (const entry of ALLOWED) if (!matched.has(entry.name)) { console.log(`  STALE ${entry.name} matched nothing`); unmatched.push({ removed: ['stale entry'], added: [entry.name] }); }
console.log(`  differing hunks       ${hunks.length}, allowed ${hunks.length - unmatched.length}`);
void raw;
console.log(`  surviving style properties  ${survivors.length}, all present in the old file ${strayStyles.length === 0 ? 'yes' : 'NO'}`);
for (const attr of strayStyles) console.log(`  STYLE not in the old file: ${attr.slice(0, 200)}`);
for (const hunk of unmatched) console.log(`  HUNK ${describe(hunk)}`);
process.exit(unmatched.length || strayStyles.length ? 1 : 0);
