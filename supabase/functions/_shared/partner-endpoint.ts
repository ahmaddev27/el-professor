/**
 * Where an outbound partner call is allowed to go.
 *
 * This is the project's **first** outbound HTTP call to a third party — nothing
 * in `supabase/functions/` called one before — and that makes the destination a
 * security decision rather than a configuration detail.
 *
 * ## The destination never comes from the request
 *
 * `send-document`'s rule, applied to a host instead of an address: "the
 * recipient's address is never taken from the request". Here the reason is
 * sharper. These functions run in a container on a Docker network shared with
 * Reidey's own stack and with our database. A base URL taken from a request
 * body would let any company administrator aim our server at
 * `ridy-mysql-1:3306`, `ya-mobility-db-1:5432`, a cloud metadata endpoint, or
 * anything else reachable from inside — a server-side request forgery with our
 * own network as the target. So the destination is configuration, and the
 * request supplies only the token the operator pasted.
 *
 * ## And the configuration is validated, because a typo is the same bug
 *
 * Pinning the value in `.env` removes the attacker and leaves the accident. A
 * base URL of `http://ridy-backend-1` would be a perfectly plausible thing for
 * someone to write — it is how the two stacks reach each other — and it is
 * exactly the request this guard exists to refuse. HTTPS only, a public host
 * only, no credentials in the URL, no port but 443.
 *
 * Why no internal address even though it would work and be faster: an internal
 * call bypasses Reidey's own Caddy, which is where its TLS, its rate limits and
 * its access logs live. We would be inside their perimeter rather than a client
 * of it, and a bug on our side would reach their application directly.
 */

/** Hosts that must never be a partner endpoint, however the value was written. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  '127.0.0.1',
  '::1',
  'metadata.google.internal',
  'metadata',
])

/** `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `127/8` and IPv6 locals. */
function isPrivateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host.endsWith('.internal') || host.endsWith('.local')) return true
  // An IPv6 unique-local or link-local address.
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!v4) {
    // A bare label with no dot is a container or service name on the Docker
    // network — `ridy-backend-1`, `kong`, `db`. Never a public host.
    return !host.includes('.')
  }
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

export type EndpointProblem =
  | 'endpoint_missing'
  | 'endpoint_unparsable'
  | 'endpoint_not_https'
  | 'endpoint_has_credentials'
  | 'endpoint_private_host'
  | 'endpoint_unexpected_port'
  | 'endpoint_has_path'

export type EndpointResult =
  | { ok: true; origin: string }
  | { ok: false; problem: EndpointProblem }

/**
 * The configured base URL, or why it may not be used.
 *
 * Returns the bare origin, so a caller builds its own path and cannot inherit
 * one from configuration — a base URL of `https://host/anything` is refused
 * rather than silently joined, because a path in the configured value is how a
 * call ends up somewhere nobody intended.
 */
export function partnerEndpoint(configured: string | undefined | null): EndpointResult {
  const raw = (configured ?? '').trim()
  if (raw === '') return { ok: false, problem: 'endpoint_missing' }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, problem: 'endpoint_unparsable' }
  }

  if (url.protocol !== 'https:') return { ok: false, problem: 'endpoint_not_https' }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, problem: 'endpoint_has_credentials' }
  }
  if (BLOCKED_HOSTNAMES.has(url.hostname.toLowerCase()) || isPrivateAddress(url.hostname)) {
    return { ok: false, problem: 'endpoint_private_host' }
  }
  // 443 only. A non-standard port on a public host is the shape of a tunnel to
  // something that is not the partner's front door.
  if (url.port !== '' && url.port !== '443') {
    return { ok: false, problem: 'endpoint_unexpected_port' }
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    return { ok: false, problem: 'endpoint_has_path' }
  }

  return { ok: true, origin: url.origin }
}

/** The one path this build calls, and the only way to build it. */
export function partnerFleetUrl(origin: string): string {
  return `${origin}/api/v1/elprofessor/fleet`
}

export const PARTNER_ENDPOINT_VAR = 'PARTNER_REIDEY_BASE_URL'
