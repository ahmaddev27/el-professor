#!/usr/bin/env node
/**
 * Prove whether supabase/migrations/ can reproduce the production schema.
 *
 * Four tables — companies, drivers, receipts, saved_stundennachweise — are only
 * ever ALTERed in the chain, never CREATEd. The live schema was partly built by
 * hand outside version control, so a fresh database built from the chain does
 * NOT match production. Until it does, the project cannot be moved to a VPS:
 * you cannot migrate a schema you cannot reproduce.
 *
 * Usage:
 *
 *   1. Dump production (authoritative source — nothing here guesses):
 *        pg_dump --schema-only --no-owner --no-acl \
 *          --schema=public "$PROD_URL" > schema-prod.sql
 *
 *   2. Build a scratch database from the chain alone and dump it:
 *        createdb chain_check
 *        for f in supabase/migrations/*.sql; do psql -q chain_check -f "$f"; done
 *        pg_dump --schema-only --no-owner --no-acl \
 *          --schema=public chain_check > schema-chain.sql
 *
 *   3. Compare:
 *        node scripts/schema-diff.mjs schema-prod.sql schema-chain.sql
 *
 * The chain is complete when this reports no missing tables and no missing
 * columns. Step 2 of the migration plan cannot start before then.
 */

import { readFileSync, existsSync } from 'node:fs';

const [prodPath, chainPath] = process.argv.slice(2);

if (!prodPath || !chainPath) {
  console.error('usage: node scripts/schema-diff.mjs <schema-prod.sql> <schema-chain.sql>');
  process.exit(2);
}
for (const p of [prodPath, chainPath]) {
  if (!existsSync(p)) {
    console.error(`not found: ${p}`);
    process.exit(2);
  }
}

/**
 * Parse `CREATE TABLE x (...)` blocks out of a pg_dump.
 * pg_dump emits a predictable shape: one column per line, indented, comma-separated.
 */
function parseTables(sql) {
  const tables = new Map();
  const re = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?([a-z_0-9]+)"?\s*\(([\s\S]*?)\n\);/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    const cols = new Map();
    for (const raw of m[2].split('\n')) {
      const line = raw.trim().replace(/,$/, '');
      if (!line) continue;
      // Skip table-level constraints; they are compared separately.
      if (/^(CONSTRAINT|PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|EXCLUDE)\b/i.test(line)) continue;
      const cm = /^"?([a-z_0-9]+)"?\s+(.+)$/i.exec(line);
      if (cm) cols.set(cm[1], cm[2].replace(/\s+/g, ' ').trim());
    }
    tables.set(name, cols);
  }
  return tables;
}

/** Constraint and index names, which carry uniqueness and FK intent. */
function parseNamed(sql, kind) {
  const set = new Set();
  const patterns = {
    index: /CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"?([a-z_0-9]+)"?/gi,
    constraint: /ADD CONSTRAINT "?([a-z_0-9]+)"?/gi,
  };
  let m;
  while ((m = patterns[kind].exec(sql)) !== null) set.add(m[1]);
  return set;
}

const prodSql = readFileSync(prodPath, 'utf8');
const chainSql = readFileSync(chainPath, 'utf8');

const prod = parseTables(prodSql);
const chain = parseTables(chainSql);

let problems = 0;

console.log(`production: ${prod.size} tables`);
console.log(`chain:      ${chain.size} tables\n`);

// ── Tables the chain cannot build ──────────────────────────────────────────
const missingTables = [...prod.keys()].filter(t => !chain.has(t)).sort();
if (missingTables.length) {
  problems += missingTables.length;
  console.log(`MISSING TABLES (${missingTables.length}) — the chain never creates these:`);
  for (const t of missingTables) {
    console.log(`\n  ${t}  (${prod.get(t).size} columns)`);
    for (const [col, def] of prod.get(t)) console.log(`      ${col.padEnd(34)} ${def}`);
  }
  console.log('');
}

// ── Column drift on tables both sides have ─────────────────────────────────
const columnProblems = [];
for (const [table, prodCols] of prod) {
  const chainCols = chain.get(table);
  if (!chainCols) continue;

  for (const [col, def] of prodCols) {
    if (!chainCols.has(col)) columnProblems.push(`  ${table}.${col}  MISSING from chain  (prod: ${def})`);
    else if (chainCols.get(col) !== def) {
      columnProblems.push(`  ${table}.${col}  DIFFERS\n      prod:  ${def}\n      chain: ${chainCols.get(col)}`);
    }
  }
  for (const col of chainCols.keys()) {
    if (!prodCols.has(col)) columnProblems.push(`  ${table}.${col}  exists only in the chain (drifted or already removed in prod)`);
  }
}
if (columnProblems.length) {
  problems += columnProblems.length;
  console.log(`COLUMN DIFFERENCES (${columnProblems.length}):`);
  columnProblems.forEach(p => console.log(p));
  console.log('');
}

// ── Constraints and indexes ────────────────────────────────────────────────
for (const kind of ['constraint', 'index']) {
  const a = parseNamed(prodSql, kind);
  const b = parseNamed(chainSql, kind);
  const missing = [...a].filter(x => !b.has(x)).sort();
  if (missing.length) {
    problems += missing.length;
    console.log(`MISSING ${kind.toUpperCase()}S (${missing.length}):`);
    missing.forEach(x => console.log(`  ${x}`));
    console.log('');
  }
}

if (problems === 0) {
  console.log('The chain reproduces production. Safe to build a new database from migrations alone.');
  process.exit(0);
}

console.log(`${problems} difference(s). Write migrations closing each one, then re-run.`);
console.log('Until this exits clean, a VPS move would silently ship a different schema.');
process.exit(1);
