/**
 * deploy.sh's sign-in checks, run for real.
 *
 * The functions between "# >>> google-signin checks" and "# <<< google-signin
 * checks" in deploy/deploy.sh are copied out verbatim, sourced by bash with a
 * stub `fail`, and run against fake .env, kong.yml and /auth/v1/settings
 * answers in a temporary directory. No docker, no host paths.
 *
 * Needs bash with grep, awk and sha256sum; the settings check also needs
 * python3, as deploy.sh does on the host. Where they are missing the tests are
 * skipped, never passed.
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
  const start = script.indexOf('\n# >>> google-signin checks\n');
  const end = script.indexOf('\n# <<< google-signin checks\n');
  if (start < 0 || end < start) throw new Error('deploy.sh lost its google-signin checks markers');
  return script.slice(start, end);
}

function probe(command: string): boolean {
  const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', timeout: 20_000 });
  return result.status === 0 && result.stdout.trim() === 'ok';
}

const hasBash = probe('command -v grep >/dev/null && command -v awk >/dev/null && command -v sha256sum >/dev/null && echo ok');
const hasPython = hasBash && probe('python3 -c "print(1)" >/dev/null 2>&1 && echo ok');

const dir = mkdtempSync(join(tmpdir(), 'google-signin-checks-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, 'checks.sh'), `${checksBlock()}\n`);
writeFileSync(
  join(dir, 'run.sh'),
  [
    'set -euo pipefail',
    'fail() { printf "REFUSED: %s\\n" "$*"; exit 1; }',
    'cd "$(dirname "$0")"',
    'source ./checks.sh',
    // The settings check reports through its exit status; print both.
    'settings_check() { local problems status=0; problems="$(auth_settings_problems "$1")" || status=$?; echo "[$problems] $status"; }',
    '"$@"',
    'echo PASSED',
    '',
  ].join('\n'),
);

let fixture = 0;
function file(content: string): string {
  const path = join(dir, `fixture-${++fixture}`);
  writeFileSync(path, content);
  return path.replace(/\\/g, '/');
}

function run(args: string[], stdin = ''): { output: string; status: number | null } {
  const result = spawnSync('bash', [join(dir, 'run.sh').replace(/\\/g, '/'), ...args], {
    encoding: 'utf8',
    input: stdin,
    timeout: 20_000,
  });
  return { output: `${result.stdout}${result.stderr}`.trim(), status: result.status };
}

const CLIENT = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com';
const OTHER_CLIENT = '210987654321-zyxwvutsrqponmlkjihgfedcba543210.apps.googleusercontent.com';
const SECRET = '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-like-one';
const NO_PEER = join(dir, 'no-such-peer.env').replace(/\\/g, '/');

const env = (lines: string[]) => file(`${lines.join('\n')}\n`);
const guard = (envFile: string, peer = NO_PEER) => run(['google_signin_guard', envFile, peer]);

describe.skipIf(!hasBash)('google_signin_guard', () => {
  it('lets the switch be missing, empty or false without a client', () => {
    for (const lines of [[], ['GOOGLE_SIGNIN_ENABLED='], ['GOOGLE_SIGNIN_ENABLED=false'], ['GOOGLE_SIGNIN_ENABLED=false\r']]) {
      expect(guard(env(lines)).output).toBe('PASSED');
    }
  });

  it('refuses any other value for the switch without printing it', () => {
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', '"true"', "'true'", ' true', 'true ', SECRET]) {
      const { output, status } = guard(env([`GOOGLE_SIGNIN_ENABLED=${value}`, `GOOGLE_CLIENT_ID=${CLIENT}`, `GOOGLE_CLIENT_SECRET=${SECRET}`]));
      expect(status).toBe(1);
      expect(output).toMatch(/^REFUSED: GOOGLE_SIGNIN_ENABLED must be empty, true or false/);
      expect(output).not.toContain(SECRET);
    }
  });

  it('switched on, needs one Google web client id', () => {
    const refusedFor = (clientLine: string[]) =>
      guard(env(['GOOGLE_SIGNIN_ENABLED=true', ...clientLine, `GOOGLE_CLIENT_SECRET=${SECRET}`])).output;
    expect(refusedFor([])).toMatch(/^REFUSED: GOOGLE_SIGNIN_ENABLED=true needs GOOGLE_CLIENT_ID/);
    for (const id of [
      'GOOGLE_CLIENT_ID=',
      'GOOGLE_CLIENT_ID=my-client',
      'GOOGLE_CLIENT_ID=abc-123.apps.googleusercontent.com',
      `GOOGLE_CLIENT_ID=${CLIENT}.evil.example`,
      `GOOGLE_CLIENT_ID=${CLIENT},${OTHER_CLIENT}`,
      `GOOGLE_CLIENT_ID= ${CLIENT}`,
    ]) {
      expect(refusedFor([id])).toMatch(/^REFUSED: GOOGLE_SIGNIN_ENABLED=true needs GOOGLE_CLIENT_ID/);
    }
  });

  it('switched on, needs a secret, and never prints one', () => {
    const { output, status } = guard(env(['GOOGLE_SIGNIN_ENABLED=true', `GOOGLE_CLIENT_ID=${CLIENT}`, 'GOOGLE_CLIENT_SECRET=']));
    expect(status).toBe(1);
    expect(output).toBe('REFUSED: GOOGLE_SIGNIN_ENABLED=true needs GOOGLE_CLIENT_SECRET');
  });

  it('passes a complete client, with or without the other environment present', () => {
    const complete = env(['GOOGLE_SIGNIN_ENABLED=true', `GOOGLE_CLIENT_ID=${CLIENT}\r`, `GOOGLE_CLIENT_SECRET=${SECRET}`]);
    expect(guard(complete).output).toBe('PASSED');
    expect(guard(complete, env([`GOOGLE_CLIENT_ID=${OTHER_CLIENT}`])).output).toBe('PASSED');
    expect(guard(complete, env(['GOOGLE_SIGNIN_ENABLED=false'])).output).toBe('PASSED');
  });

  it('refuses a client id the other environment also uses, switched on or not, without printing it', () => {
    const peer = env(['GOOGLE_SIGNIN_ENABLED=true', `GOOGLE_CLIENT_ID=${CLIENT}`, 'GOOGLE_CLIENT_SECRET=other']);
    for (const lines of [
      ['GOOGLE_SIGNIN_ENABLED=true', `GOOGLE_CLIENT_ID=${CLIENT}`, `GOOGLE_CLIENT_SECRET=${SECRET}`],
      ['GOOGLE_SIGNIN_ENABLED=false', `GOOGLE_CLIENT_ID=${CLIENT}`],
    ]) {
      const { output, status } = guard(env(lines), peer);
      expect(status).toBe(1);
      expect(output).toBe('REFUSED: staging and production share a GOOGLE_CLIENT_ID; each environment needs its own Google OAuth client');
      expect(output).not.toContain(CLIENT);
    }
  });
});

describe.skipIf(!hasBash)('kong_closed_block_guard', () => {
  const kong = repoFile('deploy/kong.yml');
  const guardKong = (text: string) => run(['kong_closed_block_guard', file(text)]);

  it('passes the kong.yml in this repository, with LF or CRLF line ends', () => {
    expect(guardKong(kong).output).toBe('PASSED');
    expect(guardKong(kong.replace(/\n/g, '\r\n')).output).toBe('PASSED');
  });

  it('refuses a kong.yml without the block, or with any part of it missing', () => {
    const service = /\n {2}- name: auth-v1-closed\n[\s\S]*?(?=\n\n {2}# ── Auth ──)/;
    expect(kong).toMatch(service);
    const cases = [
      kong.replace(service, ''),
      kong.replace('          - /auth/v1/otp\n', ''),
      kong.replace('          - /auth/v1/magiclink\n', ''),
      kong.replace('          - /auth/v1/signup\n', ''),
      kong.replace('status_code: 403', 'status_code: 200'),
      kong.replace('- name: request-termination', '- name: request-transformer'),
      kong.replace('  - name: auth-v1-closed\n', '  - name: auth-v1-shut\n'),
      kong.replace(service, (block) => block.replace(/\n/g, '\n#')),
    ];
    for (const text of cases) {
      expect(text).not.toBe(kong);
      const { output, status } = guardKong(text);
      expect(status).toBe(1);
      expect(output).toMatch(/^REFUSED: deploy\/kong\.yml has no complete auth-v1-closed block/);
    }
  });

  it('refuses a missing file', () => {
    expect(run(['kong_closed_block_guard', NO_PEER]).status).toBe(1);
  });
});

describe.skipIf(!hasPython)('auth_settings_problems', () => {
  // GoTrue v2.170.0's answer on staging, 15.09.2026: Google off.
  const OFF = {
    external: {
      anonymous_users: false, apple: false, azure: false, bitbucket: false, discord: false, facebook: false, figma: false,
      fly: false, github: false, gitlab: false, google: false, keycloak: false, kakao: false, linkedin: false,
      linkedin_oidc: false, notion: false, spotify: false, slack: false, slack_oidc: false, workos: false, twitch: false,
      twitter: false, email: true, phone: false, zoom: false,
    },
    disable_signup: true, mailer_autoconfirm: true, phone_autoconfirm: false, sms_provider: '', saml_enabled: false,
  };
  const ON = { ...OFF, external: { ...OFF.external, google: true }, disable_signup: false, mailer_autoconfirm: false };

  const check = (settings: unknown, flag: string) => {
    const text = typeof settings === 'string' ? settings : JSON.stringify(settings);
    return run(['settings_check', flag], text).output;
  };

  it('accepts GoTrue as it runs today for an empty or false switch', () => {
    expect(check(OFF, '')).toBe('[] 0\nPASSED');
    expect(check(OFF, 'false')).toBe('[] 0\nPASSED');
  });

  it('accepts Google on only with signup open and autoconfirm off', () => {
    expect(check(ON, 'true')).toBe('[] 0\nPASSED');
    expect(check(OFF, 'true')).toBe('[disable_signup=true google=false mailer_autoconfirm=true] 1\nPASSED');
    // Google on with signup still closed: what a switch GoTrue reads as on but
    // the entrypoint does not (TRUE, 1) would produce.
    expect(check({ ...ON, disable_signup: true, mailer_autoconfirm: true }, 'true'))
      .toBe('[disable_signup=true mailer_autoconfirm=true] 1\nPASSED');
    expect(check(ON, 'false')).toBe('[disable_signup=false google=true mailer_autoconfirm=false] 1\nPASSED');
  });

  it('reports any other provider, phone, anonymous users or SAML switched on', () => {
    expect(check({ ...OFF, external: { ...OFF.external, github: true, phone: true, anonymous_users: true }, saml_enabled: true }, 'false'))
      .toBe('[anonymous_users=true github=true phone=true saml_enabled=true] 1\nPASSED');
  });

  it('treats no answer, an error page or a partial answer as a failure', () => {
    for (const body of ['', '<html>502 Bad Gateway</html>', '{}', '{"external":{}}', JSON.stringify({ ...OFF, disable_signup: undefined })]) {
      expect(check(body, 'false')).toBe('[no settings answer] 1\nPASSED');
    }
  });
});
