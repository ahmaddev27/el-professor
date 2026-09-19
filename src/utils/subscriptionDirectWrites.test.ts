/**
 * Plan 3.F, step U3: nothing writes the subscription columns of `companies`
 * directly.
 *
 * `subscription_status` and `subscription_expires_at` are derived from
 * `subscription_coverage` by `app_private.recompute_company_subscription`, which
 * derives `plan` too; `platform_company_set_plan` is the one other writer of
 * `plan`, and `redeem_activation_code` and `update_company_subscription_manual`
 * own `subscription_started_at` and `subscription_duration_type`. A browser or
 * an edge function that sets one of them through PostgREST goes past all of it.
 *
 * Migration 20260920120000 refuses such a write in the database. This is the
 * second wall, in the code: it fails the build the day a
 * `.from('companies').update(…)`, `.upsert(…)` or `.insert(…)` naming one of
 * the five appears in the browser or an edge function, so the mistake is caught
 * in review rather than as a 42501 on a customer's screen.
 *
 * A payload this cannot read — a variable, a spread, a computed key — fails
 * too, because nothing here can prove it names none of the five. Write the
 * object inline, or call the RPC that owns the column.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GUARDED_COLUMNS = [
  'subscription_status',
  'subscription_expires_at',
  'subscription_started_at',
  'subscription_duration_type',
  'plan',
] as const;

type WriteMethod = 'update' | 'upsert' | 'insert';

interface DirectWrite {
  method: WriteMethod;
  reason: string;
}

const FROM_COMPANIES = /\.from\(\s*(['"`])companies\1\s*\)/g;
// supabase-js: the write method is called on what `.from()` returned, so it is
// the very next call in the chain.
const WRITE_CALL = /^\s*\.\s*(update|upsert|insert)\s*\(/;

/** Index of the quote that closes the string opening at `start`, or -1. */
function closingQuote(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++;
      continue;
    }
    if (source[i] === quote) return i;
  }
  return -1;
}

/**
 * The text of the first argument of the call whose `(` is at `open`, or null
 * when the brackets do not balance. Strings and comments are skipped while
 * counting brackets, so a `)` inside either does not end the argument early.
 */
function firstArgument(source: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      i = closingQuote(source, i);
      if (i < 0) return null;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) return null;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) return null;
      i++;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') {
      depth++;
    } else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    } else if (c === ',' && depth === 1) {
      return source.slice(open + 1, i);
    }
  }
  return null;
}

