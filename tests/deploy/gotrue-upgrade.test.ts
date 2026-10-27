/**
 * deploy.sh's two GoTrue-upgrade guards, run for real.
 *
 * The functions between "# >>> gotrue upgrade checks" and
 * "# <<< gotrue upgrade checks" in deploy/deploy.sh are copied out verbatim and
 * sourced by bash with a stub `fail`, exactly as
 * tests/deploy/passkey-config.test.ts and tests/deploy/google-signin-guards.test.ts
 * do for their blocks. The google-signin block is sourced first, because
 * `env_value` lives there and both guards read their .env through it -- one
 * reader for every env file in the release path, rather than a second one that
 * could drift from it.
 *
 * Needs bash with grep. Where it is missing the tests are skipped, never passed.
 *
 * The two guards exist because the upgrade from v2.170.0 to v2.190.0 made two
 * things reachable that nothing in this product wants:
 *
 *   1. Seven notification mails. They are default:"false" upstream today, so the
 *      upgrade itself sends nothing new -- but they have no German template, and
 *      this product's five existing templates are pinned byte for byte.
 *   2. GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED, which keys every rate limit on
 *      a client-supplied header that GoTrue validates only as an IP.
 *
 * Several tests here are about the repository's own state rather than the
 * guards' logic, and they are what make "this release ships both off" a fact
 * rather than a claim.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const hasBash = probe('command -v grep >/dev/null && echo ok');

const dir = mkdtempSync(join(tmpdir(), 'gotrue-upgrade-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(
  join(dir, 'checks.sh'),
  `${block('google-signin checks')}\n${block('gotrue upgrade checks')}\n`,
);
writeFileSync(
  join(dir, 'run.sh'),
  [
    'set -euo pipefail',
    'fail() { printf "REFUSED: %s\\n" "$*"; exit 1; }',
    'cd "$(dirname "$0")"',
    'source ./checks.sh',
    // The list is a shell variable in deploy.sh; print it so a test can read the
    // exact pairs the guard loops over rather than restating them.
    'switch_list() { printf "%s" "$GOTRUE_NOTIFICATION_SWITCHES"; }',
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

function run(args: string[]): { output: string; status: number | null } {
  const result = spawnSync('bash', [posix(join(dir, 'run.sh')), ...args], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return {
    output: `${result.stdout}${result.stderr}`.replace(/\r/g, '').trim(),
    status: result.status,
  };
}

const env = (lines: string[]) => file(`${lines.join('\n')}\n`);

/** The seven .env keys, read out of deploy.sh rather than restated here. */
const NOTIFY_KEYS: string[] = (() => {
  const text = block('gotrue upgrade checks');
  const start = text.indexOf("GOTRUE_NOTIFICATION_SWITCHES='");
  const end = text.indexOf("'", start + "GOTRUE_NOTIFICATION_SWITCHES='".length);
  return text
    .slice(start, end)
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((key) => key.startsWith('NOTIFY_'));
})();

