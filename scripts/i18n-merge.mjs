#!/usr/bin/env node
/**
 * Merge per-agent translation files into the two dictionaries.
 *
 * Six agents convert screens in parallel. They cannot all edit `src/i18n/de.ts`
 * and `en.ts` without clobbering each other, so each writes
 * `{ "key": { "de": "…", "en": "…" } }` to its own JSON file and this merges
 * them in one pass.
 *
 * The merge is the checkpoint, not a copy step. It refuses to write when:
 *
 *   - two agents define the same key with different text — a real collision,
 *     and taking either one silently would change a screen nobody looked at;
 *   - a key already exists in `de.ts` with different text, which means an agent
 *     re-added a shared key instead of reusing it;
 *   - a `{placeholder}` appears in one language and not the other, which
 *     renders as literal braces to the user;
 *   - `en` is missing, empty, or the key is not a plain dotted identifier.
 *
 * A German value repeated verbatim in `en` is fine and deliberate: domain terms
 * (Beleg, Fahrtenbuch, Stundennachweis) stay German in both dictionaries.
 *
 *   node scripts/i18n-merge.mjs <dir>       # write
 *   node scripts/i18n-merge.mjs <dir> --dry # report only
 *
 * ## Arabic (src/i18n/ar.ts, since 27.11.2026)
 *
 * An entry may also carry `"ar"`: `{ "de": "…", "en": "…", "ar": "…" }`. The
 * Arabic goes to `ar.ts`, with the same placeholder set as the German, and the
 * entry is refused when `ar` is empty, uses Arabic-Indic digits (digits stay
 * Latin in every language) or has other placeholders than `de`.
 *
 * An entry that carries ONLY `"ar"` (`{ "ar": "…" }`) must name a key already in
 * `de.ts`; it adds or updates only the Arabic and leaves `de.ts` and `en.ts`
 * untouched.
 *
 *   node scripts/i18n-merge.mjs --ar-import <dir>        # write ar.ts
 *   node scripts/i18n-merge.mjs --ar-import <dir> --dry  # report only
 *
 * `--ar-import` reads every JSON file in <dir>, each a flat
 * `{ "key": "arabic text" }`, and merges it over what `ar.ts` holds, writing the
 * whole file with its keys in `de.ts` order. It lists EVERY refusal and writes
 * nothing when there is one: an unknown key (not in `de.ts`), a placeholder set
 * that differs from the German, an empty value, an Arabic-Indic digit, a value
 * that is not a string, or two files giving one key different text.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const AR_IMPORT = process.argv.includes('--ar-import');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dir = positional[0];
const DRY = process.argv.includes('--dry');
if (!dir) {
  console.error('usage: node scripts/i18n-merge.mjs <dir-of-json> [--dry]');
  console.error('       node scripts/i18n-merge.mjs --ar-import <dir-of-flat-json> [--dry]');
  process.exit(2);
}

// I18N_MERGE_ROOT lets the tests run the script against a scratch tree.
const ROOT = process.env.I18N_MERGE_ROOT ?? path.resolve(import.meta.dirname, '..');
const DE = path.join(ROOT, 'src/i18n/de.ts');
const EN = path.join(ROOT, 'src/i18n/en.ts');
const AR = path.join(ROOT, 'src/i18n/ar.ts');
const AR_OPEN = 'export const ar: PartialDictionary = {';
// Arabic-Indic and Extended Arabic-Indic digits: figures stay Latin everywhere.
const ARABIC_DIGIT_RE = /[\u0660-\u0669\u06F0-\u06F9]/;

const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/;
const PLACEHOLDER_RE = /\{(\w+)\}/g;

const placeholders = (s) => [...s.matchAll(PLACEHOLDER_RE)].map((m) => m[1]).sort().join(',');

/** Existing keys, so an agent that re-added a shared one is caught. */
function existingKeys(file) {
  const src = readFileSync(file, 'utf8');
  const out = new Map();
  for (const m of src.matchAll(/^\s*'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|`([^`]*)`),?\s*(?:\/\/.*)?$/gm)) {
    out.set(m[1], (m[2] ?? m[3] ?? '').replace(/\\'/g, "'"));
  }
  return out;
}

const UNESCAPES = { n: '\n', r: '\r', t: '\t' };
/** Entries of ar.ts, written by this script, so a quoted single-line shape. */
function existingArabic() {
  const out = new Map();
  const src = readFileSync(AR, 'utf8');
  for (const m of src.matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm)) {
    out.set(m[1], m[2].replace(/\\(.)/g, (_, c) => UNESCAPES[c] ?? c));
  }
  return out;
}

/** Problem with an Arabic value for a key whose German text is `german`, or null. */
function arabicProblem(arabic, german) {
  if (typeof arabic !== 'string') return 'ar must be a string';
  if (!arabic.trim()) return 'empty ar value';
  if (ARABIC_DIGIT_RE.test(arabic)) return 'ar uses Arabic-Indic digits (use Latin digits 0-9)';
  if (placeholders(german) !== placeholders(arabic)) {
    return `placeholders differ — de {${placeholders(german)}} vs ar {${placeholders(arabic)}}`;
  }
  return null;
}

const jsonFiles = () => readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

const quote = (s) =>
  `'${s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}'`;

/** Rewrite ar.ts: its header kept, entries merged over the old ones, in de.ts order. */
function writeArabic(updates, deOrder) {
  const all = existingArabic();
  for (const [k, v] of updates) all.set(k, v);
  const src = readFileSync(AR, 'utf8');
  const open = src.indexOf(AR_OPEN);
  if (open < 0) { console.error(`${AR}: no "${AR_OPEN}" line`); process.exit(1); }
  const ordered = deOrder.filter((k) => all.has(k));
  const body = ordered.map((k) => `  ${quote(k)}: ${quote(all.get(k))},`).join('\n');
  writeFileSync(AR, src.slice(0, open + AR_OPEN.length) + (body ? `\n${body}\n` : '\n') + '};\n', 'utf8');
  console.log(`  ${path.relative(ROOT, AR)} = ${ordered.length} keys (${updates.size} added or updated)`);
}

if (AR_IMPORT) {
  const arErrors = [];
  const imported = new Map();
  const knownDe = existingKeys(DE);
  for (const f of jsonFiles()) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); }
    catch (err) { arErrors.push(`${f}: not valid JSON — ${err.message}`); continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      arErrors.push(`${f}: must be a flat { "key": "arabic text" } object`); continue;
    }
    for (const [key, val] of Object.entries(parsed)) {
      const where = `${f}:${key}`;
      if (!knownDe.has(key)) { arErrors.push(`${where}: unknown key (not in de.ts)`); continue; }
      const problem = arabicProblem(val, knownDe.get(key));
      if (problem) { arErrors.push(`${where}: ${problem}`); continue; }
      const prior = imported.get(key);
      if (prior && prior.text !== val) { arErrors.push(`${where}: collides with ${prior.from} — different Arabic text`); continue; }
      imported.set(key, { text: val, from: f });
    }
  }
  if (arErrors.length) {
    console.error(`\n${arErrors.length} problem(s), nothing written:\n`);
    for (const e of arErrors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(`${imported.size} Arabic keys from ${jsonFiles().length} files`);
  if (DRY) { console.log('\n--dry: nothing written'); process.exit(0); }
  writeArabic(new Map([...imported].map(([k, v]) => [k, v.text])), [...knownDe.keys()]);
  process.exit(0);
}

const errors = [];
const arabic = new Map();            // key -> Arabic text to add or update
const merged = new Map();            // key -> { de, en, from }
const deExisting = existingKeys(DE);

for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  } catch (err) {
    errors.push(`${f}: not valid JSON — ${err.message}`);
    continue;
  }

  for (const [key, val] of Object.entries(parsed)) {
    const where = `${f}:${key}`;

    if (!KEY_RE.test(key)) { errors.push(`${where}: not a dotted lowercase key`); continue; }
    if (val && typeof val === 'object' && 'ar' in val && !('de' in val) && !('en' in val)) {
      const german = deExisting.get(key);
      if (german === undefined) { errors.push(`${where}: ar-only entry for a key that is not in de.ts`); continue; }
      const problem = arabicProblem(val.ar, german);
      if (problem) errors.push(`${where}: ${problem}`); else arabic.set(key, val.ar);
      continue;
    }
    if (typeof val?.de !== 'string' || typeof val?.en !== 'string') {
      errors.push(`${where}: needs both "de" and "en" strings`); continue;
    }
    if (!val.de.trim() || !val.en.trim()) { errors.push(`${where}: empty value`); continue; }
    if (placeholders(val.de) !== placeholders(val.en)) {
      errors.push(`${where}: placeholders differ — de {${placeholders(val.de)}} vs en {${placeholders(val.en)}}`);
      continue;
    }

    if (val.ar !== undefined) {
      const problem = arabicProblem(val.ar, val.de);
      if (problem) { errors.push(`${where}: ${problem}`); continue; }
    }

    const already = deExisting.get(key);
    if (already !== undefined && already !== val.de) {
      errors.push(`${where}: already in de.ts as "${already}" — reuse it, do not redefine`);
      continue;
    }
    if (already !== undefined) {           // identical re-add, harmless, skip
      if (val.ar !== undefined) arabic.set(key, val.ar);
      continue;
    }

    const prior = merged.get(key);
    if (prior && (prior.de !== val.de || prior.en !== val.en)) {
      errors.push(`${where}: collides with ${prior.from} — "${prior.de}" vs "${val.de}"`);
      continue;
    }
    if (val.ar !== undefined) arabic.set(key, val.ar);
    merged.set(key, { ...val, from: f });
  }
}

