// CI only (the geocoder job in .github/workflows/pr-checks.yml).
//
// The real geocoder gateway (nginx, deploy/geocoder-gateway.conf, started by the compose file with the
// profile) in front of tests/deploy/nominatim-stub.mjs, which stands in for ridy's Nominatim. It asks what
// our function would ask, and what nobody should be able to ask, and reads the stub's own record of what
// reached it. Every exchange is printed, so the run is the evidence.
//
//   GATEWAY_URL=http://<gateway>:8080 STUB_URL=http://<stub>:8080 node tests/deploy/gateway-e2e.mjs down
//       the stub does not exist yet: the gateway is up and healthy, and answers 502, not a crash
//   ... node tests/deploy/gateway-e2e.mjs up
//       the stub is there: the allow-list, the rebuilt query, the headers, the budget, the timeout
const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8080';
const STUB = process.env.STUB_URL ?? 'http://127.0.0.1:8081';
const mode = process.argv[2] ?? 'up';

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures.push(label);
}

async function get(path, init = {}) {
  const response = await fetch(`${GATEWAY}${path}`, { signal: AbortSignal.timeout(30_000), ...init });
  const text = await response.text();
  console.log(`${init.method ?? 'GET'} ${path.slice(0, 90)} -> ${response.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  return { status: response.status, text, headers: response.headers };
}
const stats = async () => (await fetch(`${STUB}/__stats`)).json();
const reset = () => fetch(`${STUB}/__reset`, { method: 'POST' });
const setMode = (m) => fetch(`${STUB}/__mode?m=${m}`, { method: 'POST' });

const GOOD = '/search?street=12%20Hauptstra%C3%9Fe&postalcode=42651&city=Solingen';
const REBUILT = `${GOOD}&countrycodes=de&format=jsonv2&addressdetails=1&limit=3&accept-language=de&layer=address`;

async function down() {
  console.log('\n## the upstream does not exist');
  const health = await get('/healthz');
  check('/healthz is answered by the gateway itself: 200 ok', health.status === 200 && health.text.trim() === 'ok');
  const search = await get(GOOD);
  check('a search answers 502, not a crash and not a hang', search.status === 502);
  const status = await get('/status');
  check('/status answers 502 too', status.status === 502);
  const after = await get('/healthz');
  check('the gateway is still healthy afterwards', after.status === 200);
  const forbidden = await get('/reverse?lat=51&lon=7');
  check('a forbidden path is 404 whether or not the upstream is there', forbidden.status === 404);
}

async function allowList() {
  console.log('\n## what gets through');
  await reset();
  const status = await get('/status');
  check('GET /status is passed on and answered', status.status === 200 && JSON.parse(status.text).software_version === '4.4.1-0');
  const search = await get(GOOD);
  check('GET /search is passed on and answered', search.status === 200 && Array.isArray(JSON.parse(search.text)));
  check('their Server and X-Powered-By headers are not shown to the caller',
    !/apache/i.test(search.headers.get('server') ?? '') && search.headers.get('x-powered-by') === null);
  check('the answer is marked no-store', /no-store/.test(search.headers.get('cache-control') ?? ''));

  console.log('\n## what is passed on');
  const seen = await stats();
  const forwarded = seen.requests.find((r) => r.url.startsWith('/search'));
  check('the query is REBUILT: the three arguments plus the fixed rest, in that order', forwarded?.url === REBUILT, forwarded?.url);
  check('the gateway says who is asking', forwarded?.headers['user-agent'] === 'el-professor-geocoder-gateway');
  check('and asks for JSON by the host name of their service', forwarded?.headers.accept === 'application/json' && forwarded?.headers.host === 'nominatim');
}

async function nothingElse() {
  await reset();
  console.log('\n## nothing of the caller\'s own is forwarded, and its extra arguments are dropped');
  await get(`${GOOD}&limit=100&polygon_geojson=1&format=xml&extratags=1&exclude_place_ids=1&countrycodes=fr`, {
    headers: { cookie: 'session=secret', authorization: 'Bearer secret', 'x-forwarded-for': '10.9.9.9', 'x-custom': 'yes' },
  });
  const seen = await stats();
  const request = seen.requests.find((r) => r.url.startsWith('/search'));
  check('limit, format, polygons, extra tags, exclusions and the country are the gateway\'s, not the caller\'s', request?.url === REBUILT, request?.url);
  const headers = Object.keys(request?.headers ?? {});
  check('no cookie, no authorization, no forwarding header and no custom header reached them',
    !headers.some((h) => ['cookie', 'authorization', 'x-forwarded-for', 'x-custom'].includes(h)), headers.join(','));

  console.log('\n## every argument is needed');
  await reset();
  for (const path of ['/search', '/search?street=1%20a&postalcode=42651', '/search?street=&postalcode=42651&city=Solingen', '/search?postalcode=42651&city=Solingen']) {
    const answer = await get(path);
    check(`${path} is 400`, answer.status === 400);
  }
  check('and none of them reached them', (await stats()).requests.length === 0);
}

async function forbiddenPaths() {
  await reset();
  console.log('\n## the allow-list');
  const paths = ['/reverse?lat=51&lon=7', '/lookup?osm_ids=N1', '/details?place_id=1', '/', '/search/', '/status/extra', '/__stats', '/polygons', '/deletable', '/search.php?q=x'];
  for (const path of paths) check(`GET ${path} is 404`, (await get(path)).status === 404);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const body = method === 'POST' || method === 'PUT' ? 'x' : undefined;
    check(`${method} /search is 405`, (await get(GOOD, { method, body })).status === 405);
  }
  check('none of it reached them', (await stats()).requests.length === 0);
}

async function budget() {
  console.log('\n## a polite caller is slowed to the budget: 12 requests one after the other');
  await reset();
  const started = Date.now();
  const answers = [];
  for (let i = 0; i < 12; i++) answers.push((await fetch(`${GATEWAY}${GOOD}`)).status);
  const took = Date.now() - started;
  console.log(`statuses ${answers.join(',')} in ${took} ms`);
  check('all twelve are answered', answers.every((s) => s === 200));
  check('and take about the 2.2 s that five a second allows, not milliseconds', took >= 1800, `${took} ms`);
  const times = (await stats()).requests.map((r) => r.at);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  check('they reached the upstream at least 150 ms apart', gaps.length === 11 && Math.min(...gaps) >= 150, gaps.join(','));

  console.log('\n## a flood is refused: 40 requests at once');
  await reset();
  const flood = await Promise.all(Array.from({ length: 40 }, () => fetch(`${GATEWAY}${GOOD}`).then((r) => r.status)));
  const seen = await stats();
  const count = (code) => flood.filter((s) => s === code).length;
  console.log(`200 x ${count(200)}, 429 x ${count(429)}, other x ${flood.length - count(200) - count(429)}; upstream saw ${seen.requests.length}, most in flight ${seen.mostInFlight}`);
  check('some are refused with 429', count(429) > 0);
  check('every answer is a 200 or a 429', count(200) + count(429) === flood.length);
  check('never more than two reached them at a time', seen.mostInFlight <= 2, String(seen.mostInFlight));
  check('the upstream saw no more than the queue allows', seen.requests.length <= 13, String(seen.requests.length));
}

async function timeout() {
  console.log('\n## their service hangs');
  await reset();
  await setMode('hang');
  const started = Date.now();
  const answer = await get(GOOD);
  const took = Date.now() - started;
  await setMode('ok');
  check('the gateway answers 504 after about its five seconds', answer.status === 504 && took >= 4500 && took <= 9000, `${answer.status} after ${took} ms`);
  const after = await get(GOOD);
  check('and serves again as soon as theirs does', after.status === 200);
}

if (mode === 'down') await down();
else {
  await allowList();
  await nothingElse();
  await forbiddenPaths();
  await budget();
  await timeout();
  check('the gateway is healthy at the end', (await get('/healthz')).status === 200);
}
console.log(failures.length === 0 ? '\nall ok' : `\n${failures.length} FAILED:\n- ${failures.join('\n- ')}`);
process.exit(failures.length === 0 ? 0 : 1);
