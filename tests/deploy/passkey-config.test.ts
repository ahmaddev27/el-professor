/**
 * deploy.sh's passkey (WebAuthn) checks, run for real.
 *
 * The functions between "# >>> passkey checks" and "# <<< passkey checks" in
 * deploy/deploy.sh are copied out verbatim and sourced by bash with a stub
 * `fail`, exactly as tests/deploy/google-signin-guards.test.ts does for the
 * sign-in block. The google-signin block is sourced first, because `env_value`
 * lives there and the passkey guard reads its .env through it — one reader for
 * every env file in the release path, rather than a second one that could drift
 * from it.
 *
 * Needs bash with grep and awk; the version comparison also needs python3, as
 * deploy.sh does on the host. Where they are missing the tests are skipped,
 * never passed.
 *
 * Two of these tests are about the repository's own state rather than about the
 * guard's logic, and they are the ones that make "this slice ships the switch
 * off" a fact instead of a claim: today the switch cannot be turned on at all,
 * because the pinned GoTrue does not know the variable and no migration admits
 * `passkey` in the platform amr allow-list. Each is asserted separately so that
 * when one of those two preconditions is met, only that test fails and its
 * message names which half moved.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoFile = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function block(marker: string): string {
  const script = repoFile('deploy/deploy.sh');
  const start = script.indexOf(`\n# >>> ${marker}\n`);
  const end = script.indexOf(`\n# <<< ${marker}\n`);
  if (start < 0 || end < start) throw new Error(`deploy.sh lost its ${marker} markers`);
  return script.slice(start, end);
}

function probe(command: string): boolean {
  const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', timeout: 20_000 });
  return result.status === 0 && result.stdout.trim() === 'ok';
}

const hasBash = probe('command -v grep >/dev/null && command -v awk >/dev/null && echo ok');
const hasPython = hasBash && probe('python3 -c "print(1)" >/dev/null 2>&1 && echo ok');

const dir = mkdtempSync(join(tmpdir(), 'passkey-checks-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// `env_value` comes from the sign-in block; everything else from the passkey one.
writeFileSync(join(dir, 'checks.sh'), `${block('google-signin checks')}\n${block('passkey checks')}\n`);
writeFileSync(
  join(dir, 'run.sh'),
  [
    'set -euo pipefail',
    'fail() { printf "REFUSED: %s\\n" "$*"; exit 1; }',
    'cd "$(dirname "$0")"',
    'source ./checks.sh',
    // The settings check reports through its exit status; print both.
    'settings_check() { local problems status=0; problems="$(auth_settings_problems "$1" "${2:-false}")" || status=$?; echo "[$problems] $status"; }',
    // version_at_least reports through its exit status alone.
    'version_check() { if version_at_least "$1" "$2"; then echo yes; else echo no; fi; }',
    '"$@"',
    'echo PASSED',
    '',
  ].join('\n'),
);

const posix = (path: string) => path.replace(/\\/g, '/');
let fixture = 0;
function file(content: string): string {
  const path = join(dir, `fixture-${++fixture}`);
  writeFileSync(path, content);
  return posix(path);
}

function run(args: string[], stdin = ''): { output: string; status: number | null } {
  const result = spawnSync('bash', [posix(join(dir, 'run.sh')), ...args], {
    encoding: 'utf8',
    input: stdin,
    timeout: 20_000,
  });
  // `\r` is stripped for the same reason google-signin-guards.test.ts strips it:
  // python3's text-mode stdout translates `\n` to `\r\n` on Windows only, which
  // made that gate unrunnable on a dev machine while passing in CI. deploy.sh
  // runs on Linux and nowhere else.
  return {
    output: `${result.stdout}${result.stderr}`.replace(/\r/g, '').trim(),
    status: result.status,
  };
}

const env = (lines: string[]) => file(`${lines.join('\n')}\n`);

/** A compose file whose auth service pins `version`, shaped like the real one. */
const compose = (version: string | null) =>
  file(
    [
      'services:',
      '  db:',
      '    image: supabase/postgres:17.6.1.170',
      '  auth:',
      ...(version === null ? ['    # no image line at all'] : [`    image: supabase/${version}`]),
      '    restart: unless-stopped',
      '    environment:',
      '      GOTRUE_API_PORT: \'9999\'',
      '  rest:',
      '    image: postgrest/postgrest:v12.2.0',
      '',
    ].join('\n'),
  );

