/**
 * The OSRM gateway's deployment, pinned as text and, for the shell that decides
 * things, run for real. (What the gateway DOES, with nginx running, is
 * tests/deploy/osrm-gateway-e2e.mjs in the osrm-gateway job of CI.)
 *
 * The OSRM behind it is ridy's and is not touched. The owner decided on
 * 25.10.2026 to use it rather than build a dataset of our own, and the whole
 * design is one container carrying one allow-list and one budget. What this
 * guards is the part any well-meant edit could lose silently:
 *
 *   - the gateway takes the network ALIAS `osrm`, so OSRM_ORIGIN
 *     (http://osrm:5000) is unchanged and no code knows which map answered -
 *     and therefore the `osrm` and `osrm-shared` profiles are MUTUALLY
 *     EXCLUSIVE, because with both on that one name means two containers;
 *   - it does NOT dial the name `osrm` itself, which would match on both of its
 *     networks at once, so some share of the requests would be the gateway
 *     proxying to itself;
 *   - the volume guard that refuses a release with the `osrm` profile and no
 *     finished build must not fire in shared mode, where there is no volume and
 *     no build - and must still fire in the old mode;
 *   - one path gets through and the query is rebuilt, so /table, /trip, /match
 *     and a third coordinate never reach them. One route is milliseconds of
 *     their CPU; one table of a hundred coordinates is thousands;
 *   - the budget is the product's own widest fan-out, so the three numbers that
 *     make it up have to keep multiplying out;
 *   - it holds no credential, publishes no host port, is hardened, is off
 *     unless the profile is named, and mounts nothing but its config;
 *   - the config reaches the host, and a rollback onto a release from before it
 *     survives.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OSRM_ORIGIN } from '../../supabase/functions/_shared/travel-route-core';

const repoFile = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
/** Whitespace folded, so a re-indented line is the same line. */
const folded = (text: string) => code(text).replace(/\s+/g, ' ');

const compose = repoFile('deploy/docker-compose.yml');
const kong = repoFile('deploy/kong.yml');
const deploySh = repoFile('deploy/deploy.sh');
const deployCode = code(deploySh);
const conf = repoFile('deploy/osrm-gateway.conf');
const router = repoFile('supabase/functions/main/index.ts');
const fn = repoFile('supabase/functions/travel-route/index.ts');
const prefetch = repoFile('src/utils/travelRouting/prefetch.ts');

/** One service's block, from its key to the next two-space key or section banner. */
function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`docker-compose.yml has no ${name} service`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}(# ── |[a-z][a-z0-9-]*:\n)/);
  return code(next < 0 ? rest : rest.slice(0, next + 1));
}

/** The items of a block-style list under a service key. */
function listUnder(block: string, key: string): string[] {
  const start = block.indexOf(`\n    ${key}:\n`);
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of block.slice(start + 1).split('\n').slice(1)) {
    const item = /^ {6}- (.+)$/.exec(line);
    if (!item) break;
    items.push(item[1]);
  }
  return items;
}

const gateway = serviceBlock('osrm-gateway');
const ownOsrm = serviceBlock('osrm');
const functionsBlock = serviceBlock('functions');
const webBlock = serviceBlock('web');

