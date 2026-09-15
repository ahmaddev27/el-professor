/**
 * The compose and Kong settings that keep account creation closed, pinned.
 *
 * GoTrue opens its own signup while Google sign-in is on (GoTrue v2.170.0 will
 * not create a Google account otherwise). What keeps /signup, /otp and
 * /magiclink from creating accounts then is Kong's auth-v1-closed block, what
 * keeps signup closed while Google is off is the auth entrypoint, and what
 * keeps every other provider out is a row of literal falses. Each of those is a
 * one-line edit away from an open door, so each is pinned here. A deliberate
 * change updates this test in the same commit, with the reason.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoFile = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

interface ComposeService {
  image?: string;
  entrypoint?: string[] | string;
  command?: unknown;
  environment?: Record<string, unknown>;
}
interface KongRoute {
  name: string;
  paths?: string[];
  strip_path?: boolean;
  hosts?: unknown;
  methods?: unknown;
  headers?: unknown;
}
interface KongService {
  name: string;
  url: string;
  routes?: KongRoute[];
  plugins?: Array<{ name: string; config?: Record<string, unknown> }>;
}

const compose = load(repoFile('deploy/docker-compose.yml')) as { services: Record<string, ComposeService> };
const kongText = repoFile('deploy/kong.yml');
const kong = load(kongText) as { services: KongService[] };
const deploySh = repoFile('deploy/deploy.sh');

const auth = compose.services.auth;
const authEnv = auth.environment ?? {};

const CLOSED_PATHS = ['/auth/v1/signup', '/auth/v1/otp', '/auth/v1/magiclink'];
const CLOSED_MESSAGE = 'This route is closed by the gateway';
const ENTRYPOINT_SCRIPT =
  'if [ "$$GOTRUE_EXTERNAL_GOOGLE_ENABLED" = true ]; then export GOTRUE_DISABLE_SIGNUP=false GOTRUE_MAILER_AUTOCONFIRM=false; fi; exec auth';

describe('docker-compose.yml: auth', () => {
  it('runs the GoTrue version whose behaviour the comments and the entrypoint were checked against', () => {
    // A new version must be re-read for DetermineAccountLinking, the
    // DisableSignup check on external accounts, and /settings' field names.
    expect(auth.image).toBe('supabase/gotrue:v2.170.0');
    expect(auth.command).toBeUndefined();
  });

  it('takes Google from the switch and the client from .env, with GoTrue callback behind the API URL', () => {
    expect(authEnv.GOTRUE_EXTERNAL_GOOGLE_ENABLED).toBe('${GOOGLE_SIGNIN_ENABLED:-false}');
    expect(authEnv.GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID).toBe('${GOOGLE_CLIENT_ID:-}');
    expect(authEnv.GOTRUE_EXTERNAL_GOOGLE_SECRET).toBe('${GOOGLE_CLIENT_SECRET:-}');
    expect(authEnv.GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI).toBe('${PUBLIC_URL}/auth/v1/callback');
    expect(authEnv.API_EXTERNAL_URL).toBe('${PUBLIC_URL:?set PUBLIC_URL}');
  });

  it('turns every other way to create or attach an account off as a literal', () => {
    expect(authEnv.GOTRUE_EXTERNAL_PHONE_ENABLED).toBe('false');
    expect(authEnv.GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED).toBe('false');
    expect(authEnv.GOTRUE_SAML_ENABLED).toBe('false');
    expect(authEnv.GOTRUE_SECURITY_MANUAL_LINKING_ENABLED).toBe('false');
    const providerSwitches = Object.keys(authEnv).filter((name) => /^GOTRUE_EXTERNAL_.+_ENABLED$/.test(name)).sort();
    expect(providerSwitches).toEqual([
      'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED',
      'GOTRUE_EXTERNAL_GOOGLE_ENABLED',
      'GOTRUE_EXTERNAL_PHONE_ENABLED',
    ]);
  });

  it('starts from signup closed and autoconfirm on, as literals no .env value can change', () => {
    expect(authEnv.GOTRUE_DISABLE_SIGNUP).toBe('true');
    expect(authEnv.GOTRUE_MAILER_AUTOCONFIRM).toBe('true');
    const interpolatesSwitch = Object.entries(authEnv)
      .filter(([, value]) => typeof value === 'string' && value.includes('GOOGLE_SIGNIN_ENABLED'))
      .map(([name]) => name);
    expect(interpolatesSwitch).toEqual(['GOTRUE_EXTERNAL_GOOGLE_ENABLED']);
  });

  it('derives signup and autoconfirm from the Google switch inside the container', () => {
    expect(auth.entrypoint).toEqual(['/bin/sh', '-c', ENTRYPOINT_SCRIPT]);
  });
});

// The entrypoint's condition, run by a real sh with `exec auth` replaced by a
// print of the two variables GoTrue would read.
const shell = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8', timeout: 20_000 });
const hasSh = shell.status === 0 && shell.stdout.trim() === 'ok';

describe.skipIf(!hasSh)('the auth entrypoint under sh', () => {
  const script = ENTRYPOINT_SCRIPT.replace(/\$\$/g, '$').replace(
    /exec auth$/,
    'printf "%s %s" "$GOTRUE_DISABLE_SIGNUP" "$GOTRUE_MAILER_AUTOCONFIRM"',
  );

  const effective = (google: string | undefined) => {
    const environment: Record<string, string> = {
      ...process.env,
      GOTRUE_DISABLE_SIGNUP: 'true',
      GOTRUE_MAILER_AUTOCONFIRM: 'true',
    } as Record<string, string>;
    delete environment.GOTRUE_EXTERNAL_GOOGLE_ENABLED;
    if (google !== undefined) environment.GOTRUE_EXTERNAL_GOOGLE_ENABLED = google;
    return spawnSync('sh', ['-c', script], { encoding: 'utf8', env: environment, timeout: 20_000 }).stdout;
  };

  it('opens signup and turns autoconfirm off for exactly the string true', () => {
    expect(effective('true')).toBe('false false');
  });

  it.each([[undefined], [''], ['false'], ['TRUE'], ['True'], ['1'], [' true'], ['true '], ['yes']])(
    'keeps signup closed and autoconfirm on for %p',
    (google) => {
      expect(effective(google)).toBe('true true');
    },
  );
});

describe('docker-compose.yml: kong', () => {
  it('loads request-termination next to the plugins kong.yml already uses', () => {
    const plugins = String(compose.services.kong.environment?.KONG_PLUGINS).split(',');
    expect(plugins).toEqual(expect.arrayContaining(['request-transformer', 'cors', 'key-auth', 'acl', 'request-termination']));
  });
});

describe('kong.yml', () => {
  const service = (name: string) => {
    const found = kong.services.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`kong.yml has no service ${name}`);
    return found;
  };

  it('stays safe for the eval that renders it: no backticks or dollar-parens', () => {
    expect(kongText).not.toMatch(/`|\$\(/);
  });

  it('closes the three account-creating routes for every method and host, with nothing behind them', () => {
    const closed = service('auth-v1-closed');
    // A dead port: a lost plugin answers 502 instead of reaching GoTrue.
    expect(closed.url).toBe('http://127.0.0.1:1/');
    expect(closed.routes).toHaveLength(1);
    const [route] = closed.routes ?? [];
    expect(route.paths).toEqual(CLOSED_PATHS);
    expect(route.strip_path).toBe(true);
    expect([route.hosts, route.methods, route.headers]).toEqual([undefined, undefined, undefined]);
    expect(closed.plugins).toEqual([
      { name: 'request-termination', config: { status_code: 403, message: CLOSED_MESSAGE } },
    ]);
  });

  it('matches the closed paths ahead of the open auth route: plain prefixes, longest first', () => {
    const routes = kong.services.flatMap((entry) => (entry.routes ?? []).map((route) => ({ service: entry.name, route })));
    const allPaths = routes.flatMap(({ route }) => route.paths ?? []);
    // Kong 2.8.1 treats a path with any other character as a regex, which would
    // take it out of the longest-prefix ordering this relies on.
    for (const path of allPaths) expect(path).toMatch(/^[a-zA-Z0-9.\-_~/%]*$/);

    expect(service('auth-v1-open').routes?.map((route) => route.paths)).toEqual([['/auth/v1/']]);
    for (const closedPath of CLOSED_PATHS) {
      const covering = routes
        .flatMap(({ service: name, route }) => (route.paths ?? []).map((path) => ({ name, path })))
        .filter(({ path }) => closedPath.startsWith(path))
        .sort((a, b) => b.path.length - a.path.length);
      expect(covering[0]).toEqual({ name: 'auth-v1-closed', path: closedPath });
    }
  });

  it('is what deploy.sh probes for, message and paths alike', () => {
    expect(deploySh).toContain(`CLOSED_ROUTES="${CLOSED_PATHS.join(' ')}"`);
    expect(deploySh).toContain(`CLOSED_MESSAGE="${CLOSED_MESSAGE}"`);
  });
});
