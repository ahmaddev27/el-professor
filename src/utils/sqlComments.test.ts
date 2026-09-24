/**
 * Every `.sql` file in this repository must be lexically whole: no block
 * comment, dollar quote or string left open at the end of the file.
 *
 * **PostgreSQL block comments nest**, and that is the whole reason this test
 * exists. A comment that quotes a shell glob for a directory's files — a slash
 * followed by a star — opens a *second* comment inside the first, and nothing
 * closes it: psql swallows the rest of the file and reports an unterminated
 * comment at line 1. `tests/tools/plan-cache-repro.sql` shipped that way once.
 * A comment that quotes the closing delimiter has the mirror problem and ends
 * the comment early, leaving prose to be parsed as SQL. Backticks and quotes
 * around the text do not help: at that point the lexer is inside a comment and
 * knows nothing else.
 *
 * The migrations and the files under `tests/rls/` have a gate already — the RLS
 * kit fails on them, loudly, on the next run. Two things are still worth this
 * test. A `tests/tools/` instrument is run by **nobody**, so it has no gate at
 * all. And the kit runs on the VPS, by hand: a defect it would catch costs a
 * round trip, while this one costs the build a few milliseconds. It is a
 * lexical check and nothing more — it says a file can be read to the end, never
 * that its SQL is valid.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Every `.sql` file under `dir`, recursively, as repository-relative paths. */
function sqlFilesUnder(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.sql')) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  };
  walk(abs);
  return out.sort();
}

type Unclosed = { what: string; line: number } | null;

/**
 * Read `src` the way PostgreSQL's lexer does and report the first thing left
 * open at the end of the file.
 *
 * What it models, because each one changes the answer:
 *
 *  - block comments **nest**, so depth is counted rather than matched;
 *  - inside a block comment nothing else is special — a quote or a `--` there
 *    is ordinary text;
 *  - `--` runs to the end of the line;
 *  - `'…'` and `"…"` double their own delimiter to escape it;
 *  - `$tag$…$tag$` is opaque to everything, which is why a function body full
 *    of prose is not scanned as SQL.
 *
 * Deliberately not modelled: `E'\''`, where a backslash escapes the quote. A
 * file using it would be reported as unterminated — no file in this repository
 * does, and erring towards reporting is the right side here, since a false
 * report fails loudly and is read by a person.
 */
export function firstUnclosed(src: string): Unclosed {
  let i = 0;
  let line = 1;
  let depth = 0;
  const opened: number[] = [];
  const n = src.length;
  const bump = (c: string) => {
    if (c === '\n') line += 1;
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (depth > 0) {
      if (c === '/' && d === '*') {
        depth += 1;
        opened.push(line);
        i += 2;
        continue;
      }
      if (c === '*' && d === '/') {
        depth -= 1;
        opened.pop();
        i += 2;
        continue;
      }
      bump(c);
      i += 1;
      continue;
    }

    if (c === '/' && d === '*') {
      depth += 1;
      opened.push(line);
      i += 2;
      continue;
    }

    if (c === '-' && d === '-') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }

    if (c === "'" || c === '"') {
      const quote = c;
      const start = line;
      i += 1;
      let closed = false;
      while (i < n) {
        if (src[i] === quote && src[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i += 1;
          closed = true;
          break;
        }
        bump(src[i]);
        i += 1;
      }
      if (!closed) {
        return { what: quote === "'" ? 'string literal' : 'quoted identifier', line: start };
      }
      continue;
    }

    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i))?.[0];
      if (tag) {
        const start = line;
        i += tag.length;
        const end = src.indexOf(tag, i);
        if (end < 0) return { what: `dollar quote ${tag}`, line: start };
        for (let k = i; k < end + tag.length; k += 1) bump(src[k]);
        i = end + tag.length;
        continue;
      }
    }

    bump(c);
    i += 1;
  }

  return depth > 0 ? { what: 'block comment', line: opened[0] } : null;
}

describe('the scanner itself', () => {
  it('reads a whole file as whole', () => {
    expect(firstUnclosed('/* a */ SELECT 1;')).toBeNull();
    expect(firstUnclosed("-- /* not a comment opener\nSELECT 'a''b';")).toBeNull();
    expect(firstUnclosed('$fn$ /* unbalanced inside a body is opaque $fn$')).toBeNull();
  });

  it('catches the nested comment that cost a round trip', () => {
    // the glob is built rather than typed, so this test file cannot trip over
    // the very thing it is testing for
    const glob = `tests/rls/${'*'}.sql`;
    expect(firstUnclosed(`/*\n  runs every ${glob} in name order\n*/\nSELECT 1;`))
      .toEqual({ what: 'block comment', line: 1 });
  });

  it('catches an unterminated string and an unterminated dollar quote', () => {
    expect(firstUnclosed("SELECT 'open")).toEqual({ what: 'string literal', line: 1 });
    expect(firstUnclosed('\n$fn$ body')).toEqual({ what: 'dollar quote $fn$', line: 2 });
  });
});

describe('every .sql file in the repository can be read to the end', () => {
  const files = [...sqlFilesUnder('tests'), ...sqlFilesUnder('supabase/migrations')];

  it('finds the files it means to check', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('tests/tools/plan-cache-repro.sql');
    expect(files).toContain('tests/rls/matrix.sql');
  });

  it.each(files)('%s', (file) => {
    const open = firstUnclosed(readFileSync(path.join(ROOT, file), 'utf8'));
    expect(
      open && `${file}: ${open.what} opened at line ${open.line} is never closed`,
    ).toBeNull();
  });
});
