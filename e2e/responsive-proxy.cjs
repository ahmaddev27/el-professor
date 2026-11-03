#!/usr/bin/env node
/**
 * Serves a built bundle on 127.0.0.1:5199 and forwards the API paths to staging,
 * for e2e/responsive-sweep.mjs.
 *
 *   VITE_SUPABASE_URL=http://127.0.0.1:5199 VITE_SUPABASE_ANON_KEY=$E2E_ANON_KEY \
 *     npx vite build --outDir <dir>
 *   E2E_API_URL=https://api-staging.elprofessor.eu node e2e/responsive-proxy.cjs <dir>
 *
 * It forwards reads only, and that is what makes pressing every button safe. A table
 * write, an edge function call or an RPC not on the short lists below is answered 403
 * here and never reaches staging. Every refusal is logged next to the bundle, so a run
 * can be checked afterwards. A new read-only RPC goes on the list by name, and an RPC
 * that writes never does.
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.resolve(process.argv[2] ?? 'dist');
const LOG = path.join(DIST, '..', 'proxy.log');
const API = new URL(process.env.E2E_API_URL);
if (API.hostname !== 'api-staging.elprofessor.eu') throw new Error(`refusing ${API.hostname}: staging only`);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.txt': 'text/plain',
  '.ico': 'image/x-icon', '.webp': 'image/webp',
};
const API_PREFIX = new RegExp('^/(auth|rest|functions|storage|export)/v1/');
const SIGN_IN = new RegExp('^/auth/v1/token');
const READ_ONLY_RPC = new RegExp('^/rest/v1/rpc/(get_|platform_whoami|platform_[a-z_]*_list|current_|is_|has_|compute_plan_price|platform_invoice_seller)');
const READ_ONLY_FUNCTION = new RegExp('^/functions/v1/manage-users/list');

function allowed(method, url) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (method !== 'POST') return false;
  return SIGN_IN.test(url) || READ_ONLY_RPC.test(url) || READ_ONLY_FUNCTION.test(url);
}

function forward(req, res) {
  const upstream = https.request({
    hostname: API.hostname, port: 443, path: req.url, method: req.method,
    headers: { ...req.headers, host: API.hostname, origin: 'https://app.elprofessor.eu' },
  }, answer => {
    res.writeHead(answer.statusCode, answer.headers);
    answer.pipe(res);
  });
  // A connection can drop after the answer has started. Writing a second head then throws, and
  // one dropped connection took the whole proxy and the sweep behind it down.
  upstream.on('error', error => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502);
    return res.end(String(error.message));
  });
  req.pipe(upstream);
}

http.createServer((req, res) => {
  if (API_PREFIX.test(req.url)) {
    if (allowed(req.method, req.url)) return forward(req, res);
    fs.appendFileSync(LOG, `REFUSED ${req.method} ${req.url.slice(0, 200)}\n`);
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: 'refused by the read-only sweep proxy', code: '42501' }));
  }
  let file = path.normalize(path.join(DIST, decodeURIComponent(req.url.split('?')[0])));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  return fs.createReadStream(file).pipe(res);
}).listen(5199, '127.0.0.1', () => console.log(`serving ${DIST} on 5199`));
