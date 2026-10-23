// CI only (the geocoder job in .github/workflows/pr-checks.yml).
//
// Stands in for the Nominatim ridy runs, for the two things our stack ever asks of it
// through the gateway (deploy/geocoder-gateway.conf): GET /search with the structured
// query, and GET /status. The answers are shaped after what Nominatim 4.4.1 sent on
// 22.10.2026 for jsonv2 with addressdetails: lat and lon as strings, place_rank a
// number, house_number and postcode in `address`, no addresstype; the streets in
// FIXTURES are invented. It is NOT a model of Nominatim's search: it knows the
// handful of streets below and answers an empty list for any other.
//
// It also keeps the evidence the gateway tests need: every request it received (path,
// the headers it saw), how many were in flight at once, and what the gateway sent as
// the query. `GET /__stats` reads it, `POST /__reset` clears it, `POST /__mode?m=hang`
// makes /search never answer and `m=ok` undoes it. Those three paths are not behind the
// gateway: a test reads them straight from this container.
import http from 'node:http';

const STATUS = {
  status: 0, message: 'OK', data_updated: '2026-08-21T17:21:05+00:00', software_version: '4.4.1-0', database_version: '4.4.1-0',
};

const house = (over = {}, address = {}) => ({
  place_id: 1, licence: 'Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright', osm_type: 'node', osm_id: 4711,
  lat: '51.1722', lon: '7.0833', category: 'place', type: 'house', place_rank: 30, importance: 0.000001, name: '',
  display_name: 'invented', boundingbox: ['51.1721', '51.1723', '7.0832', '7.0834'],
  address: { house_number: '12', road: 'Hauptstraße', suburb: 'Mitte', city: 'Solingen', state: 'Nordrhein-Westfalen', postcode: '42651', country: 'Deutschland', country_code: 'de', ...address },
  ...over,
});

// 0.000216 degrees of latitude are about 24 m, 0.0027 about 300 m.
const FIXTURES = {
  '12 Hauptstraße': [house()],
  '5 Doppelweg': [house({ osm_id: 5 }, { house_number: '5', road: 'Doppelweg' }), house({ osm_id: 6, lat: '51.172416' }, { house_number: '5', road: 'Doppelweg' })],
  '7 Zwillingsweg': [house({ osm_id: 7 }, { house_number: '7', road: 'Zwillingsweg' }), house({ osm_id: 8, lat: '51.1749' }, { house_number: '7', road: 'Zwillingsweg' })],
  '9 Nurstraße': [house({ osm_id: 9, category: 'highway', type: 'residential', place_rank: 26 }, { house_number: undefined, road: 'Nurstraße' })],
  '11 Postleitzahlweg': [house({ osm_id: 11 }, { house_number: '11', road: 'Postleitzahlweg', postcode: '42699' })],
  '13 Nirgendwoweg': [],
  '15 Kaputtweg': { oops: true },
};

const seen = { requests: [], inFlight: 0, mostInFlight: 0 };
let mode = 'ok';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8', server: 'Apache/2.4.52 (Ubuntu)', 'x-powered-by': 'PHP/8.1.2', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/__stats') return json(200, seen);
  if (url.pathname === '/__reset') { seen.requests = []; seen.inFlight = 0; seen.mostInFlight = 0; return json(200, { ok: true }); }
  if (url.pathname === '/__mode') { mode = url.searchParams.get('m') ?? 'ok'; return json(200, { mode }); }

  seen.requests.push({ at: Date.now(), method: req.method, url: req.url, headers: req.headers });
  if (url.pathname === '/status') return json(200, STATUS);

  // Apache's content negotiation, which is the one thing this stand-in got
  // wrong and the reason it stayed green while the real path was broken.
  //
  // Their Nominatim is served by Apache and `/search` carries no extension,
  // so mod_negotiation looks for variants, finds `search.php`, and cannot
  // match a PHP file against a specific media type. Measured against their
  // service on 23.10.2026: `Accept: application/json` -> 406 with the variant
  // list, `Accept: */*` -> 200. Until this stand-in did the same, the gateway
  // could ask for a type no real server here would answer and every test
  // passed.
  //
  // `/search.php` is served whatever the type is asked for, as it is there.
  const accept = req.headers.accept;
  if (url.pathname === '/search' && accept && !accept.split(',').some((a) => a.trim().startsWith('*/*'))) {
    res.writeHead(406, { 'content-type': 'text/html; charset=iso-8859-1', server: 'Apache/2.4.52 (Ubuntu)' });
    return res.end('<html><head><title>406 Not Acceptable</title></head><body><h1>Not Acceptable</h1>'
      + '<p>An appropriate representation of the requested resource could not be found on this server.</p>'
      + 'Available variants:<ul><li><a href="search.php">search.php</a></li></ul></body></html>');
  }
  if (url.pathname !== '/search' || req.method !== 'GET') return json(404, { error: 'the stub answers /status and /search only' });

  seen.inFlight += 1;
  seen.mostInFlight = Math.max(seen.mostInFlight, seen.inFlight);
  const done = () => { seen.inFlight -= 1; };
  res.on('close', done);
  if (mode === 'hang') return; // never answers
  setTimeout(() => json(200, FIXTURES[url.searchParams.get('street') ?? ''] ?? []), 40);
});

server.listen(8080, '0.0.0.0', () => console.log('nominatim stub up'));
