/**
 * The geocoder gateway's deployment, pinned as text and, for the shell that
 * decides things, run for real. (What the gateway DOES, with nginx running, is
 * tests/deploy/gateway-e2e.mjs in the geocoder job of CI.)
 *
 * The Nominatim behind it is ridy's and is not touched. What this guards is the
 * argument for how we reach it, which any well-meant edit could lose silently:
 *
 *   - `functions` is NOT on ridy_default. Measured on 22.10.2026, that network
 *     holds both Kongs under the name `kong` and ridy's OSRM under `osrm`, which
 *     functions reaches through http://kong:8000 and travel-route calls; and
 *     every ridy container would reach the container that holds the service-role
 *     key. Only the gateway is on both networks;
 *   - the gateway holds no credential, publishes no host port, is hardened, is off
 *     unless the `geocoder` profile is named, and mounts nothing but its config;
 *   - it passes on GET /search and /status and nothing else, rebuilds the query
 *     from three arguments, holds one budget for the stack, looks the service up
 *     when a request arrives, and logs no request (an address is in the query);
 *   - the function that calls it holds neither the service key nor SMTP, is not
 *     public, logs counts only, and the host and port it calls are the compose
 *     service's.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GEOCODER_ORIGIN } from '../../supabase/functions/_shared/geocode-core';

const repoFile = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
/** Whitespace folded, so a re-indented line is the same line. */
const folded = (text: string) => code(text).replace(/\s+/g, ' ');

const compose = repoFile('deploy/docker-compose.yml');
const kong = repoFile('deploy/kong.yml');
const deploySh = repoFile('deploy/deploy.sh');
const conf = repoFile('deploy/geocoder-gateway.conf');
const router = repoFile('supabase/functions/main/index.ts');
const fn = repoFile('supabase/functions/geocode-address/index.ts');

