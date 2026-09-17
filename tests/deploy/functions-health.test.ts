/**
 * deploy.sh's edge-function health check: its verdict, run for real, and its
 * wiring, pinned as text.
 *
 * The two halves fail for different reasons, and both had to be covered.
 *
 * **The verdict.** The functions between "# >>> functions health checks" and
 * "# <<< functions health checks" in deploy/deploy.sh are copied out verbatim,
 * sourced by bash, and called with the answers a probe can actually receive. No
 * docker, no network, no key, no host paths.
 *
 * **The wiring.** A verdict nothing calls is worth nothing. The call site is
 * shell that cannot be executed here — it needs a gateway, a release and a live
 * `.env` — and it was measured, against a scratch copy, that deleting the whole
 * call site, or pointing it at /functions/v1/no-such-function and dropping the
 * `fail`, left this file entirely green. So the call site is pinned as text,
 * with deploy.sh's comment lines stripped first, because otherwise prose about
 * the probe could satisfy an assertion the code no longer does. Those
 * assertions are deliberately brittle: a reformat of those lines updates this
 * test in the same commit, with the reason.
 *
 * What all of it is guarding: the release must not be called healthy while
 * POST /functions/v1/* cannot be served. A release force-recreates `web` and
 * `functions` together, Docker hands their two addresses back in either order,
 * and Kong — not recreated unless kong.yml changed — keeps dialling the address
 * it resolved earlier until that record expires. It then reaches nginx, which
 * refuses port 9000, and the answer is a 502 in ~130 ms. So the verdict has to
 * turn on the function's own body: a status alone cannot tell the runtime's
 * answer from the gateway's.
 *
 * Needs bash for the verdict half; where it is missing those tests are skipped,
 * never passed. The wiring half is text and always runs.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { invalidRequest } from '../../supabase/functions/_shared/otp-core.ts';

const repoFile = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const deploySh = repoFile('deploy/deploy.sh');

/**
 * deploy.sh with its comment lines dropped. Every wiring assertion runs against
 * this rather than the whole file, so a line of prose naming the route cannot
 * stand in for a probe that no longer sends one.
 */
const deployCode = deploySh
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

function checksBlock(): string {
  const start = deploySh.indexOf('\n# >>> functions health checks\n');
  const end = deploySh.indexOf('\n# <<< functions health checks\n');
  if (start < 0 || end < start) throw new Error('deploy.sh lost its functions health checks markers');
  return deploySh.slice(start, end);
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
writeFileSync(
  join(dir, 'stale.sh'),
  [
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    'source ./checks.sh',
    'if functions_probe_is_stale_upstream "$1"; then echo "[yes]"; else echo "[no]"; fi',
    '',
  ].join('\n'),
);

const runner = (name: string, args: string[]): string => {
  const result = spawnSync('bash', [join(dir, name).replace(/\\/g, '/'), ...args], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return `${result.stdout}${result.stderr}`.trim();
};

/** The verdict on one (status, body) pair, bracketed; `[]` means the runtime served it. */
const verdict = (status: string, body: string): string => runner('run.sh', [status, body]);

/** Whether the probe would spend its one `kong reload` on this status. */
const staleUpstream = (status: string): string => runner('stale.sh', [status]);

/**
 * Derived, never copied. deploy.sh greps for the substring otp-request puts on
 * the wire, so if invalidRequest() ever changes its reason or its status, the
 * probe stops recognising the function's own answer and **every** future release
 * of both environments fails at that step. A hand-copied literal here would have
 * stayed green through exactly that change.
 */
const OWN_STATUS = String(invalidRequest().status);
const OWN_ANSWER = JSON.stringify(invalidRequest().body);
const OWN_REASON = `"reason":${JSON.stringify(String(invalidRequest().body.reason))}`;

describe('the verdict is pinned to what otp-request actually answers', () => {
  it('greps for the substring invalidRequest() produces, on the status it produces', () => {
    expect(checksBlock()).toContain(OWN_REASON);
    expect(checksBlock()).toMatch(new RegExp(`^\\s*${OWN_STATUS}\\)`, 'm'));
  });
});

describe.skipIf(!hasBash)('functions_probe_problem', () => {
  it('passes the function\'s own invalid_request answer, and only that', () => {
    expect(verdict(OWN_STATUS, OWN_ANSWER)).toBe('[]');
  });

  it('refuses a 400 that is not the function\'s answer', () => {
    for (const body of ['', '{}', 'Bad Request', '{"ok":false,"reason":"rate_limited"}', '<html>400</html>']) {
      expect(verdict(OWN_STATUS, body)).toBe(
        `[HTTP ${OWN_STATUS}, but not the function's own invalid_request answer]`,
      );
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

describe.skipIf(!hasBash)('functions_probe_is_stale_upstream', () => {
  it('is exactly the statuses the verdict blames on the gateway', () => {
    for (const status of ['502', '503', '504']) {
      expect(staleUpstream(status)).toBe('[yes]');
      expect(verdict(status, '')).toContain('from the gateway');
    }
  });

  it('is nothing else — including "no answer", where the gateway may itself be down', () => {
    for (const status of [OWN_STATUS, '401', '404', '200', '500', '000', '']) {
      expect(staleUpstream(status)).toBe('[no]');
      expect(verdict(status, '')).not.toContain('from the gateway');
    }
  });
});

describe('deploy.sh calls the probe', () => {
  it('POSTs {} to otp-request through the public URL, with the anon key', () => {
    expect(deployCode).toContain('curl -s --max-time 30 -X POST "$PUBLIC_URL/functions/v1/otp-request"');
    expect(deployCode).toContain('-H "apikey: $fn_anon_key"');
    expect(deployCode).toContain("-d '{}'");
  });

  it('feeds that answer to the verdict, and fails the release on a problem', () => {
    expect(deployCode).toContain('fn_problem="$(functions_probe_problem "$fn_status"');
    expect(deployCode).toMatch(/\[ -z "\$fn_problem" \] \|\| fail /);
  });

  it('reloads Kong once, and only after an answer that says it could not reach the runtime', () => {
    // Gated so the one thing in a release that touches the live gateway's state
    // never runs on a release that is fine, and never runs twice.
    expect(deployCode).toContain('if [ -z "$fn_reload" ] && functions_probe_is_stale_upstream "$fn_status"; then');
    expect(deployCode).toContain('dc exec -T kong kong reload');
  });

  it('bounds the wait by the clock rather than by a count of tries', () => {
    // A try can itself take --max-time, so 30 tries is not a duration.
    expect(deployCode).toContain('fn_deadline=$(( SECONDS + FN_PROBE_BUDGET ))');
    expect(deployCode).toContain('if [ "$SECONDS" -ge "$fn_deadline" ]; then break; fi');
  });

  it('does not probe a function the release does not ship', () => {
    // --activate can bring back a tree older than otp-request, which would 404
    // for the whole budget and fail a rollback for the wrong reason.
    expect(deployCode).toContain('[ ! -f "$ROOT/supabase/functions/otp-request/index.ts" ]');
  });
});
