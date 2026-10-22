// CI only (the osrm job in .github/workflows/pr-checks.yml).
//
// The real travel-route function, in the real supabase/edge-runtime image, next to the real
// osrm container, with tests/deploy/edge-stub.mjs standing in for GoTrue and the database.
// It asks what a browser would, and prints every exchange so the run is the evidence.
//
//   node tests/deploy/edge-e2e.mjs warm        first request only: the worker downloads its modules
//   node tests/deploy/edge-e2e.mjs             the whole conversation
//   node tests/deploy/edge-e2e.mjs osrm-down   with the container stopped: failure is a reason, not a number
import crypto from 'node:crypto';

const BASE = process.env.EDGE_URL ?? 'http://127.0.0.1:9000';
const SECRET = process.env.JWT_SECRET ?? '';
const ORIGIN = 'https://app.example.test';
const WITH_COMPANY = '00000000-0000-4000-8000-000000000001';
const WITHOUT_COMPANY = '00000000-0000-4000-8000-000000000002';
const mode = process.argv[2] ?? 'all';

const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(claims) {
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  return `${unsigned}.${crypto.createHmac('sha256', SECRET).update(unsigned).digest('base64url')}`;
}
const person = token({ role: 'authenticated', sub: WITH_COMPANY });
const lonely = token({ role: 'authenticated', sub: WITHOUT_COMPANY });
// What the anon key is: signed by this stack, so the router admits it, and nobody.
const anon = token({ role: 'anon' });

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures.push(label);
}

async function call(label, { method = 'POST', bearer, body, headers = {} }) {
  const response = await fetch(`${BASE}/travel-route`, {
    method,
    headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  console.log(`\n## ${label}\n${method} /travel-route -> ${response.status}\n${text.slice(0, 700)}`);
  return { status: response.status, json, response };
}

const here = { lat: 51.1657, lon: 7.0671 };
const near = { lat: 51.1757, lon: 7.0771 };
const pair = (id, from = here, to = near) => ({ id, from, to });

async function whole() {
  const none = await call('no token at all: the router refuses', { bearer: null, body: { pairs: [pair('a')] } });
  check('no token is a 401 from the router', none.status === 401);

  const refused = await call('the anon key: signed by this stack, so the router admits it, and the function must not', { bearer: anon, body: { pairs: [pair('a')] } });
  check('the anon key is refused as not_authenticated (401)', refused.status === 401 && refused.json?.reason === 'not_authenticated');

  const homeless = await call('a person with no active company', { bearer: lonely, body: { pairs: [pair('a')] } });
  check('a person without a company gets no_company (403)', homeless.status === 403 && homeless.json?.reason === 'no_company');

  const good = await call('a person with an active company asks for two pairs', { bearer: person, body: { pairs: [pair('near'), pair('far', here, { lat: 48.1374, lon: 11.5755 })] } });
  check('answers 200 ok with a data_version', good.status === 200 && good.json?.ok === true && /^\d{4}-\d{2}-\d{2}T/.test(good.json?.data_version ?? ''));
  const [near1, far] = good.json?.results ?? [];
  check('the near pair is a route with a plausible drive', near1?.kind === 'route' && near1.durationSeconds > 0 && near1.distanceMeters > 500 && near1.snapMeters?.every((m) => m < 250));
  check('the pair far outside the map is reported with its large snap distance, not as a failure', far?.kind === 'route' && far.snapMeters[1] > 250);
  check('results come back in request order, by id', near1?.id === 'near' && far?.id === 'far');

  const preflight = await fetch(`${BASE}/travel-route`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  check('the preflight from the app origin is allowed', preflight.status === 200 && preflight.headers.get('access-control-allow-origin') === ORIGIN);
  const stranger = await fetch(`${BASE}/travel-route`, { method: 'OPTIONS', headers: { Origin: 'https://elsewhere.example', 'Access-Control-Request-Method': 'POST' } });
  check('a preflight from another origin gets no allow-origin', stranger.headers.get('access-control-allow-origin') === null);

  const many = Array.from({ length: 101 }, (_, i) => pair(`p${i}`));
  check('101 pairs are refused too_many_pairs (413)', (await call('101 pairs', { bearer: person, body: { pairs: many } })).status === 413);
  check('a latitude of 91 is refused bad_coordinate (400)', (await call('bad coordinate', { bearer: person, body: { pairs: [pair('a', { lat: 91, lon: 7 })] } })).json?.reason === 'bad_coordinate');
  check('a repeated id is refused duplicate_id (400)', (await call('duplicate id', { bearer: person, body: { pairs: [pair('a'), pair('a')] } })).json?.reason === 'duplicate_id');
  check('text that is not JSON is refused invalid_request (400)', (await call('not JSON', { bearer: person, body: '{"pairs":' })).json?.reason === 'invalid_request');
  check('a GET is refused method_not_allowed (405)', (await call('GET', { method: 'GET', bearer: person })).status === 405);
}

async function containerGone() {
  const down = await call('the routing container is stopped', { bearer: person, body: { pairs: [pair('a'), pair('b')] } });
  check('still a 200, with a reason on every pair and no number', down.status === 200 && down.json?.ok === true && (down.json.results ?? []).length === 2
    && down.json.results.every((r) => r.kind === 'unavailable' && ['unreachable', 'timeout'].includes(r.reason)), JSON.stringify(down.json));
  check('and no data_version, because nothing was read', down.json?.data_version === null);
}

try {
  if (mode === 'warm') {
    await call('warm-up (the worker fetches its modules on first use)', { bearer: person, body: { pairs: [pair('warm')] } });
  } else if (mode === 'osrm-down') {
    await containerGone();
  } else {
    await whole();
  }
} catch (error) {
  console.log(`FAIL the conversation itself threw: ${error}`);
  failures.push('threw');
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(' | ')}` : '\nall ok');
process.exit(mode === 'warm' ? 0 : failures.length ? 1 : 0);
