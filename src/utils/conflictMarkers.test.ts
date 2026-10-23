/**
 * No tracked text file carries an unresolved merge conflict.
 *
 * On 23.10.2026 `HANDOFF.md` reached `staging` with `<<<<<<< HEAD`, `=======`
 * and `>>>>>>> be7e7f2` in it, through a pull request whose five CI jobs were
 * all green. Nothing in the gate reads Markdown, so a conflict left in a status
 * document is invisible to every check the project has — and the next branch to
 * merge `staging` inherits the markers and, worse, the mangled text around
 * them: that merge had also left an orphaned entry headline with its body gone.
 *
 * The cost of a marker in a status document is not cosmetic. HANDOFF.md is what
 * the next session reads to learn where things stand, and half an entry reads
 * as a whole one.
 *
 * Scope: every tracked file git itself calls text, which is the same test git
 * uses when it decides whether to merge a file at all. A marker inside a string
 * or an example would be a false positive; there is none today, and if one is
 * ever needed it goes in EXEMPT with its reason, like every other recorded
 * exemption in this repository.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

/** Files allowed to contain a marker-looking line, each with its reason. */
const EXEMPT: { path: string; reason: string }[] = [];

/** Tracked files git does not consider binary. */
function textFiles(): string[] {
  // -z keeps paths with spaces whole; the attribute check is git's own.
  const out = execFileSync('git', ['grep', '-I', '--name-only', '-e', '', '--', '.'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean);
}

const MARKER = /^(<{7}|={7}|>{7})(\s|$)/;

describe('no tracked text file carries an unresolved merge conflict', () => {
  const files = textFiles();

  it('sees the repository at all, so a passing run is not a vacuous one', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('HANDOFF.md');
  });

  it('finds no conflict markers', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (EXEMPT.some(e => e.path === rel)) continue;
      let text: string;
      try { text = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
      // `=======` alone is a Markdown heading underline, so a file is only an
      // offender when it carries an opening or closing marker too.
      if (!/^<{7}(\s|$)/m.test(text) && !/^>{7}(\s|$)/m.test(text)) continue;
      text.split('\n').forEach((line, i) => {
        if (MARKER.test(line)) offenders.push(`${rel}:${i + 1}: ${line.slice(0, 60)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('every recorded exemption still names a tracked file', () => {
    expect(EXEMPT.filter(e => !files.includes(e.path)).map(e => e.path)).toEqual([]);
  });
});
