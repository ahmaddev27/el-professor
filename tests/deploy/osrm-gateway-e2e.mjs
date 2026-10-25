// CI only (the osrm-gateway job in .github/workflows/pr-checks.yml).
//
// The real OSRM gateway (nginx, deploy/osrm-gateway.conf, started by the compose file
// with its profile) in front of tests/deploy/osrm-gateway-stub.mjs, which stands in for
// ridy's OSRM. It asks what our function would ask, and what nobody should be able to
// ask, and reads the stub's own record of what reached it. Every exchange is printed, so
// the run is the evidence.
//
//   GATEWAY_URL=http://<gateway>:5000 STUB_URL=http://<stub>:5000 node tests/deploy/osrm-gateway-e2e.mjs down
//       the stub does not exist yet: the gateway is up and healthy, and answers 502, not a crash
//   ... node tests/deploy/osrm-gateway-e2e.mjs up
//       the stub is there: the allow-list, the rebuilt query, the headers, the budget, the timeout
const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:5000';
const STUB = process.env.STUB_URL ?? 'http://127.0.0.1:5001';
const mode = process.argv[2] ?? 'up';

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures.push(label);
}

async function get(path, init = {}) {
  const response = await fetch(`${GATEWAY}${path}`, { signal: AbortSignal.timeout(30_000), ...init });
  const text = await response.text();
  console.log(`${init.method ?? 'GET'} ${path.slice(0, 100)} -> ${response.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  return { status: response.status, text, headers: response.headers };
}
const stats = async () => (await fetch(`${STUB}/__stats`)).json();
const reset = () => fetch(`${STUB}/__reset`, { method: 'POST' });
const setMode = (m) => fetch(`${STUB}/__mode?m=${m}`, { method: 'POST' });

// Exactly what routeUrl() builds: six decimals, longitude first, and the query the
// function sends - which this gateway drops and rebuilds.
const GOOD = '/route/v1/driving/7.084500,51.165200;6.773500,51.227700?overview=false&alternatives=false&steps=false';
const REBUILT = '/route/v1/driving/7.084500,51.165200;6.773500,51.227700?overview=false&alternatives=false&steps=false&annotations=false';

async function down() {
  console.log('\n## the upstream does not exist');
  const health = await get('/healthz');
  check('/healthz is answered by the gateway itself: 200 ok', health.status === 200 && health.text.trim() === 'ok');
  const route = await get(GOOD);
  check('a route answers 502, not a crash and not a hang', route.status === 502);
  const after = await get('/healthz');
  check('the gateway is still healthy afterwards', after.status === 200);
  const forbidden = await get('/table/v1/driving/7.0,51.0;6.7,51.2');
  check('a forbidden path is 404 whether or not the upstream is there', forbidden.status === 404);
}

async function allowList() {
  console.log('\n## what gets through');
  await reset();
  const route = await get(GOOD);
  const body = route.status === 200 ? JSON.parse(route.text) : null;
  check('GET /route/v1/driving is passed on and answered', route.status === 200 && body?.code === 'Ok');
  check('the route, the waypoints and their snap distances come back whole',
    body?.routes?.[0]?.distance === 30066.4 && body?.waypoints?.length === 2 && body.waypoints[0].distance > 0);
  check('their Server header is not shown to the caller', !/osrm-stub/.test(route.headers.get('server') ?? ''));
  check('the answer is marked no-store', /no-store/.test(route.headers.get('cache-control') ?? ''));
  // Theirs was started without --data_version. If this ever becomes a string the stand-in
  // has stopped standing in for them, and the claim in the conf about a lost month is stale.
  check('and it carries NO data_version, as theirs does not', body?.data_version === undefined);

  console.log('\n## what is passed on');
  const seen = await stats();
  const forwarded = seen.requests.find((r) => r.url.startsWith('/route'));
  check('the query is REBUILT: the four fixed arguments, in that order', forwarded?.url === REBUILT, forwarded?.url);
  check('the gateway says who is asking', forwarded?.headers['user-agent'] === 'el-professor-osrm-gateway');
  // `*/*`, never a media type: OSRM picks no format from this header, and a narrow one is
  // a thing a server can refuse (the geocoder gateway's 406, 23.10.2026) for nothing.
  check('and accepts anything, by the host name of their container',
    forwarded?.headers.accept === '*/*' && forwarded?.headers.host === 'ridy-osrm-1', forwarded?.headers.accept);
}

async function nothingElse() {
  await reset();
  console.log('\n## nothing of the caller\'s own is forwarded, and its extra arguments are dropped');
  await get(`${GOOD}&overview=full&alternatives=3&steps=true&annotations=speed&geometries=geojson&radiuses=unlimited`, {
    headers: { cookie: 'session=secret', authorization: 'Bearer secret', 'x-forwarded-for': '10.9.9.9', 'x-custom': 'yes' },
  });
  const seen = await stats();
  const request = seen.requests.find((r) => r.url.startsWith('/route'));
  check('the geometry, the alternatives, the steps and the annotations are the gateway\'s, not the caller\'s',
    request?.url === REBUILT, request?.url);
  const headers = Object.keys(request?.headers ?? {});
  check('no cookie, no authorization, no forwarding header and no custom header reached them',
    !headers.some((h) => ['cookie', 'authorization', 'x-forwarded-for', 'x-custom'].includes(h)), headers.join(','));
}

async function forbiddenPaths() {
  await reset();
  console.log('\n## the allow-list: one service, one version, one profile, two coordinates');
  const paths = [
    // The dear ones. A table of a hundred coordinates is thousands of times a route.
    '/table/v1/driving/7.0845,51.1652;6.7735,51.2277',
    '/trip/v1/driving/7.0845,51.1652;6.7735,51.2277',
    '/match/v1/driving/7.0845,51.1652;6.7735,51.2277',
    '/nearest/v1/driving/7.0845,51.1652',
    '/tile/v1/driving/tile(1,1,1).mvt',
    // A third coordinate, which is a via route and twice the work.
    '/route/v1/driving/7.0845,51.1652;6.7735,51.2277;7.1,51.3',
    // One coordinate, no coordinate, another profile, another version.
    '/route/v1/driving/7.0845,51.1652',
    '/route/v1/driving/',
    '/route/v1/bike/7.0845,51.1652;6.7735,51.2277',
    '/route/v2/driving/7.0845,51.1652;6.7735,51.2277',
    // Not a coordinate at all, and a path that tries to walk out of the allow-list.
    '/route/v1/driving/here;there',
    '/route/v1/driving/7.0845,51.1652;6.7735,51.2277/../../table/v1/driving/7.0,51.0;6.7,51.2',
    '/',
    '/__stats',
  ];
  for (const path of paths) check(`GET ${path.slice(0, 70)} is 404`, (await get(path)).status === 404);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const body = method === 'POST' || method === 'PUT' ? 'x' : undefined;
    check(`${method} on the route path is 405`, (await get(GOOD, { method, body })).status === 405);
  }
  check('none of it reached them', (await stats()).requests.length === 0, JSON.stringify((await stats()).requests.map((r) => r.url)));
}