describe.skipIf(!hasBash)('mailer_notifications_guard', () => {
  it('reads all seven switches, and the list in deploy.sh is exactly those seven', () => {
    // The list is the guard's only subject, so a key dropped from it is a mail
    // that stops being refused. Pinned by name, not by count alone.
    expect(NOTIFY_KEYS).toEqual([
      'NOTIFY_PASSWORD_CHANGED',
      'NOTIFY_EMAIL_CHANGED',
      'NOTIFY_PHONE_CHANGED',
      'NOTIFY_IDENTITY_LINKED',
      'NOTIFY_IDENTITY_UNLINKED',
      'NOTIFY_MFA_FACTOR_ENROLLED',
      'NOTIFY_MFA_FACTOR_UNENROLLED',
    ]);
  });

  it('pairs each switch with the correctly spelled GOTRUE_ variable', () => {
    // A misspelled GOTRUE_ name is the silent failure this whole slice guards
    // against: compose would pass a variable GoTrue ignores, and the mail would
    // follow whatever GoTrue's default happened to be. Verified against
    // v2.190.0's own example.env and its NotificationsConfiguration struct.
    const pairs = run(['switch_list'])
      .output.replace(/\nPASSED$/, '')
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/));
    expect(pairs).toEqual([
      ['NOTIFY_PASSWORD_CHANGED', 'GOTRUE_MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED'],
      ['NOTIFY_EMAIL_CHANGED', 'GOTRUE_MAILER_NOTIFICATIONS_EMAIL_CHANGED_ENABLED'],
      ['NOTIFY_PHONE_CHANGED', 'GOTRUE_MAILER_NOTIFICATIONS_PHONE_CHANGED_ENABLED'],
      ['NOTIFY_IDENTITY_LINKED', 'GOTRUE_MAILER_NOTIFICATIONS_IDENTITY_LINKED_ENABLED'],
      ['NOTIFY_IDENTITY_UNLINKED', 'GOTRUE_MAILER_NOTIFICATIONS_IDENTITY_UNLINKED_ENABLED'],
      ['NOTIFY_MFA_FACTOR_ENROLLED', 'GOTRUE_MAILER_NOTIFICATIONS_MFA_FACTOR_ENROLLED_ENABLED'],
      ['NOTIFY_MFA_FACTOR_UNENROLLED', 'GOTRUE_MAILER_NOTIFICATIONS_MFA_FACTOR_UNENROLLED_ENABLED'],
    ]);
  });

  it('passes an .env that sets all seven to false', () => {
    expect(run(['mailer_notifications_guard', env(NOTIFY_KEYS.map((k) => `${k}=false`))]).output).toBe(
      'PASSED',
    );
  });

  it('passes an .env that mentions none of them', () => {
    // An absent key is "off": compose interpolates :-false for each one.
    expect(run(['mailer_notifications_guard', env(['JWT_SECRET=x'])]).output).toBe('PASSED');
  });

  it('passes an empty value, the same as absent', () => {
    expect(run(['mailer_notifications_guard', env(NOTIFY_KEYS.map((k) => `${k}=`))]).output).toBe(
      'PASSED',
    );
  });

  it.each(NOTIFY_KEYS)('refuses %s=true, naming the GOTRUE_ variable it feeds', (key) => {
    const { output, status } = run([
      'mailer_notifications_guard',
      env(NOTIFY_KEYS.map((k) => `${k}=${k === key ? 'true' : 'false'}`)),
    ]);
    expect(status).toBe(1);
    expect(output).toContain(`${key}=true`);
    expect(output).toContain('GOTRUE_MAILER_NOTIFICATIONS_');
    // The reason is the German template, not the mail volume.
    expect(output).toContain('German template');
  });

  it('refuses a value that is neither true nor false, so a typo never reads as off', () => {
    // GoTrue parses these as Go bools, where "1", "t" and "TRUE" are all true.
    for (const value of ['TRUE', '1', 't', 'yes', 'False ']) {
      const { output, status } = run([
        'mailer_notifications_guard',
        env([`NOTIFY_PASSWORD_CHANGED=${value}`]),
      ]);
      expect(status, `value ${JSON.stringify(value)} should be refused`).toBe(1);
      expect(output).toContain('must be empty or false');
    }
  });

  it('refuses a GOTRUE_MAILER_NOTIFICATIONS_* key written straight into .env', () => {
    // Inert -- compose passes only what it names -- and refused precisely
    // because it is inert: the release would succeed and the operator would
    // believe the mail was on.
    const { output, status } = run([
      'mailer_notifications_guard',
      env(['GOTRUE_MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED=true']),
    ]);
    expect(status).toBe(1);
    expect(output).toContain('has no effect');
  });

  it('reads the last line for a key, as env_value does', () => {
    expect(
      run(['mailer_notifications_guard', env(['NOTIFY_EMAIL_CHANGED=false', 'NOTIFY_EMAIL_CHANGED=true'])])
        .status,
    ).toBe(1);
  });
});

describe.skipIf(!hasBash)('sb_forwarded_for_guard', () => {
  it('passes an .env that does not mention it', () => {
    expect(run(['sb_forwarded_for_guard', env(['JWT_SECRET=x'])]).output).toBe('PASSED');
  });

  it('passes false and an empty value', () => {
    expect(
      run(['sb_forwarded_for_guard', env(['GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED=false'])]).output,
    ).toBe('PASSED');
    expect(
      run(['sb_forwarded_for_guard', env(['GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED='])]).output,
    ).toBe('PASSED');
  });

  it('refuses true, and says what would break', () => {
    const { output, status } = run([
      'sb_forwarded_for_guard',
      env(['GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED=true']),
    ]);
    expect(status).toBe(1);
    // The refusal has to name the consequence, not just the rule: the next
    // person to read it is the one considering turning it on.
    expect(output).toContain('rate limit');
    expect(output).toContain('X-Client-IP');
  });

  it('refuses any other value, so a Go-bool truthy spelling cannot slip through', () => {
    for (const value of ['TRUE', '1', 't', 'True']) {
      const { status } = run([
        'sb_forwarded_for_guard',
        env([`GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED=${value}`]),
      ]);
      expect(status, `value ${JSON.stringify(value)} should be refused`).toBe(1);
    }
  });
});

