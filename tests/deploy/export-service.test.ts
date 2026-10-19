/**
 * The Excel export service's deployment, pinned as text and, for its health
 * verdict, run for real.
 *
 * What this guards is a set of properties the service's safety argument rests
 * on, any of which a well-meant edit could lose without a single unit test
 * noticing:
 *
 *   - it holds NO credential and NO data path (no database URL, no JWT secret,
 *     no service-role key, no volume), because "a user can only receive what
 *     they sent" is true by construction only while that holds;
 *   - it publishes no host port (the VPS is shared with another live product);
 *   - it is hardened (read-only filesystem, non-root, capabilities dropped,
 *     memory capped) and its image is pinned by digest with hash-checked
 *     packages;
 *   - Kong routes it with no new plugin, because KONG_PLUGINS is a rollback
 *     guard;
 *   - the release builds it before anything else changes, and probes it through
 *     the gateway afterwards with the one reload that clears a stale address;
 *   - the wrapper that runs on the host copies it, and the CI archive ships it.
 *
 * deploy.sh's call sites are shell that cannot be executed here, so they are
 * pinned the way tests/deploy/functions-health.test.ts pins the functions
 * probe: with comment lines stripped first, so prose cannot satisfy an assertion
 * the code no longer does.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoFile = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const compose = repoFile('deploy/docker-compose.yml');
const kong = repoFile('deploy/kong.yml');
const deploySh = repoFile('deploy/deploy.sh');
const deployCode = code(deploySh);
const ciRelease = repoFile('deploy/ci-release.sh');
const hostAction = repoFile('.github/actions/host/action.yml');
const dockerfile = repoFile('deploy/export-service/Dockerfile');
const requirements = repoFile('deploy/export-service/requirements.txt');

/** One service's block, from its key to the next two-space key or section banner. */
function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`docker-compose.yml has no ${name} service`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}(# ── |[a-z][a-z-]*:\n)/);
  return code(next < 0 ? rest : rest.slice(0, next + 1));
}

function kongService(name: string): string {
  const start = kong.indexOf(`\n  - name: ${name}\n`);
  if (start < 0) throw new Error(`kong.yml has no service ${name}`);
  const rest = kong.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}(- name: |# ── )/);
  return code(next < 0 ? rest : rest.slice(0, next + 1));
}

