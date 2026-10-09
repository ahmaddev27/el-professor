import { describe, expect, it } from 'vitest'
import { PARTNER_ENDPOINT_VAR, partnerEndpoint, partnerFleetUrl } from './partner-endpoint'

const ok = (value: string) => partnerEndpoint(value)

describe('partnerEndpoint', () => {
  it('accepts a plain public https origin and returns the bare origin', () => {
    expect(ok('https://app.reidey.example')).toEqual({
      ok: true, origin: 'https://app.reidey.example',
    })
  })

  it('accepts an explicit 443 and normalises it away', () => {
    expect(ok('https://app.reidey.example:443')).toEqual({
      ok: true, origin: 'https://app.reidey.example',
    })
  })

  it('accepts a trailing slash, which is how a person writes a base URL', () => {
    expect(ok('https://app.reidey.example/')).toEqual({
      ok: true, origin: 'https://app.reidey.example',
    })
  })

  it('trims, because a value pasted into .env carries whitespace', () => {
    expect(ok('  https://app.reidey.example  ').ok).toBe(true)
  })

  it.each([
    ['missing', '', 'endpoint_missing'],
    ['whitespace only', '   ', 'endpoint_missing'],
    ['not a URL', 'reidey', 'endpoint_unparsable'],
  ])('refuses a %s value', (_label, value, problem) => {
    expect(ok(value)).toEqual({ ok: false, problem })
  })

  it('refuses http, so the call cannot be read or rewritten in flight', () => {
    expect(ok('http://app.reidey.example')).toEqual({ ok: false, problem: 'endpoint_not_https' })
  })

  // The guard's whole purpose: our functions share a Docker network with
  // Reidey's database and ours, so an internal destination is the SSRF.
  it.each([
    ['a container name', 'https://ridy-backend-1'],
    ['our own gateway', 'https://kong'],
    ['our database service', 'https://db'],
    ['localhost', 'https://localhost'],
    ['loopback', 'https://127.0.0.1'],
    ['10/8', 'https://10.0.3.7'],
    ['172.16/12', 'https://172.20.0.4'],
    ['192.168/16', 'https://192.168.1.10'],
    ['link-local', 'https://169.254.169.254'],
    ['cloud metadata by name', 'https://metadata.google.internal'],
    ['a .internal name', 'https://ridy.internal'],
    ['a .local name', 'https://ridy.local'],
    ['an IPv6 unique-local', 'https://[fd00::1]'],
    ['an IPv6 link-local', 'https://[fe80::1]'],
  ])('refuses %s', (_label, value) => {
    expect(ok(value)).toEqual({ ok: false, problem: 'endpoint_private_host' })
  })

  it('accepts a public IPv4, so the private check is about the range and not about digits', () => {
    // Without this, "refuses 10.0.3.7" would also pass for an implementation
    // that refuses every numeric host, and the guard would be untested.
    expect(ok('https://93.184.216.34').ok).toBe(true)
  })

  it('accepts 172.32, which is OUTSIDE the private block', () => {
    // 172.16 through 172.31 are private; 172.32 is not. A guard written as
    // "a === 172" would fail this.
    expect(ok('https://172.32.0.1').ok).toBe(true)
    expect(ok('https://172.15.0.1').ok).toBe(true)
    expect(ok('https://172.31.255.255')).toEqual({ ok: false, problem: 'endpoint_private_host' })
  })

  it('refuses credentials in the URL, which would be sent to whatever the host is', () => {
    expect(ok('https://user:pass@app.reidey.example'))
      .toEqual({ ok: false, problem: 'endpoint_has_credentials' })
  })

  it('refuses a port that is not 443', () => {
    expect(ok('https://app.reidey.example:8443'))
      .toEqual({ ok: false, problem: 'endpoint_unexpected_port' })
  })

  it('refuses a path in the configured value rather than joining it', () => {
    // A path here is how a call ends up somewhere nobody intended.
    expect(ok('https://app.reidey.example/api'))
      .toEqual({ ok: false, problem: 'endpoint_has_path' })
  })
})

describe('partnerFleetUrl', () => {
  it('is the one path this build calls', () => {
    expect(partnerFleetUrl('https://app.reidey.example'))
      .toBe('https://app.reidey.example/api/v1/elprofessor/fleet')
  })

  it('is built from the validated origin, never from raw configuration', () => {
    const result = partnerEndpoint('https://app.reidey.example/')
    expect(result.ok && partnerFleetUrl(result.origin))
      .toBe('https://app.reidey.example/api/v1/elprofessor/fleet')
  })
})

describe('the variable name', () => {
  it('is what .env, the compose file and FUNCTION_ENV must all say', () => {
    expect(PARTNER_ENDPOINT_VAR).toBe('PARTNER_REIDEY_BASE_URL')
  })
})