describe('the gateway service holds no credential and publishes nothing', () => {
  it('has no environment, secret or env file at all', () => {
    expect(gateway).not.toMatch(/^\s+environment:/m);
    expect(gateway).not.toMatch(/^\s+env_file:/m);
    expect(gateway).not.toMatch(/JWT|SERVICE_ROLE|ANON_KEY|DATABASE|POSTGRES|PGPASSWORD|SECRET|PEPPER|SMTP|PASSWORD|TOKEN/i);
  });

  it('mounts exactly one file, its own configuration, read-only, and no volume', () => {
    expect(listUnder(gateway, 'volumes')).toEqual(['./osrm-gateway.conf:/etc/nginx/conf.d/default.conf:ro']);
    expect(gateway).not.toMatch(/osrm-data/);
  });

  it('publishes no host port, and exposes the port OSRM_ORIGIN names', () => {
    expect(gateway).not.toMatch(/^\s+ports:/m);
    expect(gateway).toMatch(/expose:\s*\n\s+- '5000'/);
    expect(new URL(OSRM_ORIGIN).port).toBe('5000');
  });

  it('is hardened: read-only, only the capabilities nginx drops privileges with, no new privileges, a capped memory and process count', () => {
    expect(gateway).toMatch(/read_only: true/);
    expect(gateway).toMatch(/cap_drop: \[ALL\]/);
    expect(gateway).toMatch(/cap_add: \[CHOWN, SETUID, SETGID\]/);
    expect(gateway).toMatch(/no-new-privileges:true/);
    expect(gateway).toMatch(/limits: \{ memory: \d+M, pids: \d+ \}/);
    expect(gateway).not.toMatch(/^\s+pids_limit:/m);
  });

  it('is the nginx image web already pulls, and is not built here', () => {
    const image = /^ {4}image: (nginx:\S+)$/m;
    expect(gateway).toMatch(image);
    expect(gateway.match(image)?.[1]).toBe(webBlock.match(image)?.[1]);
    expect(gateway).not.toMatch(/^\s+build:/m);
  });

  it('is off unless the osrm-shared profile is named, so the release that adds it starts and pulls nothing', () => {
    expect(gateway).toMatch(/^ {4}profiles: \[osrm-shared\]$/m);
  });

  it('is recreated when its configuration changes, through the hash deploy.sh exports', () => {
    expect(gateway).toMatch(/el-professor\.config-sha: \$\{OSRM_GATEWAY_CONFIG_SHA:-unset\}/);
    expect(deploySh).toMatch(/OSRM_GATEWAY_CONFIG_SHA="\$\(sha256sum osrm-gateway\.conf \| cut -c1-16\)"/);
    expect(deploySh).toMatch(/export KONG_CONFIG_SHA NGINX_CONFIG_SHA GEOCODER_CONFIG_SHA OSRM_GATEWAY_CONFIG_SHA/);
  });

  it('is healthy when nginx is, not when ridy\'s service is: the check asks its own /healthz', () => {
    expect(gateway).toMatch(/http:\/\/127\.0\.0\.1:5000\/healthz/);
  });
});

describe('the alias, and the two profiles it makes mutually exclusive', () => {
  it('takes the name osrm on this stack\'s network, which is why no code changed', () => {
    expect(OSRM_ORIGIN).toBe('http://osrm:5000');
    expect(gateway).toMatch(/^ {4}networks:\n {6}default:\n {8}aliases: \[osrm\]\n/m);
  });

  it('is on this stack\'s network and ridy\'s, and on no other', () => {
    const key = '\n    networks:\n';
    const names: string[] = [];
    for (const line of gateway.slice(gateway.indexOf(key) + key.length).split('\n')) {
      if (line.trim() === '') continue;
      if (!line.startsWith('      ')) break; // a four-space key ends the networks block
      const name = /^ {6}([a-z][a-z0-9-]*):/.exec(line);
      if (name) names.push(name[1]);
    }
    expect(names).toEqual(['default', 'ridy']);
  });

  it('our own routing container is still there, unchanged, under its unchanged profile', () => {
    // We are choosing not to run it, not deleting the option.
    expect(ownOsrm).toMatch(/^ {4}profiles: \[osrm\]$/m);
    expect(listUnder(ownOsrm, 'volumes')).toEqual(['osrm-data:/data:ro']);
    expect(ownOsrm).not.toMatch(/^\s+networks:/m);
  });

  it('the two services cannot both answer to the name osrm, and deploy.sh refuses a release that names both', () => {
    // The alias is on `osrm-gateway`; `osrm` holds the same name as its service name.
    // With both profiles on, Docker's resolver has two answers for one name and the
    // function reaches our own map or ridy's at random, per request.
    expect(deployCode).toContain('has_own_osrm=yes');
    expect(deployCode).toContain('has_shared_osrm=yes');
    expect(deployCode).toContain('COMPOSE_PROFILES names both osrm and osrm-shared');
  });

  it('and refuses one that names osrm-shared while our own container is still running, which the profile list cannot see', () => {
    expect(deployCode).toContain('osrm_shared_conflict() {');
    expect(deployCode).toContain('osrm_conflict="$(osrm_shared_conflict "$PROFILES" "$PROJECT_NAME")"');
    // Before the migrations and before anything is recreated.
    const guard = deployCode.indexOf('osrm_shared_conflict "$PROFILES"');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(deployCode.indexOf('step "migrations"'));
    expect(guard).toBeLessThan(deployCode.indexOf('dc up -d --remove-orphans'));
  });

  it('does not dial the name osrm, because that name matches on both of its networks', () => {
    // The sharpest trap in the design: on ridy_default `osrm` is an alias of
    // ridy-osrm-1, and on ours it is now an alias of this container. Verified
    // 25.10.2026 by docker inspect: ridy_default aliases [ridy-osrm-1 osrm].
    expect(folded(conf)).toContain('set $osrm_upstream http://ridy-osrm-1:5000;');
    expect(folded(conf)).not.toMatch(/\$osrm_upstream http:\/\/osrm[:/]/);
    const passes = [...folded(conf).matchAll(/proxy_pass (\S+);/g)].map((m) => m[1]);
    expect(passes).toHaveLength(1);
    expect(passes[0].startsWith('$osrm_upstream/')).toBe(true);
  });
});