describe('the compose service holds no credential and no data path', () => {
  const block = serviceBlock('export-service');

  it('has no database, JWT or service-role setting, and only the GoTrue URL to ask who a caller is', () => {
    const names = [...block.matchAll(/^\s{6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
    expect(names).toEqual(['GOTRUE_URL']);
    expect(block).not.toMatch(/JWT|SERVICE_ROLE|ANON_KEY|DATABASE|POSTGRES|PGPASSWORD|SECRET|env_file/i);
  });

  it('mounts nothing and publishes no host port', () => {
    expect(block).not.toMatch(/^\s+volumes:/m);
    expect(block).not.toMatch(/^\s+ports:/m);
    expect(block).toMatch(/expose:\s*\n\s+- '8080'/);
  });

  it('is not on ridy\'s network and does not wait for the database', () => {
    expect(block).not.toMatch(/ridy/);
    expect(block).not.toMatch(/depends_on/);
  });

  it('is hardened: read-only, no capabilities, no new privileges, a capped memory and process count', () => {
    expect(block).toMatch(/read_only: true/);
    expect(block).toMatch(/cap_drop: \[ALL\]/);
    expect(block).toMatch(/no-new-privileges:true/);
    expect(block).toMatch(/pids_limit: \d+/);
    expect(block).toMatch(/memory: 512M/);
    expect(block).toMatch(/tmpfs:/);
  });

  it('is built from the release, not pulled', () => {
    expect(block).toMatch(/build:\s*\n\s+context: \.\/export-service/);
    expect(block).not.toMatch(/^\s+image:/m);
  });

  it('is not something Kong has to wait for: a down export service must not stop the gateway', () => {
    const kongBlock = serviceBlock('kong');
    expect(kongBlock).toMatch(/depends_on: \[rest, auth, storage, realtime, functions\]/);
  });

  it('left the Kong plugin list alone, because it is a rollback guard', () => {
    expect(compose).toContain('KONG_PLUGINS: request-transformer,cors,key-auth,acl,request-termination');
  });
});

describe('the image', () => {
  it('is pinned by digest, runs as a numeric non-root user and installs only hash-checked wheels', () => {
    expect(dockerfile).toMatch(/^FROM python:3\.12-slim@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile).toMatch(/^USER 10001$/m);
    expect(dockerfile).toContain('pip install --require-hashes --only-binary=:all: --no-deps -r requirements.txt');
  });

  it('carries no secret and no source tree beyond the package', () => {
    expect(dockerfile).not.toMatch(/JWT|SERVICE_ROLE|ENV [A-Z_]*(KEY|SECRET|PASSWORD)/);
    expect(dockerfile).toMatch(/^COPY export_service \.\/export_service$/m);
  });

  it('pins every package with a hash', () => {
    const lines = requirements.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    const packages = lines.filter((l) => /^[A-Za-z0-9_.-]+==/.test(l));
    expect(packages.map((l) => l.split('==')[0])).toEqual(expect.arrayContaining(['openpyxl', 'starlette', 'uvicorn']));
    for (const pkg of packages) expect(pkg).toMatch(/==\d+(\.\d+)* \\$/);
    expect(lines.filter((l) => l.includes('--hash=sha256:'))).toHaveLength(packages.length);
  });
});

describe('Kong routes it, with the plugins that already exist', () => {
  const block = kongService('export-v1');

  it('sends /export/v1/ to the container, and only GET, POST and OPTIONS', () => {
    expect(block).toContain('url: http://export-service:8080/');
    expect(block).toContain('paths: [/export/v1/]');
    expect(block).toMatch(/methods:\s*\n\s+- GET\s*\n\s+- POST\s*\n\s+- OPTIONS/);
  });

  it('uses only the cors plugin, which is already enabled', () => {
    const plugins = [...block.matchAll(/^\s+- name: ([a-z-]+)$/gm)]
      .map((m) => m[1])
      .filter((n) => n !== 'export-v1' && n !== 'export-v1-all');
    expect(plugins).toEqual(['cors']);
  });

  it('lets the browser read the request id and Retry-After', () => {
    expect(block).toMatch(/exposed_headers:[\s\S]*X-Request-Id[\s\S]*Retry-After/);
  });

  it('keeps kong.yml safe for the entrypoint that evals it', () => {
    expect(kong).not.toMatch(/`/);
    expect(kong).not.toMatch(/\$\(/);
    // Comments are skipped: the file's own header names '$VARIABLE' in prose.
    expect(code(kong).match(/\$[A-Za-z_]+/g)?.every((v) => ['$APP_URL', '$ANON_KEY', '$SERVICE_ROLE_KEY'].includes(v))).toBe(true);
  });
});

describe('the release builds the service first and probes it last', () => {
  it('builds before the migrations, and a failed build refuses the release', () => {
    const build = deployCode.indexOf('dc build export-service');
    const migrations = deployCode.indexOf('step "migrations"');
    expect(build).toBeGreaterThan(0);
    expect(migrations).toBeGreaterThan(build);
    expect(deployCode).toMatch(/dc build export-service < \/dev\/null \\\n\s+\|\| fail /);
  });

  it('refuses, with the reason, when the host wrapper predates the service', () => {
    expect(deployCode).toContain('[ -f "$HERE/export-service/Dockerfile" ]');
    expect(deploySh).toContain('has to be reinstalled before this release can be built');
  });

  it('skips the build only when the compose file does not declare the service (a rollback onto an older release)', () => {
    expect(deployCode).toContain('grep -qx export-service <<<"$declared_services"');
    expect(deployCode).toContain('if [ "$EXPORT_DECLARED" = yes ]; then');
  });

  it('probes through the gateway with the anon key and fails the release on a bad answer', () => {
    expect(deployCode).toContain('"$PUBLIC_URL/export/v1/workbook"');
    expect(deployCode).toContain('-H "Authorization: Bearer $export_anon_key"');
    expect(deployCode).toMatch(/\[ -z "\$export_problem" \] \\\n\s+\|\| fail /);
  });

  it('reloads Kong at most once, only after a 502, 503 or 504', () => {
    expect(deployCode).toContain('if [ -z "$export_reload" ] && export_probe_is_stale_upstream "$export_status"; then');
    expect(deployCode).toContain('dc exec -T kong kong reload');
  });

  it('runs the probe after the functions probe and before the release is marked ok', () => {
    const functions = deployCode.indexOf('/functions/v1/otp-request');
    const exportProbe = deployCode.indexOf('/export/v1/workbook');
    const ok = deployCode.indexOf('manifest_set STATUS ok');
    expect(functions).toBeLessThan(exportProbe);
    expect(exportProbe).toBeLessThan(ok);
  });
});

describe('the host wrapper and the CI archive carry it', () => {
  it('ci-release.sh copies the directory into the live checkout and into the stored release, and tolerates an older archive', () => {
    expect(ciRelease).toContain('cp -r "$src/deploy/export-service" "$DIR/deploy/export-service"');
    expect(ciRelease).toContain('cp -r "$work/deploy/export-service" "$rel/deploy/export-service"');
    expect(ciRelease).toMatch(/if \[ -d "\$src\/deploy\/export-service" \]/);
    expect(ciRelease).toMatch(/if \[ -d "\$work\/deploy\/export-service" \]/);
    // Not a required file: an archive from before the service is still accepted.
    expect(ciRelease).not.toMatch(/for need in[^\n]*export-service/);
  });

  it('the archive the workflow sends includes it', () => {
    expect(hostAction).toContain('deploy/export-service');
  });

  it('the wrapper still refuses an .env anywhere in the archive, the new directory included', () => {
    expect(ciRelease).toContain("-name '.env'");
  });
});

describe('the service\'s own README states the rule its safety rests on', () => {
  const readme = repoFile('deploy/export-service/README.md');

  it('says that a database connection or a service-role key voids the authorization argument', () => {
    expect(readme).toMatch(/database connection/i);
    expect(readme).toMatch(/service-role key/i);
    expect(readme).toMatch(/only receive what they sent/i);
  });
});

// ── The probe's verdict, run for real ────────────────────────────────────────

function checksBlock(): string {
  const start = deploySh.indexOf('\n# >>> export service health checks\n');
  const end = deploySh.indexOf('\n# <<< export service health checks\n');
  if (start < 0 || end < start) throw new Error('deploy.sh lost its export service health checks markers');
  return deploySh.slice(start, end);
}

const tryBash = (command: string): boolean => {
  const r = spawnSync('bash', ['-c', command], { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 && r.stdout.trim() === 'ok';
};
const hasBash = tryBash('echo ok');

const dir = mkdtempSync(join(tmpdir(), 'export-health-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'checks.sh'), `${checksBlock()}\n`);
writeFileSync(join(dir, 'run.sh'), [
  'set -euo pipefail',
  'cd "$(dirname "$0")"',
  'source ./checks.sh',
  'printf "[%s]\\n" "$(export_probe_problem "$1" "$2")"',
  '',
].join('\n'));
writeFileSync(join(dir, 'stale.sh'), [
  'set -euo pipefail',
  'cd "$(dirname "$0")"',
  'source ./checks.sh',
  'if export_probe_is_stale_upstream "$1"; then echo "[yes]"; else echo "[no]"; fi',
  '',
].join('\n'));

const runner = (name: string, args: string[]): string => {
  const r = spawnSync('bash', [join(dir, name).replace(/\\/g, '/'), ...args], { encoding: 'utf8', timeout: 20_000 });
  return `${r.stdout}${r.stderr}`.trim();
};

/**
 * What deploy/export-service answers an end-user-less token with. The service's
 * own tests (tests/test_api.py) assert this exact serialisation, so the two
 * halves cannot drift apart without one of them failing.
 */
const OWN_ANSWER = '{"error":{"code":"unauthorized","request_id":"0123abcd"}}';

describe.skipIf(!hasBash)('export_probe_problem', () => {
  it('passes the service\'s own 401 for the anon key, and only that', () => {
    expect(runner('run.sh', ['401', OWN_ANSWER])).toBe('[]');
  });

  it('refuses a 401 that is not the service\'s answer (a gateway key-auth page, say)', () => {
    for (const body of ['', '{}', 'Unauthorized', '{"message":"Invalid authentication credentials"}']) {
      expect(runner('run.sh', ['401', body])).toBe('[HTTP 401, but not the export service\'s own unauthorized answer]');
    }
  });

  it('refuses a 200: the anon key must NOT be able to make a workbook', () => {
    expect(runner('run.sh', ['200', 'PK'])).toMatch(/not the export service's own refusal of the anon key/);
  });

  it('names the gateway statuses and a missing route', () => {
    for (const status of ['502', '503', '504']) expect(runner('run.sh', [status, ''])).toMatch(/did not reach a working export service/);
    expect(runner('run.sh', ['404', ''])).toMatch(/no \/export\/v1\/ route/);
    expect(runner('run.sh', ['000', ''])).toBe('[no answer at all]');
  });

  it('spends its one kong reload on the gateway statuses and nothing else', () => {
    for (const status of ['502', '503', '504']) expect(runner('stale.sh', [status])).toBe('[yes]');
    for (const status of ['401', '404', '000', '200', '500']) expect(runner('stale.sh', [status])).toBe('[no]');
  });
});