/** Why a payload counts as a direct write of a guarded column, or null. */
function payloadProblem(payload: string): string | null {
  const text = payload.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) {
    return `its payload is not an object written inline (${text.slice(0, 40)}), so its columns cannot be read`;
  }
  if (text.includes('...')) return 'its payload spreads another object, so its columns cannot be read';
  // A key in brackets follows `{` or `,`; an array's own `[` follows neither.
  if (/[{,]\s*\[/.test(text)) return 'its payload has a computed key, so its columns cannot be read';

  for (const column of GUARDED_COLUMNS) {
    const asKey = new RegExp(`(^|[{,\\s])(['"]?)${column}\\2\\s*:`);
    const asShorthand = new RegExp(`[{,]\\s*${column}\\s*(?=[,}])`);
    if (asKey.test(text) || asShorthand.test(text)) return `it sets companies.${column}`;
  }
  return null;
}

/** Every `.from('companies')` write in `source` that the rule refuses. */
function findDirectSubscriptionWrites(source: string): DirectWrite[] {
  const found: DirectWrite[] = [];
  for (const match of source.matchAll(FROM_COMPANIES)) {
    const after = (match.index ?? 0) + match[0].length;
    const call = WRITE_CALL.exec(source.slice(after));
    if (!call) continue;

    const method = call[1] as WriteMethod;
    const open = after + call[0].length - 1;
    const payload = firstArgument(source, open);
    const reason = payload === null ? 'its arguments do not parse' : payloadProblem(payload);
    if (reason) found.push({ method, reason });
  }
  return found;
}

const countCompaniesCalls = (source: string): number => [...source.matchAll(FROM_COMPANIES)].length;

describe('the detector', () => {
  const flags = (snippet: string) => findDirectSubscriptionWrites(snippet).map(w => w.reason);

  it('flags each of the five columns set through update', () => {
    for (const column of GUARDED_COLUMNS) {
      expect(flags(`supabase.from('companies').update({ ${column}: x }).eq('id', id)`))
        .toEqual([`it sets companies.${column}`]);
    }
  });

  it('flags a chain spread over lines, in double quotes and in a template literal', () => {
    expect(flags(`await supabase\n  .from("companies")\n  .update({\n    name,\n    subscription_status: 'active',\n  })`))
      .toEqual(['it sets companies.subscription_status']);
    expect(flags('supabase.from(`companies`).update({ plan: "premium" })'))
      .toEqual(['it sets companies.plan']);
  });

  it('flags upsert and insert, a quoted key, a shorthand key and an array of rows', () => {
    expect(flags(`supabase.from('companies').upsert({ id, 'subscription_expires_at': null }, { onConflict: 'id' })`))
      .toEqual(['it sets companies.subscription_expires_at']);
    expect(flags(`supabase.from('companies').insert([{ name }, { name, plan }])`))
      .toEqual(['it sets companies.plan']);
    expect(flags(`supabase.from('companies').update({ subscription_started_at })`))
      .toEqual(['it sets companies.subscription_started_at']);
  });

  it('flags a payload it cannot read: a variable, a spread, a computed key', () => {
    expect(flags(`supabase.from('companies').update(payload)`)).toHaveLength(1);
    expect(flags(`supabase.from('companies').update({ ...form, name })`)).toHaveLength(1);
    expect(flags(`supabase.from('companies').update({ [column]: value })`)).toHaveLength(1);
  });

  it('lets through a read, a delete, and a write of a column the model does not own', () => {
    expect(flags(`supabase.from('companies').select('plan, subscription_status, subscription_expires_at')`)).toEqual([]);
    expect(flags(`supabase.from('companies').delete().eq('id', company.id)`)).toEqual([]);
    expect(flags(`supabase.from('companies').update({ name: 'x', billing_cycle: 'yearly' }).eq('id', id)`)).toEqual([]);
    expect(flags(`supabase.from('companies').update({ note: 'plan' })`)).toEqual([]);
  });

  it('lets through the same columns on another table', () => {
    expect(flags(`supabase.from('subscription_coverage').update({ plan: 'premium' })`)).toEqual([]);
    expect(flags(`supabase.from('companies_archive').update({ subscription_status: 'x' })`)).toEqual([]);
  });

  it('is not fooled by a bracket inside a string or a comment', () => {
    expect(flags(`supabase.from('companies').update({ name: ')', /* ) */ plan: 'basic' })`))
      .toEqual(['it sets companies.plan']);
  });
});

describe('the browser and the edge functions', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const self = fileURLToPath(import.meta.url);
  const trees = ['src', join('supabase', 'functions')];
  const sourceFile = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

  const filesUnder = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      if (entry.name === 'node_modules') return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return filesUnder(path);
      // This file plants the writes its detector must find.
      return sourceFile.test(entry.name) && path !== self ? [path] : [];
    });

  const scanned = trees.map(tree => ({ tree, files: filesUnder(join(root, tree)) }));

  it('reaches both trees, and the companies calls in them, so a pass is not a scan of nothing', () => {
    for (const { tree, files } of scanned) {
      expect(files.length, `files under ${tree}`).toBeGreaterThan(0);
    }
    const calls = scanned
      .flatMap(({ files }) => files)
      .reduce((sum, file) => sum + countCompaniesCalls(readFileSync(file, 'utf8')), 0);
    expect(calls).toBeGreaterThan(0);
  });

  it('write none of the five subscription columns of companies directly', () => {
    const offenders = scanned
      .flatMap(({ files }) => files)
      .flatMap(file =>
        findDirectSubscriptionWrites(readFileSync(file, 'utf8')).map(
          w => `${relative(root, file).split('\\').join('/')}: .from('companies').${w.method}(…) — ${w.reason}`,
        ),
      );
    expect(offenders).toEqual([]);
  });
});