/** A migrations directory; `admits` writes the file that names `passkey`. */
function migrations(admits: boolean): string {
  const path = join(dir, `migrations-${++fixture}`);
  mkdirSync(path, { recursive: true });
  // A decoy that names the function but not the method, so the guard cannot
  // pass merely because the function is mentioned somewhere in the chain.
  writeFileSync(
    join(path, '20260919130000_platform_amr_check.sql'),
    [
      'CREATE OR REPLACE FUNCTION app_private.session_amr_permits_platform()',
      'RETURNS boolean AS $$',
      "  c_permitted CONSTANT text[] := ARRAY['password'];",
      "  c_refused   CONSTANT text[] := ARRAY['oauth', 'sso/saml', 'anonymous'];",
      '$$ LANGUAGE plpgsql;',
      '',
    ].join('\n'),
  );
  if (admits) {
    writeFileSync(
      join(path, '20261101000000_platform_amr_admits_passkey.sql'),
      [
        'CREATE OR REPLACE FUNCTION app_private.session_amr_permits_platform()',
        'RETURNS boolean AS $$',
        "  c_permitted CONSTANT text[] := ARRAY['password', 'passkey'];",
        '$$ LANGUAGE plpgsql;',
        '',
      ].join('\n'),
    );
  }
  return posix(path);
}