describe('the volume guard belongs to the old mode only', () => {
  // A guard that fired in shared mode would refuse every release; one that stopped
  // firing in the old mode would start a container with no map.
  it('is keyed on the osrm service in the RENDERED config, which osrm-shared does not render', () => {
    expect(deployCode).toContain('.get("osrm")');
    expect(deployCode).toContain('if [ -n "$osrm_image" ]; then');
    expect(deployCode).toContain('osrm_data_problem "$osrm_image"');
  });

  it('and the key it reads is "osrm" exactly, never a prefix that would also catch the gateway', () => {
    const reader = /osrm_image="\$\([\s\S]*?\n'\)"/.exec(deployCode)?.[0] ?? '';
    expect(reader).toContain('.get("osrm")');
    expect(reader).not.toContain('osrm-gateway');
    expect(reader).not.toMatch(/startswith|osrm-/);
  });

  it('the gateway has nothing for it to wait for: no volume, no build, no ready.json', () => {
    expect(gateway).not.toMatch(/ready\.json|osrm-data|build:/);
  });
});

describe('nothing else in the stack learned about it', () => {
  it('functions is NOT on ridy\'s network, so the other Kongs and ridy\'s own services stay out of its sight', () => {
    expect(functionsBlock).not.toMatch(/^\s+networks:/m);
    expect(functionsBlock).not.toMatch(/ridy|nominatim|osrm|geocoder/i);
  });

  it('Kong has no route to it: the browser reaches it only through the function, which authenticates', () => {
    expect(kong).not.toMatch(/osrm/i);
    expect(compose).toContain('KONG_PLUGINS: request-transformer,cors,key-auth,acl,request-termination');
  });

  it('the function is still not public and still carries only the base variables', () => {
    expect(router).toMatch(/\['travel-route', \[\.\.\.BASE_ENV\]\],/);
    const publicList = /PUBLIC_FUNCTIONS = new Set<string>\(\[([^\]]*)\]\)/.exec(router);
    expect(publicList?.[1]).toBeTruthy();
    expect(publicList?.[1]).not.toContain('travel-route');
  });
});

