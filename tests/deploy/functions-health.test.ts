/**
 * deploy.sh's edge-function health verdict, run for real.
 *
 * The function between "# >>> functions health checks" and "# <<< functions
 * health checks" in deploy/deploy.sh is copied out verbatim, sourced by bash,
 * and called with the answers a probe can actually receive. No docker, no
 * network, no key, no host paths.
 *
 * What it is guarding: the release must not be called healthy while
 * POST /functions/v1/* cannot be served. A release force-recreates `web` and
 * `functions` together, Docker hands their two addresses back in either order,
 * and Kong — not recreated unless kong.yml changed — keeps dialling the address
 * it resolved earlier until that record expires. It then reaches nginx, which
 * refuses port 9000, and the answer is a 502 in ~130 ms. So the verdict has to
 * turn on the function's own body: a status alone cannot tell the runtime's
 * answer from the gateway's.
 *
 * Needs bash; where it is missing the tests are skipped, never passed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoFile = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function checksBlock(): string {
  const script = repoFile('deploy/deploy.sh');
  const start = script.indexOf('\n# >>> functions health checks\n');
  const end = script.indexOf('\n# <<< functions health checks\n');
  if (start < 0 || end < start) throw new Error('deploy.sh lost its functions health checks markers');
  return script.slice(start, end);
}

function probe(command: string): boolean {
  const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', timeout: 20_000 });
  return result.status === 0 && result.stdout.trim() === 'ok';
}

const hasBash = probe('echo ok');

const dir = mkdtempSync(join(tmpdir(), 'functions-health-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, 'checks.sh'), `${checksBlock()}\n`);
writeFileSync(
  join(dir, 'run.sh'),
  [
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    'source ./checks.sh',
    // Bracketed so that "served, nothing to report" is visible as [] rather than
    // as an empty line that a trim could not be distinguished from a crash.
    'printf "[%s]\\n" "$(functions_probe_problem "$1" "$2")"',
    '',
  ].join('\n'),
);

/** The verdict on one (status, body) pair, bracketed; `[]` means the runtime served it. */
function verdict(status: string, body: string): string {
  const result = spawnSync('bash', [join(dir, 'run.sh').replace(/\\/g, '/'), status, body], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return `${result.stdout}${result.stderr}`.trim();
}

/** Exactly what otp-request's invalidRequest() serialises to (_shared/otp-core.ts). */
const OWN_ANSWER = '{"ok":false,"reason":"invalid_request"}';

describe.skipIf(!hasBash)('functions_probe_problem', () => {
  it('passes the function\'s own invalid_request answer, and only that', () => {
    expect(verdict('400', OWN_ANSWER)).toBe('[]');
  });

  it('refuses a 400 that is not the function\'s answer', () => {
    for (const body of ['', '{}', 'Bad Request', '{"ok":false,"reason":"rate_limited"}', '<html>400</html>']) {
      expect(verdict('400', body)).toBe('[HTTP 400, but not the function\'s own invalid_request answer]');
    }
  });

  it('names the gateway for the status the stale-DNS window produces', () => {
    // The whole reason this probe exists: Kong reached nginx, not the runtime.
    expect(verdict('502', '')).toBe('[HTTP 502 from the gateway — Kong did not reach the edge runtime]');
    expect(verdict('503', '')).toBe('[HTTP 503 from the gateway — Kong did not reach the edge runtime]');
    expect(verdict('504', '')).toBe('[HTTP 504 from the gateway — Kong did not reach the edge runtime]');
  });

  it('tells the two router refusals apart', () => {
    expect(verdict('401', '{"error":"Missing or invalid API key"}'))
      .toBe('[HTTP 401 — the router refused the key, so ANON_KEY in .env is not this stack\'s]');
    expect(verdict('404', '{"error":"Unknown function: otp-request"}'))
      .toBe('[HTTP 404 — the router knows no such function, or it has no FUNCTION_ENV entry]');
  });

  it('refuses a 200, however friendly the body', () => {
    // A captive portal or a misrouted SPA answers 200 to anything.
    expect(verdict('200', OWN_ANSWER)).toBe('[HTTP 200, not the function\'s own answer]');
    expect(verdict('200', '<!doctype html>')).toBe('[HTTP 200, not the function\'s own answer]');
  });

  it('treats curl writing no status as not served', () => {
    expect(verdict('000', '')).toBe('[no answer at all]');
    expect(verdict('', '')).toBe('[no answer at all]');
  });

  it('refuses the router\'s own boot failure, which is a JSON 500', () => {
    expect(verdict('500', '{"error":"Function failed to start","request_id":"abc12345"}'))
      .toBe('[HTTP 500, not the function\'s own answer]');
  });
});
