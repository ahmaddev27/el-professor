// CI only (the osrm-gateway job in .github/workflows/pr-checks.yml).
//
// Stands in for the OSRM ridy runs, for the one thing our stack ever asks of it through
// the gateway (deploy/osrm-gateway.conf): GET /route/v1/driving/<lon,lat>;<lon,lat>.
// The answers are shaped after what ridy-osrm-1 sent on 25.10.2026 for
// 7.0845,51.1652;6.7735,51.2277 (osrm/osrm-backend:latest, `osrm-routed --algorithm mld
// /data/germany-latest.osrm`): a `code`, one route with a distance, a duration and a
// weight, and two waypoints with a hint, a name and a snap distance.
//
// ── It can refuse, and that is the whole reason it exists ───────────────────────────
//
// A stand-in that answers everything makes CI green while the real service says no:
// tests/deploy/nominatim-stub.mjs dressed as Apache without negotiating anything, and
// the gateway in front of it asked for a media type their Apache answers 406 to for a
// release and a half. So this one models every refusal the real osrm-routed makes that
// our gateway or our function has to survive:
//
//   - a coordinate that is nowhere near a road            400 {"code":"NoSegment"}
//   - two points not connected for a car                  400 {"code":"NoRoute"}
//   - a request it will not parse                         400 {"code":"InvalidQuery"}
//   - more coordinates than --max-viaroute-size allows    400 {"code":"TooBig"}
//   - a service we never call                             400 {"code":"InvalidService"}
//   - it hangs (?m=hang), it can be slow (?m=slow), and it can be absent (not started)
//
// Those 400s carry an OSRM `code`, which interpretOsrmAnswer reads to tell "the data has
// no answer" from "we built the request wrong". nginx must pass such a body through
// untouched; if it ever swallows one, every pair of a month would read bad_answer.
//
// ── And it carries NO data_version ────────────────────────────────────────────────
//
// Measured on their service the same day: ridy's osrm-routed was started without
// --data_version, so not one of its answers has that field, where our own build passes
// --data_version osmosis and stamps every answer. Inventing one here would hide exactly
// what shared mode gives up, so this stand-in leaves it out as theirs does.
//
// It also keeps the evidence the gateway tests need: every request it received (path,
// the headers it saw), how many were in flight at once, and what the gateway sent as the
// query. `GET /__stats` reads it, `POST /__reset` clears it, `POST /__mode?m=hang` makes
// a route never answer, `m=slow` makes it take half a second (which is what lets a test
// see the in-flight limit at all: while they answer in milliseconds the gateway's rate
// alone keeps barely one request in flight, so a check on the limit would pass
// vacuously) and `m=ok` undoes either. Those three paths are not behind the gateway: a
// test reads them straight from this container.
import http from 'node:http';

/** The real answer of 25.10.2026, shortened only in the hints. */
const ROUTE = {
  code: 'Ok',
  routes: [{
    legs: [{ steps: [], distance: 30066.4, duration: 2050.9, summary: '', weight: 2050.9 }],
    distance: 30066.4, duration: 2050.9, weight_name: 'routability', weight: 2050.9,
  }],
  waypoints: [
    { hint: 'YH5Vgf___38SAAAAUgAAAC4AAAA', distance: 3.359802, name: 'Alexander-Coppel-Straße', location: [7.084482, 51.165228] },
    { hint: 'QS5ZgWcuWYEZAAAAAwAAABIAAAA', distance: 6.970058, name: 'Liefergasse', location: [6.773406, 51.227679] },
  ],
};

/** Coordinates that make the real server answer something other than a route. */
const REFUSALS = {
  // A point in the North Sea: no road to snap it to.
  '3.000000,56.000000': { status: 400, body: { code: 'NoSegment', message: 'Could not find a matching segment for coordinate 0' } },
  // An island: snapped, but no car route from the mainland.
  '7.700000,54.180000': { status: 400, body: { code: 'NoRoute', message: 'Impossible route between points' } },
};

const seen = { requests: [], inFlight: 0, mostInFlight: 0 };
let mode = 'ok';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', server: 'osrm-stub' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/__stats') return json(200, seen);
  if (url.pathname === '/__reset') { seen.requests = []; seen.inFlight = 0; seen.mostInFlight = 0; return json(200, { ok: true }); }
  if (url.pathname === '/__mode') { mode = url.searchParams.get('m') ?? 'ok'; return json(200, { mode }); }

  seen.requests.push({ at: Date.now(), method: req.method, url: req.url, headers: req.headers });

  // What osrm-routed answers for a service it does not serve, or a version it does not know.
  const route = /^\/route\/v1\/driving\/(.+)$/.exec(url.pathname);
  if (!route) return json(400, { code: 'InvalidService', message: 'Service not found' });

  const coordinates = route[1].split(';');
  // --max-viaroute-size: our own service runs with 3, and the default is 500. Either
  // way more coordinates than the limit is a TooBig and never a route.
  if (coordinates.length > 3) return json(400, { code: 'TooBig', message: 'Number of entries 4 is higher than current maximum (3)' });
  if (coordinates.length < 2 || coordinates.some((c) => !/^-?[0-9.]+,-?[0-9.]+$/.test(c))) {
    return json(400, { code: 'InvalidQuery', message: 'Query string malformed close to position 18' });
  }

  const refusal = REFUSALS[coordinates[0]] ?? REFUSALS[coordinates[1]];
  if (refusal) return json(refusal.status, refusal.body);

  seen.inFlight += 1;
  seen.mostInFlight = Math.max(seen.mostInFlight, seen.inFlight);
  res.on('close', () => { seen.inFlight -= 1; });
  if (mode === 'hang') return; // never answers
  // A 30 km MLD route on the German extract came back in milliseconds; 15 ms is
  // slow enough that two overlapping requests are visibly in flight together.
  // `slow` is half a second, well inside the gateway's 3 s read timeout, so a
  // flood piles up in flight instead of draining as fast as it arrives.
  setTimeout(() => json(200, ROUTE), mode === 'slow' ? 500 : 15);
});

server.listen(5000, '0.0.0.0', () => console.log('osrm stub up'));
