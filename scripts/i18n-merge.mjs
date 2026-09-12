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
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!dir) {
  console.error('usage: node scripts/i18n-merge.mjs <dir-of-json> [--dry]');
  process.exit(2);
}

const ROOT = path.resolve(import.meta.dirname, '..');
const DE = path.join(ROOT, 'src/i18n/de.ts');
const EN = path.join(ROOT, 'src/i18n/en.ts');

const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/;
const PLACEHOLDER_RE = /\{(\w+)\}/g;

const placeholders = (s) => [...s.matchAll(PLACEHOLDER_RE)].map((m) => m[1]).sort().join(',');

/** Existing keys, so an agent that re-added a shared one is caught. */
function existingKeys(file) {
  const src = readFileSync(file, 'utf8');
  const out = new Map();
  for (const m of src.matchAll(/^\s*'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|`([^`]*)`),?\s*$/gm)) {
    out.set(m[1], (m[2] ?? m[3] ?? '').replace(/\\'/g, "'"));
  }
  return out;
}

const errors = [];
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
    if (typeof val?.de !== 'string' || typeof val?.en !== 'string') {
      errors.push(`${where}: needs both "de" and "en" strings`); continue;
    }
    if (!val.de.trim() || !val.en.trim()) { errors.push(`${where}: empty value`); continue; }
    if (placeholders(val.de) !== placeholders(val.en)) {
      errors.push(`${where}: placeholders differ — de {${placeholders(val.de)}} vs en {${placeholders(val.en)}}`);
      continue;
    }

    const already = deExisting.get(key);
    if (already !== undefined && already !== val.de) {
      errors.push(`${where}: already in de.ts as "${already}" — reuse it, do not redefine`);
      continue;
    }
    if (already !== undefined) continue;   // identical re-add, harmless, skip

    const prior = merged.get(key);
    if (prior && (prior.de !== val.de || prior.en !== val.en)) {
      errors.push(`${where}: collides with ${prior.from} — "${prior.de}" vs "${val.de}"`);
      continue;
    }
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
const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const block = (lang) =>
  keys.map((k) => `  ${(quote(k) + ':').padEnd(pad)} ${quote(merged.get(k)[lang])},`).join('\n');

console.log(`${keys.length} new keys from ${readdirSync(dir).filter((f) => f.endsWith('.json')).length} files`);
const sameInBoth = keys.filter((k) => merged.get(k).de === merged.get(k).en);
console.log(`${sameInBoth.length} identical in both languages (domain vocabulary — expected)`);

if (DRY) { console.log('\n--dry: nothing written'); process.exit(0); }

for (const [file, lang] of [[DE, 'de'], [EN, 'en']]) {
  const src = readFileSync(file, 'utf8');
  const anchor = src.lastIndexOf('} as const;');
  if (anchor < 0) { console.error(`${file}: no closing "} as const;"`); process.exit(1); }
  const insert = `\n  // ── Added by scripts/i18n-merge.mjs ──────────────────────────────────────\n${block(lang)}\n`;
  writeFileSync(file, src.slice(0, anchor) + insert + src.slice(anchor), 'utf8');
  console.log(`  ${path.relative(ROOT, file)} += ${keys.length}`);
}