describe("the repository's own state: the upgrade, and both settings off", () => {
  const composeText = () => repoFile('deploy/docker-compose.yml');

  it('pins supabase/gotrue:v2.190.0 on the auth service', () => {
    // Not merely "some 2.19x": 2.190.0 is the floor passkey_guard enforces and
    // the last version before 2.191-2.197 add further auth-schema migrations.
    expect(composeText()).toContain('image: supabase/gotrue:v2.190.0');
    expect(composeText()).not.toContain('image: supabase/gotrue:v2.170.0');
  });

  it('passes all seven notification variables to GoTrue, each defaulting to false', () => {
    // The default is the wall against an upstream default flip; without the
    // `:-false` an absent .env key would mean "whatever GoTrue decides".
    const text = composeText();
    for (const [key, gotrueKey] of [
      ['NOTIFY_PASSWORD_CHANGED', 'PASSWORD_CHANGED'],
      ['NOTIFY_EMAIL_CHANGED', 'EMAIL_CHANGED'],
      ['NOTIFY_PHONE_CHANGED', 'PHONE_CHANGED'],
      ['NOTIFY_IDENTITY_LINKED', 'IDENTITY_LINKED'],
      ['NOTIFY_IDENTITY_UNLINKED', 'IDENTITY_UNLINKED'],
      ['NOTIFY_MFA_FACTOR_ENROLLED', 'MFA_FACTOR_ENROLLED'],
      ['NOTIFY_MFA_FACTOR_UNENROLLED', 'MFA_FACTOR_UNENROLLED'],
    ]) {
      expect(text).toContain(
        `GOTRUE_MAILER_NOTIFICATIONS_${gotrueKey}_ENABLED: \${${key}:-false}`,
      );
    }
  });

  it('ships all seven .env.example lines as false', () => {
    const example = repoFile('deploy/.env.example');
    for (const key of NOTIFY_KEYS) {
      expect(example).toContain(`\n${key}=false\n`);
      expect(example).not.toMatch(new RegExp(`^${key}=true$`, 'm'));
    }
  });

  it('pins Sb-Forwarded-For off as a literal, not as an interpolation', () => {
    // A literal is stronger than the guard: no .env value and no upstream
    // default can reach it. The guard still exists to refuse the intent early
    // and to catch a later "simplification" of this line into ${...}.
    expect(composeText()).toContain("GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED: 'false'");
    expect(composeText()).not.toMatch(/GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED: \$\{/);
  });

  it('leaves no Sb-Forwarded-For value in .env.example to be edited', () => {
    const example = repoFile('deploy/.env.example');
    expect(example).not.toMatch(/^GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED=/m);
    // It is documented, though -- "do not set it" has to be findable.
    expect(example).toContain('GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED');
  });

  it('pins custom OAuth providers off, the one new surface that ships default-on', () => {
    // GOTRUE_CUSTOM_OAUTH_ENABLED is default:"true" in v2.190.0, and
    // /auth/v1/settings has no key for it -- its `external` map carries 26 fixed
    // provider names and nothing for custom ones -- so auth_settings_problems
    // cannot see it however it is set. A literal is the only wall available.
    expect(composeText()).toContain("GOTRUE_CUSTOM_OAUTH_ENABLED: 'false'");
  });

  it('pins the index worker off, both halves', () => {
    // It runs CREATE INDEX CONCURRENTLY on auth.users from inside the auth
    // container at boot, outside the migration ledger. Both default to off; the
    // threshold is the one to watch, because any value above 0 arms it.
    const text = composeText();
    expect(text).toContain("GOTRUE_INDEX_WORKER_ENSURE_USER_SEARCH_INDEXES_EXIST: 'false'");
    expect(text).toContain("GOTRUE_INDEX_WORKER_MAX_USERS_THRESHOLD: '0'");
  });

  it('leaves the signup, autoconfirm, URL-path and rate-limit settings exactly as they were', () => {
    // This is the upgrade release and nothing else. Each of these is a path a
    // GoTrue bump reaches, and each was re-read at v2.190.0 and found unchanged;
    // a diff that moves one of them is a different decision.
    const text = composeText();
    expect(text).toContain("GOTRUE_DISABLE_SIGNUP: 'true'");
    expect(text).toContain("GOTRUE_MAILER_AUTOCONFIRM: 'true'");
    expect(text).toContain('GOTRUE_RATE_LIMIT_HEADER: X-Client-IP');
    for (const type of ['INVITE', 'RECOVERY', 'CONFIRMATION', 'EMAIL_CHANGE']) {
      expect(text).toContain(`GOTRUE_MAILER_URLPATHS_${type}: /auth/v1/verify`);
    }
    // The five German templates GoTrue fetches from the web container.
    for (const name of ['invite', 'recovery', 'confirmation', 'email-change', 'magic-link']) {
      expect(text).toContain(`http://web/email-templates/${name}.html`);
    }
  });

  it('calls both guards in the release path', () => {
    const script = repoFile('deploy/deploy.sh');
    expect(script).toMatch(/^mailer_notifications_guard \.env$/m);
    expect(script).toMatch(/^sb_forwarded_for_guard \.env$/m);
  });
});