const REAL_COMPOSE = posix(new URL('../../deploy/docker-compose.yml', import.meta.url).pathname.replace(/^\//, ''));
const REAL_MIGRATIONS = posix(new URL('../../supabase/migrations', import.meta.url).pathname.replace(/^\//, ''));

/** A fully configured .env for the apex-domain choice, switched on. */
const ON = [
  'PASSKEY_SIGNIN_ENABLED=true',
  'PASSKEY_RP_ID=example.eu',
  'PASSKEY_RP_DISPLAY_NAME=Example',
  'PASSKEY_RP_ORIGINS=https://example.eu,https://app.example.eu',
];
const GOOD_COMPOSE = () => compose('gotrue:v2.190.0');
const guard = (envFile: string, composeFile: string, migrationsDir: string) =>
  run(['passkey_guard', envFile, composeFile, migrationsDir]);
/** Switched on, with everything downstream of the .env already satisfied. */
const guardOn = (lines: string[]) => guard(env(lines), GOOD_COMPOSE(), migrations(true));

describe.skipIf(!hasBash)('passkey_guard: the switch', () => {
  it('lets the switch be missing, empty or false, with no other value set', () => {
    for (const lines of [[], ['PASSKEY_SIGNIN_ENABLED='], ['PASSKEY_SIGNIN_ENABLED=false'], ['PASSKEY_SIGNIN_ENABLED=false\r']]) {
      expect(guard(env(lines), compose('gotrue:v2.170.0'), migrations(false)).output).toBe('PASSED');
    }
  });

  it('refuses any other value for the switch without printing it', () => {
    // Asserted as the whole sentence rather than with `not.toContain(value)`:
    // the refusal names the permitted values, so "true" and " true" are
    // substrings of its own wording and that check would fail on a correct
    // message. An exact match proves no value is appended, for every value.
    const REFUSAL = 'REFUSED: PASSKEY_SIGNIN_ENABLED must be empty, true or false; .env holds something else';
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', '"true"', "'true'", ' true', 'true ', 'enabled', 'hunter2']) {
      const { output, status } = guard(env([`PASSKEY_SIGNIN_ENABLED=${value}`, ...ON.slice(1)]), GOOD_COMPOSE(), migrations(true));
      expect(status, `expected ${JSON.stringify(value)} to be refused`).toBe(1);
      expect(output).toBe(REFUSAL);
    }
  });

  it('accepts a complete configuration on a new enough image with the migration in place', () => {
    expect(guardOn(ON).output).toBe('PASSED');
  });
});

describe.skipIf(!hasBash)('passkey_guard: the relying-party ID', () => {
  it('refuses a malformed RP ID even while the switch is off, because it is written first', () => {
    const { output, status } = guard(
      env(['PASSKEY_SIGNIN_ENABLED=false', 'PASSKEY_RP_ID=https://example.eu']),
      compose('gotrue:v2.170.0'),
      migrations(false),
    );
    expect(status).toBe(1);
    expect(output).toMatch(/^REFUSED: PASSKEY_RP_ID must be one bare lowercase domain/);
  });

  it('refuses every shape that is not one bare lowercase domain', () => {
    for (const value of [
      'https://example.eu',
      'http://example.eu',
      'example.eu/',
      'example.eu:443',
      'example.eu.',
      '.example.eu',
      'Example.eu',
      'EXAMPLE.EU',
      'localhost',
      'eu',
      '*.example.eu',
      'exa mple.eu',
      'example..eu',
      '-example.eu',
      'example-.eu',
      'user@example.eu',
    ]) {
      const { output, status } = guard(env([`PASSKEY_RP_ID=${value}`]), GOOD_COMPOSE(), migrations(true));
      expect(status, `expected ${value} to be refused`).toBe(1);
      expect(output).toMatch(/^REFUSED: PASSKEY_RP_ID must be one bare lowercase domain/);
    }
  });

  it('accepts a bare domain at the apex and below it', () => {
    for (const value of ['example.eu', 'app.example.eu', 'a.b.c.example.eu', 'ex-ample.eu', 'x1.example2.eu']) {
      expect(guard(env([`PASSKEY_RP_ID=${value}`]), GOOD_COMPOSE(), migrations(true)).output).toBe('PASSED');
    }
  });

  it('switched on, needs the RP ID, the display name and the origins, each named', () => {
    const without = (key: string) => guardOn(ON.filter((line) => !line.startsWith(`${key}=`))).output;
    expect(without('PASSKEY_RP_ID')).toMatch(/^REFUSED: PASSKEY_SIGNIN_ENABLED=true needs PASSKEY_RP_ID/);
    expect(without('PASSKEY_RP_DISPLAY_NAME')).toMatch(/^REFUSED: PASSKEY_SIGNIN_ENABLED=true needs PASSKEY_RP_DISPLAY_NAME/);
    expect(without('PASSKEY_RP_ORIGINS')).toMatch(/^REFUSED: PASSKEY_SIGNIN_ENABLED=true needs PASSKEY_RP_ORIGINS/);
    // Present but empty is the same as absent, and is the likelier mistake.
    expect(guardOn([...ON.slice(0, 3), 'PASSKEY_RP_ORIGINS=']).output).toMatch(
      /^REFUSED: PASSKEY_SIGNIN_ENABLED=true needs PASSKEY_RP_ORIGINS/,
    );
  });

  it('says the RP ID cannot be changed later, where the operator is choosing it', () => {
    expect(guardOn(ON.filter((line) => !line.startsWith('PASSKEY_RP_ID='))).output).toContain(
      'invalidating every registered passkey',
    );
  });
});

describe.skipIf(!hasBash)('passkey_guard: the origins', () => {
  const withOrigins = (origins: string) =>
    guardOn([...ON.slice(0, 3), `PASSKEY_RP_ORIGINS=${origins}`]);

  it('refuses an origin that is not https', () => {
    expect(withOrigins('http://example.eu').output).toBe('REFUSED: PASSKEY_RP_ORIGINS: origin http://example.eu is not https');
    expect(withOrigins('example.eu').output).toBe('REFUSED: PASSKEY_RP_ORIGINS: origin example.eu has no https:// scheme');
    expect(withOrigins('ws://example.eu').output).toMatch(/has no https:\/\/ scheme/);
  });

  it('refuses an origin carrying anything beyond scheme, host and port', () => {
    expect(withOrigins('https://example.eu/login').output).toMatch(/carries a path; an origin is scheme, host and port only/);
    expect(withOrigins('https://example.eu/').output).toMatch(/carries a path/);
    expect(withOrigins('https://example.eu?a=1').output).toMatch(/carries a query or fragment/);
    expect(withOrigins('https://example.eu#x').output).toMatch(/carries a query or fragment/);
    expect(withOrigins('https://user:pw@example.eu').output).toMatch(/carries credentials/);
  });

  it('refuses a host that is neither the RP ID nor under it', () => {
    for (const origin of [
      'https://example.com',
      'https://example.eu.evil.test',
      'https://notexample.eu',
      'https://eu',
    ]) {
      expect(withOrigins(origin).output, `expected ${origin} to be refused`).toBe(
        `REFUSED: PASSKEY_RP_ORIGINS: origin ${origin} is not example.eu or a subdomain of it`,
      );
    }
  });

  it('accepts the RP ID itself, a subdomain, a port, and whitespace around a list', () => {
    for (const origins of [
      'https://example.eu',
      'https://app.example.eu',
      'https://example.eu,https://app.example.eu',
      'https://example.eu:8443',
      ' https://example.eu , https://app.example.eu ',
      'https://a.b.example.eu',
    ]) {
      expect(withOrigins(origins).output, `expected ${origins} to be accepted`).toBe('PASSED');
    }
  });

  it('checks every entry, not just the first', () => {
    expect(withOrigins('https://example.eu,http://app.example.eu').output).toMatch(
      /origin http:\/\/app\.example\.eu is not https/,
    );
    expect(withOrigins('https://example.eu,https://evil.test').output).toMatch(
      /origin https:\/\/evil\.test is not example\.eu or a subdomain of it/,
    );
  });
});

describe.skipIf(!hasPython)('passkey_guard: the image must know the variable', () => {
  it('refuses the switch on the GoTrue this stack pins today', () => {
    const { output, status } = guard(env(ON), compose('gotrue:v2.170.0'), migrations(true));
    expect(status).toBe(1);
    expect(output).toContain('needs supabase/gotrue v2.190.0 or newer');
    expect(output).toContain('pins v2.170.0');
    expect(output).toContain('A GoTrue upgrade is its own release');
  });

  it('refuses every passkey-incapable or half-capable version in the range', () => {
    for (const version of ['gotrue:v2.170.0', 'gotrue:v2.187.0', 'gotrue:v2.188.1', 'gotrue:v2.189.0', 'auth:v2.189.9']) {
      const { status, output } = guard(env(ON), compose(version), migrations(true));
      expect(status, `expected ${version} to be refused`).toBe(1);
      expect(output).toContain('needs supabase/gotrue v2.190.0 or newer');
    }
  });

  it('accepts the minimum and anything above it, in either image namespace', () => {
    for (const version of ['gotrue:v2.190.0', 'gotrue:v2.197.0', 'auth:v2.190.0', 'auth:v2.197.0', 'gotrue:v3.0.0', 'gotrue:v2.198.0-rc.25']) {
      expect(guard(env(ON), compose(version), migrations(true)).output, `expected ${version} to be accepted`).toBe('PASSED');
    }
  });

  it('refuses a compose file whose auth service pins no readable version', () => {
    for (const version of [null, 'gotrue:latest', 'gotrue:main']) {
      const { output, status } = guard(env(ON), compose(version), migrations(true));
      expect(status, `expected ${String(version)} to be refused`).toBe(1);
      expect(output).toContain('pins no readable supabase/gotrue version');
    }
  });

  it('reads the version out of the auth service and no other', () => {
    // A db image above the floor and an auth image below it: the guard must read
    // the auth one. Without the service-scoping in gotrue_image_version, the
    // first supabase/* image in the file would answer.
    const mixed = file(
      [
        'services:',
        '  other:',
        '    image: supabase/gotrue:v2.197.0',
        '  auth:',
        '    image: supabase/gotrue:v2.170.0',
        '',
      ].join('\n'),
    );
    expect(guard(env(ON), mixed, migrations(true)).output).toContain('pins v2.170.0');
  });

  it('version_at_least compares numerically, not as text', () => {
    const check = (have: string, want: string) => run(['version_check', have, want]).output.split('\n')[0];
    expect(check('2.190.0', '2.190.0')).toBe('yes');
    expect(check('2.197.0', '2.190.0')).toBe('yes');
    // The text comparison that a sort-based implementation would get wrong.
    expect(check('2.9.0', '2.190.0')).toBe('no');
    expect(check('2.1900.0', '2.190.0')).toBe('yes');
    expect(check('10.0.0', '2.190.0')).toBe('yes');
    expect(check('2.189.9', '2.190.0')).toBe('no');
    expect(check('', '2.190.0')).toBe('no');
    expect(check('latest', '2.190.0')).toBe('no');
  });
});

describe.skipIf(!hasPython)('passkey_guard: the platform amr allow-list', () => {
  it('refuses the switch while no migration admits passkey, and says what breaks', () => {
    const { output, status } = guard(env(ON), GOOD_COMPOSE(), migrations(false));
    expect(status).toBe(1);
    expect(output).toContain("no migration admits 'passkey' in app_private.session_amr_permits_platform()");
    expect(output).toContain('the admin panel would come up empty');
    expect(output).toContain('Decide that in a migration first');
  });

  it('is not satisfied by a migration that merely names the function', () => {
    // migrations(false) already contains the real allow-list migration, which
    // names the function and the three refused methods but never `passkey`.
    expect(guard(env(ON), GOOD_COMPOSE(), migrations(false)).status).toBe(1);
  });

  it('is satisfied once a migration names both the function and passkey', () => {
    expect(guard(env(ON), GOOD_COMPOSE(), migrations(true)).output).toBe('PASSED');
  });

  it('refuses an empty or missing migrations directory', () => {
    const empty = posix(mkdtempSync(join(dir, 'empty-migrations-')));
    expect(guard(env(ON), GOOD_COMPOSE(), empty).status).toBe(1);
    expect(guard(env(ON), GOOD_COMPOSE(), posix(join(dir, 'no-such-dir'))).status).toBe(1);
  });
});

describe.skipIf(!hasPython)("the repository's own state: the switch ships off and cannot be turned on", () => {
  it('ships PASSKEY_SIGNIN_ENABLED=false in deploy/.env.example', () => {
    const example = repoFile('deploy/.env.example');
    expect(example).toContain('\nPASSKEY_SIGNIN_ENABLED=false\n');
    expect(example).not.toMatch(/^PASSKEY_SIGNIN_ENABLED=true$/m);
    // No real origin is committed: the template leaves both blank.
    expect(example).toContain('\nPASSKEY_RP_ID=\n');
    expect(example).toContain('\nPASSKEY_RP_ORIGINS=\n');
  });

  it('pins a GoTrue that does not know passkeys, so the switch is refused on the image alone', () => {
    // Fails on purpose once the owner upgrades GoTrue: at that point this slice's
    // claim "the switch cannot be turned on" is half gone, and the change should
    // be read rather than discovered. The amr half is the next test.
    const { output, status } = guard(env(ON), REAL_COMPOSE, migrations(true));
    expect(status).toBe(1);
    expect(output).toContain('needs supabase/gotrue v2.190.0 or newer');
  });

  it('carries no migration admitting passkey, so the switch is refused on the amr rule alone', () => {
    // Fails on purpose once that migration is written — which is the decision
    // this slice deliberately does not take.
    const { output, status } = guard(env(ON), GOOD_COMPOSE(), REAL_MIGRATIONS);
    expect(status).toBe(1);
    expect(output).toContain("no migration admits 'passkey'");
  });

  it('wires every passkey variable in docker-compose.yml behind the switch', () => {
    const composeText = repoFile('deploy/docker-compose.yml');
    expect(composeText).toContain('GOTRUE_PASSKEY_ENABLED: ${PASSKEY_SIGNIN_ENABLED:-false}');
    expect(composeText).toContain('GOTRUE_WEBAUTHN_RP_ID: ${PASSKEY_RP_ID:-}');
    expect(composeText).toContain('GOTRUE_WEBAUTHN_RP_DISPLAY_NAME: ${PASSKEY_RP_DISPLAY_NAME:-}');
    expect(composeText).toContain('GOTRUE_WEBAUTHN_RP_ORIGINS: ${PASSKEY_RP_ORIGINS:-}');
    expect(composeText).toContain('GOTRUE_WEBAUTHN_CHALLENGE_EXPIRY_DURATION: ${PASSKEY_CHALLENGE_EXPIRY:-5m}');
    expect(composeText).toContain('GOTRUE_PASSKEY_MAX_PASSKEYS_PER_USER: ${PASSKEY_MAX_PER_USER:-10}');
    expect(composeText).toContain('GOTRUE_RATE_LIMIT_PASSKEY: ${RATE_LIMIT_PASSKEY:-30}');
  });

  it('leaves the signup settings and the auth entrypoint exactly as they were', () => {
    // A passkey route cannot create an account (registration needs an
    // authenticated session; authentication only resolves an existing user), so
    // this switch must not touch signup. If a future change makes the entrypoint
    // read the passkey switch, that is a decision about account creation and
    // belongs with the Google guards, not here.
    const composeText = repoFile('deploy/docker-compose.yml');
    expect(composeText).toContain("GOTRUE_DISABLE_SIGNUP: 'true'");
    expect(composeText).toContain("GOTRUE_MAILER_AUTOCONFIRM: 'true'");
    const entrypoint = composeText.match(/entrypoint: \[.*?\]/s)?.[0] ?? '';
    expect(entrypoint).toContain('GOTRUE_EXTERNAL_GOOGLE_ENABLED');
    expect(entrypoint).not.toContain('PASSKEY');
  });
});

describe.skipIf(!hasPython)('auth_settings_problems carries the passkey switch', () => {
  // The shape GoTrue v2.170.0 answers with: no passkeys_enabled key at all.
  const v2170 = JSON.stringify({
    external: { email: true, google: true, phone: false, anonymous_users: false },
    disable_signup: false,
    mailer_autoconfirm: false,
    saml_enabled: false,
  });
  // The shape a passkey-capable GoTrue answers with.
  const withPasskeys = (enabled: boolean) =>
    JSON.stringify({
      external: { email: true, google: true, phone: false, anonymous_users: false },
      disable_signup: false,
      mailer_autoconfirm: false,
      saml_enabled: false,
      passkeys_enabled: enabled,
    });
  const check = (google: string, passkey: string, body: string) =>
    run(['settings_check', google, passkey], body).output.split('\n')[0];

  it('treats a missing passkeys_enabled as off, so the pinned GoTrue passes', () => {
    // Reading it as a required key would refuse every release on this image.
    expect(check('true', 'false', v2170)).toBe('[] 0');
  });

  it('accepts the key when it agrees with the switch', () => {
    expect(check('true', 'false', withPasskeys(false))).toBe('[] 0');
    expect(check('true', 'true', withPasskeys(true))).toBe('[] 0');
  });

  it('reports a switch and an answer that disagree, naming the key', () => {
    expect(check('true', 'true', withPasskeys(false))).toBe('[passkeys_enabled=false] 1');
    expect(check('true', 'false', withPasskeys(true))).toBe('[passkeys_enabled=true] 1');
  });

  it('catches an image too old to know the variable when the switch is on', () => {
    // The second wall behind the version refusal: the switch says on, the live
    // answer has no such key, so the release fails rather than reporting success
    // for a feature that is not running.
    expect(check('true', 'true', v2170)).toBe('[passkeys_enabled=false] 1');
  });

  it('still reports the Google problems it always did', () => {
    expect(check('false', 'false', withPasskeys(false))).toBe(
      '[disable_signup=false google=true mailer_autoconfirm=false] 1',
    );
  });
});
