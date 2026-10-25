// CI only (the osrm job in .github/workflows/pr-checks.yml).
//
// The real travel-route function, in the real supabase/edge-runtime image, next to the real
// osrm container, with tests/deploy/edge-stub.mjs standing in for GoTrue and the database.
// It asks what a browser would, and prints every exchange so the run is the evidence.
//
//   node tests/deploy/edge-e2e.mjs warm        first request only: the worker downloads its modules
//   node tests/deploy/edge-e2e.mjs             the whole conversation
//   node tests/deploy/edge-e2e.mjs osrm-down   with the container stopped: failure is a reason, not a number
//
// And, in the osrm-gateway job, the same function with the gateway to ridy's OSRM behind
// the name `osrm` instead of a container of our own (deploy/osrm-gateway.conf, standing
// in front of tests/deploy/osrm-gateway-stub.mjs):
//
//   node tests/deploy/edge-e2e.mjs shared-gateway   routed through the gateway
//   node tests/deploy/edge-e2e.mjs upstream-down    their service gone, our gateway up: service_error
//   node tests/deploy/edge-e2e.mjs osrm-down        the gateway stopped too: the name resolves to nothing
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

/**
 * The whole point of the shared gateway: OSRM_ORIGIN is still http://osrm:5000, and that
 * name now resolves to the gateway through a compose network alias rather than to a
 * routing container of ours. Nothing in the function changed, so the only way to know
 * the alias works is to make the function ask and see whose answer comes back.
 */
async function sharedGateway() {
  const good = await call('a person with an active company asks for two pairs, through the gateway', {
    bearer: person,
    body: { pairs: [pair('a'), pair('b', { lat: 51.2277, lon: 6.7735 }, { lat: 51.1652, lon: 7.0845 })] },
  });
  check('answers 200 ok', good.status === 200 && good.json?.ok === true);
  const results = good.json?.results ?? [];
  check('both pairs are routes with a drive and a snap distance, in request order',
    results.length === 2 && results.every((r) => r.kind === 'route' && r.durationSeconds > 0 && r.distanceMeters > 500)
      && results[0].id === 'a' && results[1].id === 'b', JSON.stringify(results));
  // ridy's osrm-routed was started without --data_version, so no answer of theirs has
  // one. The function must report null rather than invent a stamp, and osrmSourceLabel
  // then prints `osrm` without a month. This is what shared mode gives up.
  check('and no data_version, because theirs carries none', good.json?.data_version === null, JSON.stringify(good.json?.data_version));

  // Their own refusals have to survive the proxy with their OSRM code: a 400 body that
  // nginx swallowed would turn every one of these into bad_answer.
  const nowhere = await call('a point with no road near it', { bearer: person, body: { pairs: [pair('sea', { lat: 56, lon: 3 }, { lat: 51.2277, lon: 6.7735 })] } });
  check('is reported not_on_road, the OSRM code read through the gateway',
    nowhere.json?.results?.[0]?.kind === 'unavailable' && nowhere.json.results[0].reason === 'not_on_road', JSON.stringify(nowhere.json?.results));
  const island = await call('two points a car cannot connect', { bearer: person, body: { pairs: [pair('island', { lat: 54.18, lon: 7.7 }, { lat: 51.2277, lon: 6.7735 })] } });
  check('is reported no_route', island.json?.results?.[0]?.reason === 'no_route', JSON.stringify(island.json?.results));

  // The gate is the same one, and it matters more in shared mode: the CPU behind it is
  // another live product's.
  const refused = await call('the anon key, with ridy\'s OSRM behind the gateway', { bearer: anon, body: { pairs: [pair('a')] } });
  check('the anon key is still refused before anything is asked of them', refused.status === 401 && refused.json?.reason === 'not_authenticated');
}

/**
 * Their service is gone and our gateway is still up. The gateway answers 502, which
 * interpretOsrmAnswer reads as `service_error` and NOT as `unreachable` - the name still
 * resolves, to a proxy that cannot reach anyone. Two different reasons for two different
 * failures, which is the point of having reasons at all.
 */
async function upstreamGone() {
  const down = await call('ridy\'s OSRM is gone, our gateway is up', { bearer: person, body: { pairs: [pair('a'), pair('b')] } });
  check('still a 200, with a reason on every pair and no number', down.status === 200 && down.json?.ok === true
    && (down.json.results ?? []).length === 2 && down.json.results.every((r) => r.kind === 'unavailable'), JSON.stringify(down.json));
  check('and the reason is service_error: the gateway answered, their service did not',
    (down.json?.results ?? []).every((r) => r.reason === 'service_error'), JSON.stringify((down.json?.results ?? []).map((r) => r.reason)));
  check('and no data_version, because nothing was read', down.json?.data_version === null);
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
  } else if (mode === 'shared-gateway') {
    await sharedGateway();
  } else if (mode === 'upstream-down') {
    await upstreamGone();
  } else {
    await whole();
  }
} catch (error) {
  console.log(`FAIL the conversation itself threw: ${error}`);
  failures.push('threw');
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(' | ')}` : '\nall ok');
process.exit(mode === 'warm' ? 0 : failures.length ? 1 : 0);
