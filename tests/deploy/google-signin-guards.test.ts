/**
 * deploy.sh's sign-in checks, run for real.
 *
 * The functions between "# >>> google-signin checks" and "# <<< google-signin
 * checks" in deploy/deploy.sh are copied out verbatim, sourced by bash with a
 * stub `fail`, and run against fake .env, kong.yml, compose and
 * /auth/v1/settings answers in a temporary directory. No docker, no host paths.
 *
 * Needs bash with grep, awk and sha256sum; the settings check, the Kong parse
 * inputs and the redaction also need python3, as deploy.sh does on the host.
 * Where they are missing the tests are skipped, never passed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const freshPath = () => join(dir, `fresh-${++fixture}`).replace(/\\/g, '/');

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
const guard = (envFile: string, peer = NO_PEER, peerName?: string) =>
  run(['google_signin_guard', envFile, peer, ...(peerName === undefined ? [] : [peerName])]);
/** The refusal for a shared client id, up to the per-side problems it ends with. */
const SHARED_REFUSAL =
  'REFUSED: staging and production share a GOOGLE_CLIENT_ID; sharing one Google OAuth client is declared with GOOGLE_CLIENT_SHARED=true in both .env files, and it is';

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

  // Owner decision G3, 17.09.2026: the two environments may share one Google
  // OAuth client, but only when both .env files say so. What that catches is
  // the partial mistake — the other environment's id pasted in while no opt-in
  // was written. A wholesale copy of the other .env brings the opt-in with it
  // and passes here; PROJECT_NAME is what refuses that, before this guard runs.
  describe('a shared client id (owner decision G3)', () => {
    const OPTED_IN = 'GOOGLE_CLIENT_SHARED=true';
    const sameId = (...extra: string[]) => ['GOOGLE_SIGNIN_ENABLED=false', `GOOGLE_CLIENT_ID=${CLIENT}`, ...extra];
    const peerWithId = (...extra: string[]) =>
      env(['GOOGLE_SIGNIN_ENABLED=true', `GOOGLE_CLIENT_ID=${CLIENT}`, 'GOOGLE_CLIENT_SECRET=other', ...extra]);

    it('passes when both sides opted in, switched on or not', () => {
      const peer = peerWithId(OPTED_IN);
      for (const lines of [
        ['GOOGLE_SIGNIN_ENABLED=true', `GOOGLE_CLIENT_ID=${CLIENT}`, `GOOGLE_CLIENT_SECRET=${SECRET}`, OPTED_IN],
        sameId(OPTED_IN),
        // CRs and a repeated key: env_value takes the last line, CR removed.
        sameId('GOOGLE_CLIENT_SHARED=false', `${OPTED_IN}\r`),
      ]) {
        expect(guard(env(lines), peer).output).toBe('PASSED');
      }
      // The peer's own CR is stripped the same way.
      expect(guard(env(sameId(OPTED_IN)), peerWithId(`${OPTED_IN}\r`)).output).toBe('PASSED');
    });

    it('refuses the opt-in on one side only, naming that side and what is wrong with it', () => {
      const thisSideOnly = guard(env(sameId(OPTED_IN)), peerWithId(), 'production');
      expect(thisSideOnly.status).toBe(1);
      expect(thisSideOnly.output).toBe(`${SHARED_REFUSAL} missing from production's .env`);

      const peerOnly = guard(env(sameId()), peerWithId(OPTED_IN), 'production');
      expect(peerOnly.status).toBe(1);
      expect(peerOnly.output).toBe(`${SHARED_REFUSAL} missing from this environment's .env`);

      // Present and false is not missing, and the refusal says so, per side.
      expect(guard(env(sameId(OPTED_IN)), peerWithId('GOOGLE_CLIENT_SHARED=false'), 'production').output)
        .toBe(`${SHARED_REFUSAL} not true in production's .env`);
      expect(guard(env(sameId('GOOGLE_CLIENT_SHARED=false')), peerWithId(OPTED_IN), 'production').output)
        .toBe(`${SHARED_REFUSAL} not true in this environment's .env`);

      // The peer's name is deploy.sh's; without one the refusal still stands.
      expect(guard(env(sameId(OPTED_IN)), peerWithId()).output).toBe(`${SHARED_REFUSAL} missing from the other environment's .env`);
    });

    it('refuses the same id with neither side opting in, switched on or not, without printing it', () => {
      for (const lines of [
        ['GOOGLE_SIGNIN_ENABLED=true', `GOOGLE_CLIENT_ID=${CLIENT}`, `GOOGLE_CLIENT_SECRET=${SECRET}`],
        sameId(),
        sameId('GOOGLE_CLIENT_SHARED='),
      ]) {
        const { output, status } = guard(env(lines), peerWithId(), 'production');
        expect(status).toBe(1);
        expect(output).toBe(`${SHARED_REFUSAL} missing from this environment's .env and missing from production's .env`);
        expect(output).not.toContain(CLIENT);
      }
      // Both sides mixed: one absent, one present and false.
      expect(guard(env(sameId('GOOGLE_CLIENT_SHARED=false')), peerWithId(), 'production').output)
        .toBe(`${SHARED_REFUSAL} not true in this environment's .env and missing from production's .env`);
    });

    it('refuses any other value for the opt-in, read whatever the switch says', () => {
      for (const value of ['TRUE', 'True', '1', 'yes', 'on', '"true"', ' true', 'true ', SECRET]) {
        // No peer file at all: the spelling is checked before anything is compared.
        const { output, status } = guard(env([`GOOGLE_CLIENT_SHARED=${value}`]));
        expect(status).toBe(1);
        expect(output).toBe('REFUSED: GOOGLE_CLIENT_SHARED must be empty, true or false; .env holds something else');
        expect(output).not.toContain(SECRET);
      }
    });

    // The peer's spelling is held to the same rule, so a value that is there
    // but malformed is never reported as "missing from" a file that has it.
    it('refuses a malformed opt-in in the other environment, naming that side', () => {
      for (const value of ['TRUE', 'True', '1', 'yes', ' true', 'true ', SECRET]) {
        const { output, status } = guard(env(sameId(OPTED_IN)), peerWithId(`GOOGLE_CLIENT_SHARED=${value}`), 'production');
        expect(status).toBe(1);
        expect(output).toBe("REFUSED: GOOGLE_CLIENT_SHARED in production's .env must be empty, true or false; it holds something else");
        expect(output).not.toContain(SECRET);
      }
      // It is read only once the ids match: a different id never reads it.
      expect(guard(env(['GOOGLE_CLIENT_ID=' + CLIENT]), env([`GOOGLE_CLIENT_ID=${OTHER_CLIENT}`, 'GOOGLE_CLIENT_SHARED=yes'])).output).toBe('PASSED');
    });

    it('leaves two different client ids alone, opted in or not', () => {
      const complete = ['GOOGLE_SIGNIN_ENABLED=true', `GOOGLE_CLIENT_ID=${CLIENT}`, `GOOGLE_CLIENT_SECRET=${SECRET}`];
      const otherPeer = env([`GOOGLE_CLIENT_ID=${OTHER_CLIENT}`, OPTED_IN]);
      expect(guard(env(complete), otherPeer).output).toBe('PASSED');
      expect(guard(env([...complete, OPTED_IN]), env([`GOOGLE_CLIENT_ID=${OTHER_CLIENT}`])).output).toBe('PASSED');
      // An empty id on both sides is not a shared client.
      expect(guard(env(['GOOGLE_SIGNIN_ENABLED=false', 'GOOGLE_CLIENT_ID=']), env(['GOOGLE_CLIENT_ID='])).output).toBe('PASSED');
    });
  });
});

