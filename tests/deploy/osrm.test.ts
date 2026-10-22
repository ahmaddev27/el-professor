/**
 * The routing container's deployment, pinned as text and, for the shell that
 * decides things, run for real.
 *
 * What this guards is the safety argument of the `osrm` service, which any
 * well-meant edit could lose without a single unit test noticing:
 *
 *   - it holds NO credential and NO database connection (no environment, no
 *     secret, no env_file) and can reach none: it is on our network only,
 *     never ridy's, and the one volume it mounts is the map, read-only;
 *   - it publishes no host port (the VPS is shared with another live product);
 *   - it is hardened, and its image is pinned by digest;
 *   - it is OFF unless the `osrm` profile is named, so the release that adds it
 *     starts nothing and pulls nothing;
 *   - it is not asked for by Kong: the browser reaches it only through the
 *     travel-route function, which authenticates, so Kong gained no route and
 *     KONG_PLUGINS, a rollback guard, did not change;
 *   - the function that calls it holds neither the service key nor SMTP, and
 *     the host and port it calls are the compose service's.
 *
 * deploy.sh's and the build script's shell is pinned the way
 * tests/deploy/export-service.test.ts pins the release: comment lines are
 * stripped first, so prose cannot satisfy an assertion the code no longer
 * does, and the functions between marker lines are sourced and run.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OSRM_ORIGIN } from '../../supabase/functions/_shared/travel-route-core';

const repoFile = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const compose = repoFile('deploy/docker-compose.yml');
const kong = repoFile('deploy/kong.yml');
const deploySh = repoFile('deploy/deploy.sh');
const deployCode = code(deploySh);
const buildSh = repoFile('deploy/osrm-build-data.sh');
const buildCode = code(buildSh);
const router = repoFile('supabase/functions/main/index.ts');
const fn = repoFile('supabase/functions/travel-route/index.ts');

/** One service's block, from its key to the next two-space key or section banner. */
function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`docker-compose.yml has no ${name} service`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}(# ── |[a-z][a-z-]*:\n)/);
  return code(next < 0 ? rest : rest.slice(0, next + 1));
}

/** The items of a block-style list under a service key, e.g. its volumes. */
function listUnder(block: string, key: string): string[] {
  const start = block.indexOf(`\n    ${key}:\n`);
  if (start < 0) return [];
  const rest = block.slice(start + 1).split('\n').slice(1);
  const items: string[] = [];
  for (const line of rest) {
    const item = /^ {6}- (.+)$/.exec(line);
    if (!item) break;
    items.push(item[1]);
  }
  return items;
}

const osrm = serviceBlock('osrm');
const functionsBlock = serviceBlock('functions');
const IMAGE_LINE = /^ {4}image: (ghcr\.io\/project-osrm\/osrm-backend:v\d+\.\d+\.\d+-debian@sha256:[0-9a-f]{64})$/m;