describe('the gateway\'s configuration', () => {
  const text = folded(conf);

  it('lets through one route path, answers its own /healthz, and 404s everything else', () => {
    const locations = [...text.matchAll(/location (= |~ )?(\S+) \{/g)].map((m) => `${m[1] ?? ''}${m[2]}`);
    expect(locations).toHaveLength(3);
    expect(locations[0]).toBe('= /healthz');
    expect(locations[1]).toMatch(/^~ "\^\/route\/v1\/driving\//);
    expect(locations[2]).toBe('/');
    expect(text).toMatch(/location \/ \{ return 404; \}/);
    expect(text).toContain('$request_method !~ ^(GET|HEAD)$) { return 405; }');
  });

  it('serves no other OSRM service, version or profile: the dear ones are not named at all', () => {
    for (const service of ['table', 'trip', 'match', 'nearest', 'tile']) {
      expect(text, service).not.toMatch(new RegExp(`/${service}/v`));
    }
    expect((text.match(/\/route\/v1\/driving\//g) ?? []).length).toBe(2); // the location and the proxy_pass
  });

  it('takes exactly two coordinates, matched by the location\'s own regex', () => {
    const location = /location ~ "([^"]+)"/.exec(text)?.[1] ?? '';
    const pattern = new RegExp(location.replace(/\(\?<\w+>/g, '('));
    expect(pattern.test('/route/v1/driving/7.084500,51.165200;6.773500,51.227700')).toBe(true);
    expect(pattern.test('/route/v1/driving/-7.0845,-51.1652;6.7735,51.2277')).toBe(true);
    // A third coordinate is a via route and twice the work; one is not a route at all.
    expect(pattern.test('/route/v1/driving/7.0845,51.1652;6.7735,51.2277;7.1,51.3')).toBe(false);
    expect(pattern.test('/route/v1/driving/7.0845,51.1652')).toBe(false);
    expect(pattern.test('/route/v1/driving/')).toBe(false);
    expect(pattern.test('/route/v1/driving/here;there')).toBe(false);
    expect(pattern.test('/table/v1/driving/7.0845,51.1652;6.7735,51.2277')).toBe(false);
    expect(pattern.test('/route/v1/driving/7.0845,51.1652;6.7735,51.2277/x')).toBe(false);
  });

  it('writes exactly what the function builds, so the allow-list and routeUrl cannot drift', () => {
    // routeUrl() in _shared/travel-route-core.ts: longitude first, toFixed(6), one ";".
    const core = repoFile('supabase/functions/_shared/travel-route-core.ts');
    expect(core).toContain('${baseUrl}/route/v1/driving/${lonLat(pair.from)};${lonLat(pair.to)}');
    expect(core).toContain('value.toFixed(6)');
    const location = /location ~ "([^"]+)"/.exec(text)?.[1] ?? '';
    expect(new RegExp(location.replace(/\(\?<\w+>/g, '(')).test('/route/v1/driving/7.084500,51.165200;6.773500,51.227700')).toBe(true);
  });

  it('rebuilds the query and takes nothing of the caller\'s', () => {
    expect(text).toContain('proxy_pass $osrm_upstream/route/v1/driving/$osrm_coords?overview=false&alternatives=false&steps=false&annotations=false;');
    expect(text).not.toMatch(/\$args|\$query_string|\$request_uri|\$arg_/);
  });

  it('uses a NAMED capture for the coordinates, because the method `if` rewrites the numbered ones', () => {
    // `^(GET|HEAD)$` matches for a GET, so $1 would have become "GET" and gone into
    // the path. A named capture is an nginx variable and no later regex touches it.
    expect(text).toContain('(?<osrm_coords>');
    expect(text).not.toMatch(/proxy_pass [^;]*\$[1-9]/);
  });

  it('looks their service up when a request arrives and never at start: a resolver and a variable, no literal upstream', () => {
    expect(text).toContain('resolver 127.0.0.11 valid=10s ipv6=off;');
    expect(text).not.toMatch(/\bupstream \w+ \{/);
  });

  it('holds one budget for the whole stack: forty a second, a queue of forty, twelve in flight, three seconds', () => {
    expect(text).toContain('limit_req_zone $server_name zone=osrm_rate:64k rate=40r/s;');
    expect(text).toContain('limit_conn_zone $server_name zone=osrm_conn:64k;');
    expect(text).toContain('limit_req zone=osrm_rate burst=40;');
    expect(text).toContain('limit_conn osrm_conn 12;');
    expect(text).toContain('proxy_connect_timeout 2s;');
    expect(text).toContain('proxy_read_timeout 3s;');
    expect(text).toContain('proxy_next_upstream off;');
  });

  it('refuses with a 5xx and never a 429, so the function reads service_error and not bad_answer', () => {
    // interpretOsrmAnswer: a body with no OSRM `code` is service_error at 500 and above
    // and bad_answer below it. A 429 would have sent the next reader looking for a
    // contract bug in OSRM's response instead of at this budget.
    expect(text).toContain('limit_req_status 503;');
    expect(text).toContain('limit_conn_status 503;');
    expect(text).not.toMatch(/limit_(req|conn)_status 4\d\d;/);
  });

  it('never intercepts their error bodies, which carry the OSRM code the function reads', () => {
    // NoSegment and NoRoute arrive as a 400 with a `code`. proxy_intercept_errors would
    // replace that body and every such pair would read bad_answer.
    expect(text).not.toMatch(/proxy_intercept_errors\s+on/);
    expect(text).not.toMatch(/error_page/);
  });

  it('forwards nothing of the caller\'s own and says who is asking', () => {
    expect(text).toContain('proxy_pass_request_headers off;');
    expect(text).toContain('proxy_pass_request_body off;');
    expect(text).toContain('proxy_set_header User-Agent "el-professor-osrm-gateway";');
    expect(text).not.toMatch(/proxy_set_header (Cookie|Authorization|X-Forwarded|X-Real)/i);
  });

  it('does not narrow the Accept header, which is a thing a server can refuse for nothing', () => {
    // The geocoder gateway asked for application/json and ridy's Apache answered 406 for
    // a release and a half (23.10.2026). OSRM picks no format from this header either.
    const accepts = [...conf.matchAll(/proxy_set_header\s+Accept\s+"([^"]*)"/g)].map((m) => m[1]);
    expect(accepts.length).toBeGreaterThan(0);
    for (const accept of accepts) expect(accept, `Accept: ${accept}`).toBe('*/*');
  });

  it('logs no request: the two coordinates are in the path, and so they are in an error line about a failed upstream', () => {
    expect(text).toContain('access_log off;');
    expect(text).toContain('error_log /dev/stderr crit;');
    expect(text).not.toMatch(/access_log (?!off)/);
    expect(text).not.toMatch(/error_log \S+ (warn|error|notice|info|debug)/);
  });
});

describe('the budget is the product\'s own widest fan-out', () => {
  // Derived once, then held as a constraint: a number raised on one side alone would
  // mean the product asks for more than the gateway admits, and a month of rides would
  // come back part-routed with no error anywhere.
  const limitInFlight = Number(/limit_conn osrm_conn (\d+);/.exec(folded(conf))?.[1]);
  const perCall = Number(/const CONCURRENCY = (\d+)/.exec(fn)?.[1]);
  const callsAtOnce = Number(/const DEFAULT_CALL_CONCURRENCY = (\d+);/.exec(prefetch)?.[1]);

  it('reads all three numbers from their own sources', () => {
    expect(limitInFlight).toBeGreaterThan(0);
    expect(perCall).toBeGreaterThan(0);
    expect(callsAtOnce).toBeGreaterThan(0);
  });

  it('multiplies out: the browser\'s calls times each call\'s pairs is what the gateway admits', () => {
    expect(callsAtOnce * perCall).toBe(limitInFlight);
  });

  it('and the queue drains inside the time the function waits for one request', () => {
    // A queued request waits burst/rate at worst. Past REQUEST_TIMEOUT_MS the function
    // has aborted and the wait would buy nothing but a socket on their server.
    const rate = Number(/rate=(\d+)r\/s/.exec(folded(conf))?.[1]);
    const burst = Number(/burst=(\d+);/.exec(folded(conf))?.[1]);
    const waits = Number(/const REQUEST_TIMEOUT_MS = ([\d_]+)/.exec(fn)?.[1].replace(/_/g, ''));
    expect(rate).toBeGreaterThan(0);
    expect(burst).toBeGreaterThan(0);
    expect((burst / rate) * 1000).toBeLessThan(waits);
  });

  it('and the gateway gives up no later than the function does, so no request outlives its caller', () => {
    const read = Number(/proxy_read_timeout (\d+)s;/.exec(folded(conf))?.[1]);
    const waits = Number(/const REQUEST_TIMEOUT_MS = ([\d_]+)/.exec(fn)?.[1].replace(/_/g, ''));
    expect(read * 1000).toBeLessThanOrEqual(waits);
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

const dir = mkdtempSync(join(tmpdir(), 'osrm-gateway-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const posix = (path: string) => path.split(String.fromCharCode(92)).join('/');

function runShell(lines: string[]): string {
  writeFileSync(join(dir, 'run.sh'), `${lines.join('\n')}\n`);
  const r = spawnSync('bash', [posix(join(dir, 'run.sh'))], { encoding: 'utf8', timeout: 20_000 });
  return `${r.stdout}${r.stderr}`.replace(/\r/g, '').trim();
}

function problem(environment: string, list: string): string {
  writeFileSync(join(dir, 'profiles.sh'), `${block(deploySh, 'compose profile checks')}\n`);
  return runShell([
    'set -euo pipefail',
    `cd "${posix(dir)}"`,
    'source ./profiles.sh',
    `compose_profiles_problem "${environment}" "${list}"`,
  ]);
}

describe.skipIf(!hasBash)('compose_profiles_problem (deploy.sh) and the osrm-shared profile', () => {
  it.each([
    ['production', 'osrm-shared'],
    ['production', 'osrm-shared,geocoder'],
    ['staging', 'staging,osrm-shared'],
    ['staging', 'staging,osrm-shared,geocoder'],
    ['staging', 'geocoder,osrm-shared,staging'],
  ])('accepts %s with "%s"', (environment, list) => {
    expect(problem(environment, list)).toBe('');
  });

  it.each([
    ['staging', 'staging,osrm,osrm-shared'],
    ['staging', 'staging,osrm-shared,osrm'],
    ['staging', 'osrm,staging,geocoder,osrm-shared'],
    ['production', 'osrm,osrm-shared'],
  ])('refuses %s with "%s": one name, two containers', (environment, list) => {
    expect(problem(environment, list)).toMatch(/names both osrm and osrm-shared/);
  });

  it('says so before it says anything else, because this one cannot be discovered later', () => {
    // Production with the staging profile AND both osrm profiles: the exclusion is the
    // sentence that comes out, so a release cannot be fixed into the silent failure.
    expect(problem('production', 'staging,osrm,osrm-shared')).toMatch(/names both osrm and osrm-shared/);
    expect(problem('staging', 'osrm,osrm-shared')).toMatch(/names both osrm and osrm-shared/);
  });

  it('still keeps the old answers for everything else', () => {
    expect(problem('staging', 'staging,osrm')).toBe('');
    expect(problem('staging', 'osrm')).toMatch(/staging needs COMPOSE_PROFILES to name staging/);
    expect(problem('production', 'staging,osrm-shared')).toMatch(/production must not enable the staging profile/);
    expect(problem('staging', 'staging,osrm_shared')).toMatch(/does not know \(it knows staging, osrm, osrm-shared and geocoder\)/);
    expect(problem('staging', 'staging,OSRM-SHARED')).toMatch(/does not know/);
    expect(problem('staging', 'staging,osrm-shared,')).toMatch(/has an empty name/);
  });
});

describe.skipIf(!hasBash)('osrm_shared_conflict (deploy.sh)', () => {
  const ask = (list: string, running: string) => {
    writeFileSync(join(dir, 'conflict.sh'), `${block(deploySh, 'compose profile checks')}\n`);
    writeFileSync(join(dir, 'names.txt'), running === '' ? '' : `${running}\n`);
    return runShell([
      'set -euo pipefail',
      `cd "${posix(dir)}"`,
      'source ./conflict.sh',
      'docker() { cat ./names.txt; }',
      `osrm_shared_conflict "${list}" ya-mobility-staging`,
    ]);
  };

  it('says nothing when the shared profile is not named, whatever is running', () => {
    expect(ask('staging,osrm', 'ya-mobility-staging-osrm-1')).toBe('');
    expect(ask('staging', 'ya-mobility-staging-osrm-1')).toBe('');
  });

  it('says nothing when the shared profile is named and nothing of ours is running', () => {
    expect(ask('staging,osrm-shared', '')).toBe('');
  });

  it('names the container and the command to type when both would answer to the name', () => {
    const out = ask('staging,osrm-shared', 'ya-mobility-staging-osrm-1');
    expect(out).toMatch(/own routing container is still running \(ya-mobility-staging-osrm-1\)/);
    expect(out).toContain('docker rm -f ya-mobility-staging-osrm-1');
  });

  it('asks docker by the compose labels, never by a guessed container name', () => {
    expect(deployCode).toContain('label=com.docker.compose.project=$2');
    expect(deployCode).toContain('label=com.docker.compose.service=osrm');
    expect(deployCode).not.toMatch(/\$\{?PROJECT_NAME\}?-osrm-1/);
  });
});

// ── The config file has to reach the host, and a rollback has to survive it ──
// The geocoder gateway's config was introduced without teaching the release path
// to ship it, and deploy.sh died half way through a staging release on
// `sha256sum: geocoder-gateway.conf: No such file or directory` (23.10.2026).
// These pin both halves for this one, and the hash block tolerates "absent".

function hashStep(profiles: string, writeConf: boolean): string {
  const step = mkdtempSync(join(tmpdir(), 'osrm-gateway-hash-'));
  if (writeConf) writeFileSync(join(step, 'osrm-gateway.conf'), 'server { listen 5000; }\n');
  writeFileSync(join(step, 'run.sh'),
    'set -euo pipefail\n' +
    `cd "${posix(step)}"\n` +
    'fail() { echo "REFUSED: $*"; exit 3; }\n' +
    `PROFILES="${profiles}"\n` +
    `${block(deploySh, 'osrm gateway config hash')}\n` +
    'echo "SHA=$OSRM_GATEWAY_CONFIG_SHA"\n');
  const r = spawnSync('bash', [posix(join(step, 'run.sh'))], { encoding: 'utf8', timeout: 20_000 });
  rmSync(step, { recursive: true, force: true });
  return `${r.stdout}${r.stderr}`.replace(/\r/g, '').trim();
}

describe.skipIf(!hasBash)('the gateway config is hashed when present and refused only when needed', () => {
  it('hashes the file when it is there', () => {
    expect(hashStep('staging,osrm-shared', true)).toMatch(/SHA=[0-9a-f]{16}$/);
  });

  it('lets a release through without it while the profile is off, so a rollback works', () => {
    // A rollback keeps the CURRENT deploy.sh against an older release's files, so
    // "absent" is a state the newest code must tolerate, not an error.
    expect(hashStep('staging', false)).toContain('SHA=absent');
    expect(hashStep('staging,osrm,geocoder', false)).toContain('SHA=absent');
  });

  it('refuses when the profile names osrm-shared and the file is not in the release', () => {
    // A gateway started against a config this release never shipped is a proxy whose
    // rules nobody has read - and it proxies to another live product's service.
    for (const list of ['staging,osrm-shared', 'osrm-shared', 'staging,geocoder,osrm-shared', 'osrm-shared,staging']) {
      expect(hashStep(list, false), list).toMatch(/REFUSED: COMPOSE_PROFILES names osrm-shared but/);
    }
  });
});

describe('the release path ships the gateway config', () => {
  const action = repoFile('.github/actions/host/action.yml');
  const wrapper = repoFile('deploy/ci-release.sh');

  it('CI puts it in the tar it sends to the host', () => {
    expect(folded(action)).toContain('deploy/osrm-gateway.conf');
  });

  it('the wrapper stores it with the release and installs it into the live checkout', () => {
    expect(wrapper).toContain('cp "$work/deploy/osrm-gateway.conf" "$rel/deploy/"');
    expect(wrapper).toContain('install -m 644 "$src/deploy/osrm-gateway.conf" "$DIR/deploy/"');
  });

  it('removes it on a rollback onto a release from before it', () => {
    expect(wrapper).toContain('rm -f "$DIR/deploy/osrm-gateway.conf"');
  });

  it('treats it as optional on both read sides, or a rollback would refuse', () => {
    expect(wrapper).toContain('if [ -f "$work/deploy/osrm-gateway.conf" ]');
    expect(wrapper).toContain('if [ -f "$src/deploy/osrm-gateway.conf" ]');
  });
});

describe('CI runs the gateway for real, and only when a change touches it', () => {
  const workflow = repoFile('.github/workflows/pr-checks.yml');
  const job = workflow.slice(workflow.indexOf('\n  osrm-gateway:\n'), workflow.indexOf('\n  rls-kit:\n'));

  it('has a job of its own gated by a scope step that diffs the change against its base', () => {
    expect(job.length).toBeGreaterThan(100);
    expect(job).toContain('git diff --name-only "$BASE_SHA" HEAD');
    expect(job).toContain('osrm-gateway');
    expect(job).toContain('travel-route');
  });

  it('renders the compose file, proves the gateway is off without its profile, and validates the config as nginx', () => {
    expect(job).toContain('osrm-gateway is in the default services');
    expect(job).toContain('docker compose --profile osrm-shared config --services');
    expect(job).toContain('nginx -t');
  });

  it('starts it with nothing behind it, then with the stand-in, and asks it with the e2e', () => {
    expect(job).toContain('node ../tests/deploy/osrm-gateway-e2e.mjs down');
    expect(job).toContain('node tests/deploy/osrm-gateway-e2e.mjs up');
    expect(job).toContain('osrm-gateway-stub.mjs');
    expect(job).toContain('--network-alias ridy-osrm-1');
  });

  it('reads the alias back out of docker, as a whole word, with a control that the check is not vacuous', () => {
    // The service's own name `osrm-gateway` is in that alias list too, so a substring
    // match would have passed with no alias at all. The control feeds the regex a line
    // holding only the service name and requires it NOT to match.
    expect(job).toContain('$v.Aliases');
    expect(job).toContain('the alias check matches the service name alone, so it proves nothing');
  });

  it('runs the real function in the stack\'s own edge-runtime image against it, which is the only proof the alias works', () => {
    const stackImage = /image: (supabase\/edge-runtime:v[\d.]+)/.exec(functionsBlock)?.[1];
    expect(stackImage).toBeDefined();
    expect(job).toContain(`${stackImage} start --main-service /home/deno/functions/main`);
    expect(job).toContain('node tests/deploy/edge-e2e.mjs shared-gateway');
  });

  it('and tells the two failures apart: their service gone is service_error, the gateway gone is unreachable', () => {
    // A 502 from a gateway that is up is NOT "unreachable" - the name still resolves.
    // The first version of this job asked for `osrm-down` in both places, where the
    // reason list would have refused the first one.
    expect(job).toContain('node tests/deploy/edge-e2e.mjs upstream-down');
    expect(job).toContain('node tests/deploy/edge-e2e.mjs osrm-down');
    const e2e = repoFile('tests/deploy/edge-e2e.mjs');
    expect(e2e).toContain("mode === 'upstream-down'");
    expect(e2e).toContain("r.reason === 'service_error'");
  });

  it('proves deploy.sh would refuse a release that names both profiles, with its own shell', () => {
    expect(job).toContain('compose_profiles_problem');
    expect(job).toContain('osrm_data_problem');
  });

  it('and runs the stale-container guard against real docker labels, which a stubbed docker cannot show', () => {
    expect(job).toContain('osrm_shared_conflict');
    expect(job).toContain('--label com.docker.compose.service=osrm');
  });

  it('checks the gateway logs no coordinate, with a control that shows the check can fail', () => {
    expect(job).toContain('the gateway\'s log holds a coordinate');
    expect(job).toContain('access_log /dev/stdout');
  });
});