async function refusalsPassThrough() {
  await reset();
  console.log('\n## their own refusals reach the function with their OSRM code intact');
  // interpretOsrmAnswer reads the `code` and not the status: NoSegment is not_on_road,
  // NoRoute is no_route, and both arrive as a 400. If nginx ever swallowed such a body
  // (proxy_intercept_errors), every one of them would read bad_answer instead.
  const nowhere = await get('/route/v1/driving/3.000000,56.000000;6.773500,51.227700');
  check('a point with no road near it: 400 with code NoSegment, body and all',
    nowhere.status === 400 && JSON.parse(nowhere.text).code === 'NoSegment', nowhere.text.slice(0, 80));
  const unreachable = await get('/route/v1/driving/7.700000,54.180000;6.773500,51.227700');
  check('two points a car cannot connect: 400 with code NoRoute', unreachable.status === 400 && JSON.parse(unreachable.text).code === 'NoRoute');
  const good = await get(GOOD);
  check('and a good route still answers right after', good.status === 200);
}

async function budget() {
  console.log('\n## a polite caller is never refused: 60 requests one after the other');
  await reset();
  const started = Date.now();
  const answers = [];
  for (let i = 0; i < 60; i++) answers.push((await fetch(`${GATEWAY}${GOOD}`)).status);
  console.log(`statuses: 200 x ${answers.filter((s) => s === 200).length} in ${Date.now() - started} ms`);
  check('all sixty are answered, none refused', answers.every((s) => s === 200));

  console.log('\n## a flood is refused rather than passed on: 120 requests at once');
  await reset();
  const flood = await Promise.all(Array.from({ length: 120 }, () => fetch(`${GATEWAY}${GOOD}`).then((r) => r.status)));
  const seen = await stats();
  const count = (code) => flood.filter((s) => s === code).length;
  const times = seen.requests.map((r) => r.at);
  const spread = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  console.log(`200 x ${count(200)}, 503 x ${count(503)}, other x ${flood.length - count(200) - count(503)}; upstream saw ${seen.requests.length} over ${spread} ms`);
  check('most of them are refused here and never reach them', count(503) >= 50, `${count(503)} refused`);
  // 503 and not 429 on purpose: interpretOsrmAnswer reads a 5xx with no OSRM code as
  // service_error, where a 429 would arrive as bad_answer and point at a contract bug.
  check('every answer is a 200 or a 503, never a 429', count(200) + count(503) === flood.length && count(429) === 0);
  // 1 straight through plus a queue of 40 drained at 40 a second: about 41 requests
  // spread over about a second. Without the rate limit all 120 would arrive at once.
  check('the upstream saw about the queue and no more', seen.requests.length <= 55, String(seen.requests.length));
  check('and they arrived spread over about a second, not all at once', spread >= 700, `${spread} ms`);

  console.log('\n## the in-flight limit, with their service slow enough to see it');
  // While they answer in milliseconds the rate alone keeps about one request in flight,
  // so this check would pass whatever the limit said. Half a second each makes a flood
  // pile up: 40 a second admitted times 0.5 s is 20 in flight, and 12 is the ceiling.
  await reset();
  await setMode('slow');
  const slow = await Promise.all(Array.from({ length: 60 }, () => fetch(`${GATEWAY}${GOOD}`).then((r) => r.status)));
  const during = await stats();
  await setMode('ok');
  console.log(`slow: 200 x ${slow.filter((s) => s === 200).length}, 503 x ${slow.filter((s) => s === 503).length}; most in flight ${during.mostInFlight}`);
  check('their service never had more than twelve of our requests in flight', during.mostInFlight <= 12, String(during.mostInFlight));
  check('and enough piled up that the ceiling was actually reached', during.mostInFlight >= 8, String(during.mostInFlight));
  const after = await get(GOOD);
  check('and the gateway serves normally again once they are quick', after.status === 200);
}

async function timeout() {
  console.log('\n## their service hangs');
  await reset();
  await setMode('hang');
  const started = Date.now();
  const answer = await get(GOOD);
  const took = Date.now() - started;
  await setMode('ok');
  // Three seconds, the same as the function's own REQUEST_TIMEOUT_MS, so the gateway
  // never holds a request on their server after the caller has stopped waiting.
  check('the gateway answers 504 after about its three seconds', answer.status === 504 && took >= 2500 && took <= 7000, `${answer.status} after ${took} ms`);
  const after = await get(GOOD);
  check('and serves again as soon as theirs does', after.status === 200);
}

if (mode === 'down') await down();
else {
  await allowList();
  await nothingElse();
  await forbiddenPaths();
  await refusalsPassThrough();
  await budget();
  await timeout();
  check('the gateway is healthy at the end', (await get('/healthz')).status === 200);
}
console.log(failures.length === 0 ? '\nall ok' : `\n${failures.length} FAILED:\n- ${failures.join('\n- ')}`);
process.exit(failures.length === 0 ? 0 : 1);