/** One service's block, from its key to the next two-space key or section banner. */
function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`docker-compose.yml has no ${name} service`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}(# ── |[a-z][a-z-]*:\n)/);
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

const gateway = serviceBlock('geocoder-gateway');
const functionsBlock = serviceBlock('functions');
const webBlock = serviceBlock('web');

describe('the gateway service holds no credential and publishes nothing', () => {
  it('has no environment, secret or env file at all', () => {
    expect(gateway).not.toMatch(/^\s+environment:/m);
    expect(gateway).not.toMatch(/^\s+env_file:/m);
    expect(gateway).not.toMatch(/JWT|SERVICE_ROLE|ANON_KEY|DATABASE|POSTGRES|PGPASSWORD|SECRET|PEPPER|SMTP|PASSWORD|TOKEN/i);
  });

  it('mounts exactly one file, its own configuration, read-only', () => {
    expect(listUnder(gateway, 'volumes')).toEqual(['./geocoder-gateway.conf:/etc/nginx/conf.d/default.conf:ro']);
  });

  it('publishes no host port', () => {
    expect(gateway).not.toMatch(/^\s+ports:/m);
    expect(gateway).toMatch(/expose:\s*\n\s+- '8080'/);
  });

  it('is on this stack\'s network and ridy\'s, and on no other', () => {
    expect(listUnder(gateway, 'networks')).toEqual(['default', 'ridy']);
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

  it('is off unless the geocoder profile is named, so the release that adds it starts and pulls nothing', () => {
    expect(gateway).toMatch(/^ {4}profiles: \[geocoder\]$/m);
  });

  it('is recreated when its configuration changes, through the hash deploy.sh exports', () => {
    expect(gateway).toMatch(/el-professor\.config-sha: \$\{GEOCODER_CONFIG_SHA:-unset\}/);
    expect(deploySh).toMatch(/GEOCODER_CONFIG_SHA="\$\(sha256sum geocoder-gateway\.conf \| cut -c1-16\)"/);
    expect(deploySh).toMatch(/export KONG_CONFIG_SHA NGINX_CONFIG_SHA GEOCODER_CONFIG_SHA/);
  });

  it('is healthy when nginx is, not when ridy\'s service is: the check asks its own /healthz', () => {
    expect(gateway).toMatch(/http:\/\/127\.0\.0\.1:8080\/healthz/);
  });
});

describe('nothing else in the stack learned about it', () => {
  it('functions is NOT on ridy\'s network, and names no ridy service, so the other Kongs and ridy\'s OSRM stay out of its sight', () => {
    expect(functionsBlock).not.toMatch(/^\s+networks:/m);
    expect(functionsBlock).not.toMatch(/ridy|nominatim|geocoder/i);
  });

  it('exactly the services that were on ridy\'s network still are, plus the gateway', () => {
    const section = compose.slice(compose.indexOf('\nservices:\n'), compose.indexOf('\nvolumes:\n'));
    const services = [...section.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
    expect(services).toEqual(expect.arrayContaining(['functions', 'kong', 'geocoder-gateway', 'osrm']));
    const onRidy = services.filter((name) => /^\s+- ridy$/m.test(serviceBlock(name))).sort();
    expect(onRidy).toEqual(['geocoder-gateway', 'kong', 'mailpit', 'web']);
  });

  it('Kong has no route to it: the browser reaches it only through the function, which authenticates', () => {
    expect(kong).not.toMatch(/geocod|nominatim/i);
  });
});

describe('the function holds only what it needs', () => {
  it('has a FUNCTION_ENV entry of the base variables and nothing more, and is not public', () => {
    expect(router).toMatch(/\['geocode-address', \[\.\.\.BASE_ENV\]\],/);
    const publicList = /PUBLIC_FUNCTIONS = new Set<string>\(\[([^\]]*)\]\)/.exec(router);
    expect(publicList?.[1]).toBeTruthy();
    expect(publicList?.[1]).not.toContain('geocode-address');
  });

  it('never reads the service key, SMTP or the pepper, and calls no host but the constant', () => {
    expect(fn).not.toMatch(/SERVICE_ROLE|SMTP|PEPPER|DATABASE_URL/);
    expect(code(fn)).not.toMatch(/https?:\/\//);
    expect(fn).toContain('baseUrl: GEOCODER_ORIGIN');
  });

  it('asks GoTrue for a person and the database for an active company before it asks the geocoder anything', () => {
    const order = ['auth.getUser()', "rpc('get_active_company_id')", 'parseGeocodeBody(', 'geocodeAddresses('].map((needle) => fn.indexOf(needle));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('logs counts and nothing from the request', () => {
    const logCall = /console\.log\(JSON\.stringify\(\{[\s\S]*?\}\)\)/.exec(fn)?.[0] ?? '';
    expect(logCall).toContain('addresses: parsed.queries.length');
    expect(logCall).toContain('outcome: tally(outcome.results)');
    expect(logCall).not.toMatch(/text|\.id\b|lat\b|lon\b|body/);
  });

  it('calls the host and port the compose service has', () => {
    expect(new URL(GEOCODER_ORIGIN).hostname).toBe('geocoder-gateway');
    expect(compose).toContain('\n  geocoder-gateway:\n');
    expect(new URL(GEOCODER_ORIGIN).port).toBe(gateway.match(/expose:\s*\n\s+- '(\d+)'/)?.[1]);
  });
});

describe('the gateway\'s configuration', () => {
  const text = folded(conf);

  it('lets through GET /search and GET /status, answers its own /healthz, and 404s everything else', () => {
    const locations = [...text.matchAll(/location (= )?(\S+) \{/g)].map((m) => `${m[1] ?? ''}${m[2]}`);
    expect(locations).toEqual(['= /healthz', '= /status', '= /search', '/']);
    expect(text).toMatch(/location \/ \{ return 404; \}/);
    expect((text.match(/\$request_method !~ \^\(GET\|HEAD\)\$\) \{ return 405; \}/g) ?? []).length).toBe(2);
  });

  it('rebuilds the query from three arguments and fixes the rest, and takes no other argument of the caller\'s', () => {
    expect([...new Set(text.match(/\$arg_\w+/g))].sort()).toEqual(['$arg_city', '$arg_postalcode', '$arg_street']);
    expect(text).toContain('/search?street=$arg_street&postalcode=$arg_postalcode&city=$arg_city&countrycodes=de&format=jsonv2&addressdetails=1&limit=3&accept-language=de&layer=address;');
    expect(text).not.toMatch(/\$args|\$query_string|\$request_uri/);
  });

  it('refuses a search that lacks any of the three', () => {
    for (const name of ['street', 'postalcode', 'city']) expect(text).toContain(`if ($arg_${name} = "") { return 400; }`);
  });

  it('looks their service up when a request arrives and never at start: a resolver and a variable, no literal upstream', () => {
    expect(text).toContain('resolver 127.0.0.11 valid=10s ipv6=off;');
    expect(text).toContain('set $geocoder_upstream http://nominatim:8080;');
    const passes = [...text.matchAll(/proxy_pass (\S+);/g)].map((m) => m[1]);
    expect(passes).toHaveLength(2);
    expect(passes.every((p) => p.startsWith('$geocoder_upstream/'))).toBe(true);
    expect(text).not.toMatch(/\bupstream \w+ \{/);
  });

  it('holds one budget for the whole stack: five a second, a queue of ten, two in flight, five seconds', () => {
    expect(text).toContain('limit_req_zone $server_name zone=geocoder_rate:64k rate=5r/s;');
    expect(text).toContain('limit_conn_zone $server_name zone=geocoder_conn:64k;');
    expect((text.match(/limit_req zone=geocoder_rate burst=10;/g) ?? []).length).toBe(2);
    expect((text.match(/limit_conn geocoder_conn 2;/g) ?? []).length).toBe(2);
    expect(text).toContain('limit_req_status 429;');
    expect(text).toContain('proxy_connect_timeout 2s;');
    expect(text).toContain('proxy_read_timeout 5s;');
    expect(text).toContain('proxy_next_upstream off;');
  });

  it('forwards nothing of the caller\'s own and says who is asking', () => {
    expect(text).toContain('proxy_pass_request_headers off;');
    expect(text).toContain('proxy_pass_request_body off;');
    expect(text).toContain('proxy_set_header User-Agent "el-professor-geocoder-gateway";');
    expect(text).not.toMatch(/proxy_set_header (Cookie|Authorization|X-Forwarded|X-Real)/i);
  });

  it('logs no request: an address is in the query string, and so it is in an error line about a failed upstream', () => {
    expect(text).toContain('access_log off;');
    expect(text).toContain('error_log /dev/stderr crit;');
    expect(text).not.toMatch(/access_log (?!off)/);
    expect(text).not.toMatch(/error_log \S+ (warn|error|notice|info|debug)/);
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

const dir = mkdtempSync(join(tmpdir(), 'geocoder-deploy-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const posix = (path: string) => path.split(String.fromCharCode(92)).join('/');

function problem(environment: string, list: string): string {
  writeFileSync(join(dir, 'profiles.sh'), `${block(deploySh, 'compose profile checks')}\n`);
  writeFileSync(join(dir, 'run.sh'), `set -euo pipefail\ncd "${posix(dir)}"\nsource ./profiles.sh\ncompose_profiles_problem "${environment}" "${list}"\n`);
  const r = spawnSync('bash', [posix(join(dir, 'run.sh'))], { encoding: 'utf8', timeout: 20_000 });
  return `${r.stdout}${r.stderr}`.replace(/\r/g, '').trim();
}

describe.skipIf(!hasBash)('compose_profiles_problem (deploy.sh) and the geocoder profile', () => {
  it.each([
    ['production', 'geocoder'],
    ['production', 'osrm,geocoder'],
    ['staging', 'staging,geocoder'],
    ['staging', 'staging,osrm,geocoder'],
    ['staging', 'geocoder,staging,osrm'],
  ])('accepts %s with "%s"', (environment, list) => {
    expect(problem(environment, list)).toBe('');
  });

  it('keeps staging\'s mail catcher off production and insists on it for staging, whatever else is named', () => {
    expect(problem('production', 'staging,geocoder')).toMatch(/production must not enable the staging profile/);
    expect(problem('staging', 'geocoder')).toMatch(/staging needs COMPOSE_PROFILES to name staging/);
  });

  it('still refuses a name it does not know, and says which names it does', () => {
    expect(problem('staging', 'staging,geocode')).toMatch(/does not know \(it knows staging, osrm and geocoder\)/);
    expect(problem('production', 'Geocoder')).toMatch(/does not know/);
    expect(problem('production', 'nominatim')).toMatch(/does not know/);
  });
});