describe('the compose service holds no credential and reaches no data path', () => {
  it('has no environment, secret or env file at all', () => {
    expect(osrm).not.toMatch(/^\s+environment:/m);
    expect(osrm).not.toMatch(/^\s+env_file:/m);
    expect(osrm).not.toMatch(/JWT|SERVICE_ROLE|ANON_KEY|DATABASE|POSTGRES|PGPASSWORD|SECRET|PEPPER|SMTP|PASSWORD|TOKEN/i);
  });

  it('mounts exactly one volume, the map, read-only', () => {
    expect(listUnder(osrm, 'volumes')).toEqual(['osrm-data:/data:ro']);
    expect(osrm).not.toMatch(/\.\//);
  });

  it('publishes no host port', () => {
    expect(osrm).not.toMatch(/^\s+ports:/m);
    expect(osrm).toMatch(/expose:\s*\n\s+- '5000'/);
  });

  it('is on our network only, and waits for nothing', () => {
    expect(osrm).not.toMatch(/ridy/);
    expect(osrm).not.toMatch(/^\s+networks:/m);
    expect(osrm).not.toMatch(/depends_on/);
  });

  it('is hardened: read-only, non-root, no capabilities, no new privileges, a capped memory and process count', () => {
    expect(osrm).toMatch(/read_only: true/);
    expect(osrm).toMatch(/user: '10001:10001'/);
    expect(osrm).toMatch(/cap_drop: \[ALL\]/);
    expect(osrm).toMatch(/no-new-privileges:true/);
    expect(osrm).toMatch(/tmpfs:/);
    expect(osrm).toMatch(/limits: \{ memory: '\$\{OSRM_MEM_LIMIT:-\d+G\}', pids: \d+ \}/);
  });

  it('writes the process cap inside the limits map, never as a top-level pids_limit', () => {
    expect(osrm).not.toMatch(/^\s+pids_limit:/m);
  });

  it('is pinned by digest, to a release, and is not built here', () => {
    expect(osrm).toMatch(IMAGE_LINE);
    expect(osrm).not.toMatch(/^\s+build:/m);
  });

  it('is off unless the osrm profile is named, so the release that adds it starts and pulls nothing', () => {
    expect(osrm).toMatch(/^ {4}profiles: \[osrm\]$/m);
  });

  it('serves the map in MLD, mapped, quietly, and accepts only the two coordinates it is ever asked about', () => {
    expect(listUnder(osrm, 'command')).toEqual([
      'osrm-routed', '--algorithm=MLD', '--mmap', '--ip=0.0.0.0', '--port=5000', '--threads=2', '--verbosity=WARNING',
      '--max-viaroute-size=2', '--max-table-size=2', '--max-trip-size=2', '--max-matching-size=2', '--max-nearest-size=1',
      '/data/current/map.osrm',
    ]);
  });

  it('declares the volume it mounts', () => {
    expect(compose).toMatch(/^volumes:\n {2}db-data:\n {2}storage-data:\n(?:\s*#.*\n)*\s{2}osrm-data:\n/m);
  });
});

describe('nothing else in the stack learned about it', () => {
  it('Kong has no route to it and its plugin list, a rollback guard, is as it was', () => {
    expect(kong).not.toMatch(/osrm/i);
    expect(compose).toContain('KONG_PLUGINS: request-transformer,cors,key-auth,acl,request-termination');
    expect(serviceBlock('kong')).toMatch(/depends_on: \[rest, auth, storage, realtime, functions\]/);
  });

  it('the functions container does not wait for it, name it or carry a variable for it', () => {
    expect(functionsBlock).not.toMatch(/osrm/i);
  });

  it('the function calls the host and the port the compose service has', () => {
    expect(OSRM_ORIGIN).toBe('http://osrm:5000');
    expect(compose).toMatch(/^ {2}osrm:\n/m);
    expect(osrm).toContain('--port=5000');
    expect(osrm).toContain('127.0.0.1/5000');
  });
});

describe('the travel-route function holds only what it needs', () => {
  it('has a FUNCTION_ENV entry of the base variables and nothing more, and is not public', () => {
    expect(router).toMatch(/\['travel-route', \[\.\.\.BASE_ENV\]\],/);
    const publicList = /PUBLIC_FUNCTIONS = new Set<string>\(\[([^\]]*)\]\)/.exec(router);
    expect(publicList?.[1]).not.toContain('travel-route');
  });

  it('never reads the service key, SMTP or the pepper, and calls no host but the constant', () => {
    expect(code(fn)).not.toMatch(/SERVICE_ROLE|SMTP|OTP_PEPPER|PARTNER|JWT_SECRET/);
    expect(code(fn)).not.toMatch(/https?:\/\//);
  });

  it('asks GoTrue for a person and the database for an active company before it routes anything', () => {
    const body = code(fn);
    const person = body.indexOf('auth.getUser()');
    const company = body.indexOf("rpc('get_active_company_id')");
    const routing = body.indexOf('routePairs(');
    expect(person).toBeGreaterThan(0);
    expect(company).toBeGreaterThan(person);
    expect(routing).toBeGreaterThan(company);
  });

  it('logs counts and nothing from the request', () => {
    const logs = code(fn).split('\n').filter((l) => /console\.(log|error|warn|info)/.test(l));
    const text = logs.join('\n');
    expect(text).toContain('pairs: parsed.pairs.length');
    expect(text).toContain('outcome: tally(outcome.results)');
    expect(text).not.toMatch(/\.from\b|\.to\b|lat\b|lon\b|body|text\(/);
  });
});

// ── The shell, run for real ──────────────────────────────────────────────────

function block(text: string, name: string): string {
  const start = text.indexOf(`\n# >>> ${name}\n`);
  const end = text.indexOf(`\n# <<< ${name}\n`);
  if (start < 0 || end < start) throw new Error(`the script lost its "${name}" markers`);
  return text.slice(start, end);
}

const tryBash = (command: string): boolean => {
  const r = spawnSync('bash', ['-c', command], { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 && r.stdout.trim() === 'ok';
};
const hasBash = tryBash('command -v awk >/dev/null && command -v grep >/dev/null && echo ok');

const dir = mkdtempSync(join(tmpdir(), 'osrm-deploy-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const posix = (path: string) => path.replace(/\\/g, '/');
const sh = (name: string, lines: string[]) => writeFileSync(join(dir, name), `${lines.join('\n')}\n`);

sh('profiles.sh', [block(deploySh, 'compose profile checks')]);
sh('data.sh', [block(deploySh, 'osrm data checks')]);
sh('helpers.sh', [block(buildSh, 'osrm build helpers')]);

function run(script: string, body: string[], env: Record<string, string> = {}): { out: string; status: number | null } {
  sh('run.sh', ['set -euo pipefail', `cd "${posix(dir)}"`, `source ./${script}`, ...body]);
  const r = spawnSync('bash', [posix(join(dir, 'run.sh'))], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...env } });
  return { out: `${r.stdout}${r.stderr}`.replace(/\r/g, '').trim(), status: r.status };
}

describe.skipIf(!hasBash)('compose_profiles_problem (deploy.sh)', () => {
  const problem = (environment: string, list: string) => run('profiles.sh', [`compose_profiles_problem "${environment}" "${list}"`]).out;

  it.each([
    ['production', ''],
    ['production', 'osrm'],
    ['staging', 'staging'],
    ['staging', 'staging,osrm'],
    ['staging', 'osrm,staging'],
    ['staging', 'staging,osrm,osrm'],
  ])('accepts %s with "%s"', (environment, list) => {
    expect(problem(environment, list)).toBe('');
  });

  it('keeps staging\'s mail catcher off production, however it is spelled next to osrm', () => {
    for (const list of ['staging', 'staging,osrm', 'osrm,staging']) {
      expect(problem('production', list)).toMatch(/production must not enable the staging profile/);
    }
  });

  it('still insists that staging starts its mail catcher', () => {
    for (const list of ['', 'osrm']) expect(problem('staging', list)).toMatch(/staging needs COMPOSE_PROFILES to name staging/);
  });

  it.each(['foo', 'staging,foo', 'OSRM', 'osrm ', ' osrm', 'staging, osrm', 'routing'])(
    'refuses a name this release does not know ("%s"), because a typo that reads as none is a service that silently does not start',
    (list) => {
      expect(problem('staging', list)).toMatch(/does not know|has an empty name/);
      expect(problem('production', list)).toMatch(/does not know|has an empty name/);
    },
  );

  it.each([',', 'staging,', ',osrm', 'staging,,osrm'])('refuses an empty name in the list ("%s")', (list) => {
    expect(problem('staging', list)).toMatch(/has an empty name/);
  });
});

describe.skipIf(!hasBash)('osrm_data_problem (deploy.sh)', () => {
  const log = posix(join(dir, 'docker-calls.log'));
  const ask = (env: Record<string, string>) =>
    run('data.sh', [
      `docker() { echo "$*" >> "${log}"; case "$1 $2" in "volume inspect") [ "\${FAKE_VOLUME}" = yes ] ;; "run --rm") [ "\${FAKE_READY}" = yes ] ;; esac; }`,
      'osrm_data_problem ghcr.io/example/osrm@sha256:abc ya-mobility-staging_osrm-data',
    ], env).out;

  it('says nothing when the volume holds a finished build', () => {
    expect(ask({ FAKE_VOLUME: 'yes', FAKE_READY: 'yes' })).toBe('');
  });

  it('names a volume that does not exist, and one that holds no ready.json', () => {
    expect(ask({ FAKE_VOLUME: 'no', FAKE_READY: 'yes' })).toMatch(/volume ya-mobility-staging_osrm-data does not exist/);
    expect(ask({ FAKE_VOLUME: 'yes', FAKE_READY: 'no' })).toMatch(/holds no finished build \(no \/data\/current\/ready\.json\)/);
  });

  it('looks through the link the service reads, read-only and without a network', () => {
    ask({ FAKE_VOLUME: 'yes', FAKE_READY: 'yes' });
    const calls = readFileSync(join(dir, 'docker-calls.log'), 'utf8');
    expect(calls).toMatch(/run --rm --network none -v ya-mobility-staging_osrm-data:\/data:ro --entrypoint test ghcr\.io\/example\/osrm@sha256:abc -f \/data\/current\/ready\.json/);
  });
});

describe.skipIf(!hasBash)('the build script\'s helpers', () => {
  const call = (body: string) => run('helpers.sh', [body]).out;
  const page = (names: string[]) => names.map((n) => `<a href="${n}">${n}</a>`).join('\n');

  it('scales the wiki\'s planet figures by the extract\'s size', () => {
    // 4 865 927 506 bytes is germany-261020.osm.pbf: 4.53 GiB of the wiki\'s 61.
    expect(call('scaled_gib 4865927506 415')).toBe('30.8');
    expect(call('scaled_gib 4865927506 300')).toBe('22.3');
    expect(call('scaled_gib 0 415')).toBe('0.0');
  });

  it('finds the newest snapshot of exactly this region on a Geofabrik page, and nothing when there is none', () => {
    const file = posix(join(dir, 'page.html'));
    writeFileSync(join(dir, 'page.html'), page([
      'germany-latest.osm.pbf', 'germany-261019.osm.pbf', 'germany-261020.osm.pbf', 'germany-261018.osm.pbf',
      'east-germany-261030.osm.pbf', 'germany-261020.osm.pbf.md5', 'germany-261020.state.txt', 'germany-latest-free.shp.zip',
    ]));
    expect(call(`newest_snapshot_date "${file}" germany`)).toBe('261020');
    expect(call(`newest_snapshot_date "${file}" bremen`)).toBe('');
  });

  it('counts memory and swap that are free now, and holds back a fifth of the memory for the host', () => {
    writeFileSync(join(dir, 'meminfo'), 'MemTotal:       65536000 kB\nMemFree:         1024000 kB\nMemAvailable:   33554432 kB\nSwapTotal:      16777216 kB\nSwapFree:        8388608 kB\n');
    const file = posix(join(dir, 'meminfo'));
    expect(call(`free_memory_gib "${file}"`)).toBe('40.0');
    // 80 % of 32 GiB in MiB, and that plus 8 GiB of swap.
    expect(call(`build_limits "${file}"`)).toBe('26214 34406');
  });

  it('judges a requirement against what the host has', () => {
    expect(call('verdict 30.8 40.0')).toBe('ok');
    expect(call('verdict 30.8 30.8')).toBe('ok');
    expect(call('verdict 30.8 12.0')).toBe('needs about 30.8 GiB, this host has 12.0 GiB');
  });

  it.each(['europe/germany', 'europe/germany/nordrhein-westfalen', 'europe/germany/nordrhein-westfalen/duesseldorf-regbez'])(
    'accepts the region %s',
    (region) => expect(run('helpers.sh', [`valid_region "${region}" && echo yes`]).out).toBe('yes'),
  );

  it.each(['', 'Europe/Germany', 'europe//germany', 'europe/germany/', '/europe/germany', '../etc', 'europe/germany;id', 'europe/germany x', 'europe/$(id)'])(
    'refuses the region "%s", which ends up in a URL and a volume path',
    (region) => expect(run('helpers.sh', [`valid_region '${region}' && echo yes || echo no`]).out).toBe('no'),
  );

  it('names a build after the region and its snapshot', () => {
    expect(call('build_name europe/germany 261020')).toBe('germany-261020');
    expect(call('build_name europe/germany/nordrhein-westfalen 261020')).toBe('nordrhein-westfalen-261020');
  });
});

describe.skipIf(!hasBash)('the build script, refusing before it touches anything', () => {
  const copy = join(dir, 'build');
  const runCopy = (...args: string[]) => {
    const r = spawnSync('bash', [posix(join(copy, 'osrm-build-data.sh')), ...args], { encoding: 'utf8', timeout: 20_000 });
    return { out: `${r.stdout}${r.stderr}`.replace(/\r/g, '').trim(), status: r.status };
  };
  // A copy in an empty directory: no .env there, as on a fresh checkout.
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, 'osrm-build-data.sh'), buildSh);

  it('has valid syntax', () => {
    expect(spawnSync('bash', ['-n', posix(join(copy, 'osrm-build-data.sh'))], { encoding: 'utf8' }).status).toBe(0);
  });

  it('prints its usage', () => {
    const { out, status } = runCopy('--help');
    expect(status).toBe(0);
    expect(out).toContain('--check');
    expect(out).toContain('--region');
  });

  it('refuses a region that is not a Geofabrik path, a date that is not YYMMDD and a directory with no .env', () => {
    expect(runCopy('--region', 'Europe/Germany')).toMatchObject({ status: 1 });
    expect(runCopy('--region', 'Europe/Germany').out).toMatch(/OSRM BUILD REFUSED: --region is a Geofabrik path/);
    expect(runCopy('--date', '26-10-20').out).toMatch(/OSRM BUILD REFUSED: --date is YYMMDD/);
    expect(runCopy().out).toMatch(/OSRM BUILD REFUSED: \.env is missing/);
    expect(runCopy('--bogus').status).toBe(2);
  });
});

describe('deploy.sh asks before it changes anything', () => {
  const at = (needle: string) => deployCode.indexOf(needle);
  const migrations = at('step "migrations"');

  it('judges COMPOSE_PROFILES with the helper, once, and the two inline guards are gone', () => {
    expect(deployCode).toContain('profiles_problem="$(compose_profiles_problem "$ENVIRONMENT" "$PROFILES")"');
    expect(deployCode).not.toContain('[ "$PROFILES" = staging ]');
    expect(deployCode).not.toContain('production must not enable compose profiles');
    expect(at('compose_profiles_problem "$ENVIRONMENT"')).toBeLessThan(migrations);
  });

  it('refuses a release with the osrm profile on and no finished build, after compose renders and before the migrations', () => {
    const render = at('docker compose config -q');
    const guard = at('osrm_data_problem "$osrm_image"');
    expect(render).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(render);
    expect(guard).toBeLessThan(migrations);
    expect(deployCode).toContain('Build it first with deploy/osrm-build-data.sh');
  });

  it('looks for the osrm service in the rendered config, so a stack without the profile is not asked', () => {
    expect(deployCode).toContain('.get("osrm")');
    expect(deployCode).toContain('if [ -n "$osrm_image" ]; then');
  });

  it('never builds the map: that is hours of work and a great deal of memory, and not a release\'s', () => {
    expect(deployCode.replace('Build it first with deploy/osrm-build-data.sh', '')).not.toContain('osrm-build-data');
    expect(deployCode).not.toMatch(/osrm-(extract|partition|customize)/);
  });
});

describe('the build script\'s promises', () => {
  const at = (needle: string) => buildCode.indexOf(needle);

  it('stops at the first error and takes the image from the compose file, only if it is pinned by digest', () => {
    expect(buildCode).toMatch(/^set -euo pipefail$/m);
    expect(buildCode).toContain('docker compose --profile osrm config --format json');
    expect(buildCode).toContain('*@sha256:*) ;;');
    expect(buildCode).toContain('the osrm image is not pinned by digest');
  });

  it('only builds for the two stacks, in the volume compose names for the service', () => {
    expect(buildCode).toContain('ya-mobility|ya-mobility-staging) ;;');
    expect(buildCode).toContain('VOLUME="${PROJECT_NAME}_osrm-data"');
  });

  it('checks the download against its checksum before it uses it', () => {
    expect(buildCode).toContain('md5sum "$PBF"');
    expect(at('md5sum "$PBF"')).toBeLessThan(at('run_stage extract'));
  });

  it('runs every build step with a memory ceiling below what the host has, a low CPU share and no network', () => {
    const stage = /^run_stage\(\) \{[\s\S]*?^\}/m.exec(buildCode)?.[0] ?? '';
    expect(stage).toContain('--network none');
    expect(stage).toContain('--memory "${MEM_MIB}m" --memory-swap "${SWAP_MIB}m"');
    expect(stage).toContain('--cpus "$BUILD_CPUS" --cpu-shares 256');
    expect(buildCode).toContain('read -r MEM_MIB SWAP_MIB <<<"$(build_limits /proc/meminfo)"');
    for (const call of buildCode.split('\n').filter((l) => /^\s*docker run /.test(l))) {
      expect(call, call).toContain('--network none');
    }
  });

  it('refuses to start when the estimate does not fit, unless it is told to, and builds one thing at a time', () => {
    expect(buildCode).toContain('Build elsewhere and copy the volume');
    expect(buildCode).toContain('[ "$FORCE" = yes ] || fail');
    expect(buildCode).toContain('flock -n 9');
  });

  it('starts the new build once, as the service\'s user, before the link moves to it', () => {
    expect(buildCode).toContain('--user 10001:10001');
    expect(at('osrm-routed --algorithm=MLD')).toBeGreaterThan(0);
    expect(at('osrm-routed --algorithm=MLD')).toBeLessThan(at('mv -T current.new current'));
  });

  it('writes ready.json before it moves the link, and moves the link in one rename', () => {
    expect(at('> "$1/ready.json"')).toBeGreaterThan(0);
    expect(at('> "$1/ready.json"')).toBeLessThan(at('ln -sfn "$1" current.new'));
    expect(at('ln -sfn "$1" current.new')).toBeLessThan(at('mv -T current.new current'));
  });

  it('restarts, stops and removes nothing of the stack, and does not mention ridy', () => {
    expect(buildCode).not.toMatch(/^\s*docker compose (up|down|restart|stop|rm|kill|build)\b/m);
    expect(buildCode).not.toMatch(/docker (restart|stop|kill|rm -f) (?!"\$CHECK")/);
    expect(buildCode).not.toMatch(/ridy/i);
  });
});