if (errors.length) {
  console.error(`\n${errors.length} problem(s), nothing written:\n`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const keys = [...merged.keys()].sort();
const pad = Math.min(Math.max(...keys.map((k) => k.length + 3), 0), 40);
// (`quote` is defined above, shared with the Arabic writer: a real newline inside a
// value would end the literal and take the rest of the file with it.)
const block = (lang) =>
  keys.map((k) => `  ${(quote(k) + ':').padEnd(pad)} ${quote(merged.get(k)[lang])},`).join('\n');

console.log(`${keys.length} new keys from ${readdirSync(dir).filter((f) => f.endsWith('.json')).length} files`);
if (arabic.size) console.log(`${arabic.size} Arabic keys to add or update`);
const sameInBoth = keys.filter((k) => merged.get(k).de === merged.get(k).en);
console.log(`${sameInBoth.length} identical in both languages (domain vocabulary — expected)`);

if (DRY) { console.log('\n--dry: nothing written'); process.exit(0); }

// de.ts closes with `} as const;` because it defines the key type; en.ts is a
// PartialDictionary and closes with a plain `};`. Locating the closing brace
// rather than one spelling of it keeps the merge working on both.
const closingBrace = (src) => {
  const at = Math.max(src.lastIndexOf('\n} as const;'), src.lastIndexOf('\n};'));
  return at < 0 ? -1 : at + 1;
};

// An input with only Arabic must not append an empty block to de.ts and en.ts.
const dictionaries = keys.length === 0 && arabic.size > 0 ? [] : [[DE, 'de'], [EN, 'en']];
for (const [file, lang] of dictionaries) {
  const src = readFileSync(file, 'utf8');
  const anchor = closingBrace(src);
  if (anchor < 0) { console.error(`${file}: no closing brace for the dictionary`); process.exit(1); }
  const insert = `\n  // ── Added by scripts/i18n-merge.mjs ──────────────────────────────────────\n${block(lang)}\n`;
  writeFileSync(file, src.slice(0, anchor) + insert + src.slice(anchor), 'utf8');
  console.log(`  ${path.relative(ROOT, file)} += ${keys.length}`);
}

if (arabic.size) {
  // New German keys were just appended, sorted, after the existing ones.
  writeArabic(arabic, [...existingKeys(DE).keys()]);
}