describe.skipIf(!hasBash)('kong_closed_block_guard', () => {
  const kong = repoFile('deploy/kong.yml');
  const guardKong = (text: string) => run(['kong_closed_block_guard', file(text)]);

  it('passes the kong.yml in this repository, with LF or CRLF line ends', () => {
    expect(guardKong(kong).output).toBe('PASSED');
    expect(guardKong(kong.replace(/\n/g, '\r\n')).output).toBe('PASSED');
  });

  it('reads past a comment in column 0 inside the block, as ci-release.sh does', () => {
    const commented = kong.replace('    routes:\n      - name: auth-v1-closed\n', '# a note in column 0\n    routes:\n      - name: auth-v1-closed\n');
    expect(commented).not.toBe(kong);
    expect(guardKong(commented).output).toBe('PASSED');
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
      // A top-level key ends the block, so what follows it is not part of it.
      kong.replace('    plugins:\n      - name: request-termination\n', 'x_other: 1\n    plugins:\n      - name: request-termination\n'),
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
    // Google on with signup still closed: what GoTrue would show if the auth
    // entrypoint were edited or bypassed, since GoTrue reads TRUE or 1 as on.
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

describe.skipIf(!hasPython)('kong_parse_inputs', () => {
  const KONG = {
    image: 'kong:2.8.1',
    environment: {
      KONG_PLUGINS: 'request-transformer,cors,key-auth,acl,request-termination',
      SERVICE_ROLE_KEY: 'service.role.key.value',
      ANON_KEY: 'anon.key.value',
      APP_URL: 'https://app.example.test',
      KONG_DATABASE: 'off',
    },
  };
  const composeAnswer = (kong: unknown) =>
    JSON.stringify({ services: { auth: { environment: { GOTRUE_JWT_SECRET: 'not-for-kong' } }, kong } });

  it('writes the kong environment, sorted and nothing else, to a mode 600 env file, and prints only the image', () => {
    const envFile = freshPath();
    expect(run(['kong_parse_inputs', envFile], composeAnswer(KONG))).toEqual({ output: 'kong:2.8.1\nPASSED', status: 0 });
    expect(readFileSync(envFile, 'utf8')).toBe(
      [
        'ANON_KEY=anon.key.value',
        'APP_URL=https://app.example.test',
        'KONG_DATABASE=off',
        'KONG_PLUGINS=request-transformer,cors,key-auth,acl,request-termination',
        'SERVICE_ROLE_KEY=service.role.key.value',
        '',
      ].join('\n'),
    );
    if (process.platform !== 'win32') expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it('fails, printing nothing, without a kong image or environment, or with a line break in a value', () => {
    for (const answer of [
      'not json',
      composeAnswer(undefined),
      composeAnswer({ environment: KONG.environment }),
      composeAnswer({ image: 'kong:2.8.1' }),
      composeAnswer({ image: 'kong:2.8.1', environment: {} }),
      composeAnswer({ ...KONG, environment: { ...KONG.environment, APP_URL: 'https://app.example.test\nKONG_PLUGINS=off' } }),
    ]) {
      expect(run(['kong_parse_inputs', freshPath()], answer)).toEqual({ output: '', status: 1 });
    }
  });
});

describe.skipIf(!hasPython)('redact_env_values', () => {
  it('replaces the values of keys, secrets, passwords and tokens with their names, and leaves the rest of the message', () => {
    const envFile = env([
      'ANON_KEY=anon.key.value',
      'SERVICE_ROLE_KEY=service.role.key.value',
      'SMTP_PASS=smtp-pass-value',
      'KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml',
      'KONG_PLUGINS=request-transformer,cors',
    ]);
    const message = "Error: in 'key': service.role.key.value, anon.key.value, smtp-pass-value in /home/kong/kong.yml (request-transformer,cors)\n";
    expect(run(['redact_env_values', envFile], message).output).toBe(
      "Error: in 'key': [SERVICE_ROLE_KEY], [ANON_KEY], [SMTP_PASS] in /home/kong/kong.yml (request-transformer,cors)\nPASSED",
    );
  });
});
