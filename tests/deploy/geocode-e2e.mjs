// CI only (the geocoder job in .github/workflows/pr-checks.yml).
//
// The real geocode-address function, in the real supabase/edge-runtime image, behind the real gateway
// container, with tests/deploy/nominatim-stub.mjs standing in for ridy's Nominatim and
// tests/deploy/edge-stub.mjs for GoTrue and the database. It asks what a browser would, prints every
// exchange, and reads the stub's own record of what reached ridy's side.
//
//   node tests/deploy/geocode-e2e.mjs warm           first request only: the worker downloads its modules
//   node tests/deploy/geocode-e2e.mjs                the whole conversation
//   node tests/deploy/geocode-e2e.mjs upstream-down  their service is gone: a reason on every address, no coordinate
//   node tests/deploy/geocode-e2e.mjs gateway-down   our gateway is stopped: the same
import crypto from 'node:crypto';

const BASE = process.env.EDGE_URL ?? 'http://127.0.0.1:9000';
const STUB = process.env.STUB_URL ?? '';
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
const anon = token({ role: 'anon' });

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures.push(label);
}

async function call(label, { method = 'POST', bearer, body, headers = {} }) {
  const started = Date.now();
  const response = await fetch(`${BASE}/geocode-address`, {
    method,
    headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  console.log(`\n## ${label}\n${method} /geocode-address -> ${response.status} in ${Date.now() - started} ms\n${text.slice(0, 600)}`);
  return { status: response.status, json, response, ms: Date.now() - started };
}

const address = (id, text) => ({ id, text });
const stub = async (path) => (STUB ? (await fetch(`${STUB}${path}`, { method: path === '/__stats' ? 'GET' : 'POST' })).json() : null);
const SPEC = [
  ['a', 'Hauptstraße 12, 42651 Solingen, Deutschland', (r) => r.kind === 'located' && r.lat === 51.1722 && r.lon === 7.0833 && r.osm === 'node/4711' && r.precision === 'exact'],
  ['b', 'Doppelweg 5, 42651 Solingen, Deutschland', (r) => r.kind === 'located'],
  ['c', 'Zwillingsweg 7, 42651 Solingen, Deutschland', (r) => r.kind === 'unlocated' && r.reason === 'ambiguous'],
  ['d', 'Nurstraße 9, 42651 Solingen, Deutschland', (r) => r.kind === 'unlocated' && r.reason === 'too_coarse'],
  ['e', 'Postleitzahlweg 11, 42651 Solingen, Deutschland', (r) => r.kind === 'unlocated' && r.reason === 'postcode_mismatch'],
  ['f', 'Nirgendwoweg 13, 42651 Solingen, Deutschland', (r) => r.kind === 'unlocated' && r.reason === 'not_found'],
  ['g', 'Kaputtweg 15, 42651 Solingen, Deutschland', (r) => r.kind === 'unlocated' && r.reason === 'bad_answer'],
  ['h', 'Königstraße, 42651 Solingen, Deutschland', (r) => r.kind === 'unlocated' && r.reason === 'no_house_number'],
  ['i', 'irgendwo', (r) => r.kind === 'unlocated' && r.reason === 'unparseable'],
];

async function whole() {
  // The warm-up request has already reached the stub; the three refusals below are judged on their own.
  if (STUB) await stub('/__reset');
  const none = await call('no token at all: the router refuses', { bearer: null, body: { addresses: [address('x', SPEC[0][1])] } });
  check('no token is a 401 from the router', none.status === 401);

  const refused = await call('the anon key: signed by this stack, so the router admits it, and the function must not', { bearer: anon, body: { addresses: [address('x', SPEC[0][1])] } });
  check('the anon key is refused as not_authenticated (401)', refused.status === 401 && refused.json?.reason === 'not_authenticated');

  const homeless = await call('a person with no active company', { bearer: lonely, body: { addresses: [address('x', SPEC[0][1])] } });
  check('a person without a company gets no_company (403)', homeless.status === 403 && homeless.json?.reason === 'no_company');
  if (STUB) check('and none of those three refusals reached their side', (await stub('/__stats')).requests.length === 0);

  await stub('/__reset');
  const answered = await call('a person with an active company asks for nine addresses of every kind', {
    bearer: person, body: { addresses: SPEC.map(([id, text]) => address(id, text)) },
  });
  check('answers 200 ok with their data stamp', answered.status === 200 && answered.json?.ok === true && answered.json?.data_updated === '2026-08-21T17:21:05+00:00');
  const results = answered.json?.results ?? [];
  check('one result per address, in request order, by id', results.map((r) => r.id).join('') === SPEC.map(([id]) => id).join(''));
  for (const [id, text, verdict] of SPEC) {
    const result = results.find((r) => r.id === id);
    check(`${id}: ${text.split(',')[0].replace(/ \d.*$/, '')} -> ${result?.kind === 'located' ? 'located' : result?.reason}`, result !== undefined && verdict(result), JSON.stringify(result));
  }
  check('only a house is ever a coordinate: no street, square or postal area came through',
    results.filter((r) => r.kind === 'located').every((r) => r.precision === 'exact'));
  if (STUB) {
    const seen = await stub('/__stats');
    const searches = seen.requests.filter((r) => r.url.startsWith('/search'));
    check('their side saw seven searches: the street and the bare text were never asked', searches.length === 7, String(searches.length));
    // Compare decoded values, not the URL text: the invented street "Nirgendwoweg" contains the letters of the
    // unreadable address "irgendwo", and the first version of this check tripped over exactly that.
    const asked = searches.flatMap((r) => [...new URL(r.url, 'http://stub').searchParams.values()]);
    check('and nothing about the street-only or unreadable address reached it',
      !asked.some((v) => v.includes('Königstra') || v.trim().toLowerCase() === 'irgendwo'), asked.join(' | '));
  }

  const many = await call('51 addresses', { bearer: person, body: { addresses: Array.from({ length: 51 }, (_, i) => address(`a${i}`, SPEC[0][1])) } });
  check('51 addresses are refused too_many_addresses (413)', many.status === 413 && many.json?.reason === 'too_many_addresses');
  const duplicate = await call('a repeated id', { bearer: person, body: { addresses: [address('a', SPEC[0][1]), address('a', SPEC[1][1])] } });
  check('a repeated id is refused duplicate_id (400)', duplicate.status === 400 && duplicate.json?.reason === 'duplicate_id');
  const junk = await call('not JSON', { bearer: person, body: 'this is not json' });
  check('text that is not JSON is refused invalid_request (400)', junk.status === 400 && junk.json?.reason === 'invalid_request');
  const blank = await call('a blank text', { bearer: person, body: { addresses: [address('a', '   ')] } });
  check('a blank address is refused invalid_request (400)', blank.status === 400 && blank.json?.reason === 'invalid_request');
  const get = await call('GET', { method: 'GET', bearer: person });
  check('a GET is refused method_not_allowed (405)', get.status === 405 && get.json?.reason === 'method_not_allowed');
  const preflight = await call('preflight from the app origin', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  check('the preflight from the app origin is allowed', preflight.status === 200 && preflight.response.headers.get('access-control-allow-origin') === ORIGIN);
}

async function budget() {
  await stub('/__reset');
  const thirty = Array.from({ length: 30 }, (_, i) => address(`n${i}`, SPEC[0][1]));
  const out = await call('thirty addresses: the budget slows even our own function', { bearer: person, body: { addresses: thirty } });
  const seen = STUB ? await stub('/__stats') : null;
  check('all thirty are placed', out.status === 200 && out.json?.results?.length === 30 && out.json.results.every((r) => r.kind === 'located'));
  check('and it takes the seconds that five a second allows', out.ms >= 4000, `${out.ms} ms`);
  if (seen) check('never more than two at a time reached their side', seen.mostInFlight <= 2, String(seen.mostInFlight));
}

async function theirsHangs() {
  await stub('/__reset');
  await fetch(`${STUB}/__mode?m=hang`, { method: 'POST' });
  const six = Array.from({ length: 6 }, (_, i) => address(`h${i}`, SPEC[0][1]));
  const out = await call('their service hangs: six addresses', { bearer: person, body: { addresses: six } });
  await fetch(`${STUB}/__mode?m=ok`, { method: 'POST' });
  const searches = (await stub('/__stats')).requests.filter((r) => r.url.startsWith('/search'));
  check('every address is a timeout, and none a coordinate', out.json?.results?.length === 6 && out.json.results.every((r) => r.kind === 'unlocated' && r.reason === 'timeout'));
  check('the function stopped asking after the third failure: four searches reached them, not six', searches.length === 4, String(searches.length));
}

async function unreachable(label, reasons, limitMs) {
  const addresses = SPEC.slice(0, 3).map(([id, text]) => address(id, text));
  const out = await call(label, { bearer: person, body: { addresses } });
  check(`still a 200, with ${reasons.join(' or ')} on every address and no coordinate`,
    out.status === 200 && out.json?.results?.length === 3 && out.json.results.every((r) => r.kind === 'unlocated' && reasons.includes(r.reason)));
  check('and no data stamp, because nothing was read', out.json?.data_updated === null);
  check('and quickly: one status request found it out', out.ms < limitMs, `${out.ms} ms`);
}

if (mode === 'warm') {
  const out = await call('warm-up (the worker fetches its modules on first use)', { bearer: person, body: { addresses: [address('warm', SPEC[0][1])] } });
  console.log(out.status === 200 ? '\nwarm' : '\nwarm-up failed');
  process.exit(0);
}
if (mode === 'upstream-down') await unreachable('their service is gone', ['unreachable'], 8000);
else if (mode === 'gateway-down') await unreachable('our gateway is stopped', ['unreachable', 'timeout'], 20_000);
else {
  await whole();
  await budget();
  if (STUB) await theirsHangs();
}
console.log(failures.length === 0 ? '\nall ok' : `\n${failures.length} FAILED:\n- ${failures.join('\n- ')}`);
process.exit(failures.length === 0 ? 0 : 1);
