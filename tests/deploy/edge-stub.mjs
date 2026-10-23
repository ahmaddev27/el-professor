// CI only (the osrm job in .github/workflows/pr-checks.yml).
//
// travel-route asks two things besides OSRM: GoTrue "who is this token" (GET /auth/v1/user) and
// the database "which active company" (POST /rest/v1/rpc/get_active_company_id). This answers
// both, from the token's `sub` claim, so the real function can run in the real edge runtime
// next to the real container without the rest of the stack:
//
//   sub ...0001  a person with an active company
//   sub ...0002  a person with no company
//   no sub       what the anon key looks like: GoTrue refuses it
//
// It trusts the token because the router in front of it has already verified the signature.
// Nothing here is a model of GoTrue or PostgREST beyond those two answers.
import http from 'node:http';

const WITH_COMPANY = '00000000-0000-4000-8000-000000000001';
const WITHOUT_COMPANY = '00000000-0000-4000-8000-000000000002';
const COMPANY = '00000000-0000-4000-8000-0000000000c1';

function subjectOf(req) {
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (!bearer) return null;
  try {
    return JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sub ?? null;
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  const sub = subjectOf(req);
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/auth/v1/user') {
    const known = sub === WITH_COMPANY || sub === WITHOUT_COMPANY;
    return known
      ? send(200, { id: sub, aud: 'authenticated', role: 'authenticated', email: 'ci@example.test' })
      : send(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid claim: missing sub claim' });
  }
  if (req.method === 'POST' && req.url.startsWith('/rest/v1/rpc/get_active_company_id')) {
    return send(200, sub === WITH_COMPANY ? COMPANY : null);
  }
  return send(404, { message: 'this stub answers two routes only', url: req.url });
});

server.listen(8000, '0.0.0.0', () => console.log('edge stub up'));
