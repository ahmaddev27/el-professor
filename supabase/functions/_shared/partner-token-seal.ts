/**
 * Sealing a partner's bearer token so it can be REPLAYED.
 *
 * Every other secret this product stores in the database is one-way: activation
 * codes are SHA-256, one-time codes and partner keys are HMAC-SHA256. This is
 * the first that must come back out, and the reason is measured rather than
 * assumed: Reidey returns the plaintext token **once**, and re-issuing deletes
 * the previous one (`ElProfessorController::issueToken` calls
 * `elprofessorTokens()->delete()` first). So a connection that does not keep
 * the token cannot be used again without the operator re-minting it, which
 * breaks the link they just made.
 *
 * ## Why the sealing happens here and not in SQL
 *
 * `pgcrypto` is installed and used for `digest()` ten times and nothing else —
 * there is no symmetric encryption anywhere in this schema. Doing it in SQL
 * would mean the key and the plaintext travelling as literals inside query
 * text, which is the worst place for a secret: it reaches logs,
 * `pg_stat_statements` and error reports. Here the database sees ciphertext and
 * never the key.
 *
 * ## The key is its own secret
 *
 * `PARTNER_SEAL_KEY`, not a subkey of `OTP_PEPPER`. Deriving it would have saved
 * one environment variable and one deploy guard, and coupled two unrelated
 * lifetimes: rotating the pepper — which five functions hold, for one-time
 * codes — would force every partner token to be re-sealed. One secret, one
 * function, one reason to rotate.
 *
 * ## The shape on disk, and why each part is there
 *
 *   v1.<base64url iv>.<base64url ciphertext+tag>
 *
 * AES-256-GCM, a fresh 12-byte IV per seal, and the tag is what makes a
 * tampered ciphertext fail to open rather than decrypt to rubbish. The `v1`
 * prefix is not decoration: a key rotation or an algorithm change needs a way
 * to tell an old row from a new one, and adding that later means guessing at
 * rows already written.
 *
 * ## What it is NOT
 *
 * This is encryption at rest against a database dump — the nightly backup
 * includes `app_private` — and nothing more. Anything holding both the database
 * and the functions' environment holds the tokens. What bounds the damage is on
 * Reidey's side: the token carries only `elprofessor:read` and is revocable
 * there.
 */

const SEAL_VERSION = 'v1'
const IV_BYTES = 12
/** 32 bytes of key material, as AES-256 requires. */
const MIN_KEY_LENGTH = 32

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * The AES key for this secret.
 *
 * SHA-256 of the configured secret, so any key of sufficient length yields the
 * 32 bytes AES-256 needs. The length floor is still enforced: hashing a short
 * secret would produce a well-formed key from weak material, which is exactly
 * the mistake `deploy.sh`'s 32-character guard on `OTP_PEPPER` exists to stop.
 */
async function aesKey(secret: string): Promise<CryptoKey> {
  if (secret.length < MIN_KEY_LENGTH) {
    throw new Error('partner token seal: the key is shorter than 32 characters')
  }
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** `v1.<iv>.<ciphertext>`, with a fresh IV every time. */
export async function sealPartnerToken(secret: string, token: string): Promise<string> {
  if (token.trim() === '') throw new Error('partner token seal: nothing to seal')
  const key = await aesKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(token),
  )
  return `${SEAL_VERSION}.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`
}

/**
 * The token back, or `null`.
 *
 * Null rather than a throw for every failure a caller can do nothing about: a
 * version this build does not know, a malformed row, a wrong key, a tampered
 * ciphertext. The outbound call then reports "this connection cannot be used"
 * instead of a 500 that reads as our own fault — the `loadMailDeliverySettings`
 * rule, where a document this build cannot read falls back rather than refusing
 * to work.
 *
 * A short key still throws: that is a misconfigured deployment, not a bad row,
 * and it must not read as one unusable connection.
 */
export async function openPartnerToken(secret: string, sealed: string): Promise<string | null> {
  if (secret.length < MIN_KEY_LENGTH) {
    throw new Error('partner token seal: the key is shorter than 32 characters')
  }
  const parts = sealed.split('.')
  if (parts.length !== 3 || parts[0] !== SEAL_VERSION) return null
  try {
    const key = await aesKey(secret)
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64url(parts[1]) }, key, fromBase64url(parts[2]),
    )
    return new TextDecoder().decode(opened)
  } catch {
    return null
  }
}

/** Whether a stored value is a seal this build can attempt at all. */
export function looksSealed(value: unknown): boolean {
  return typeof value === 'string'
    && value.split('.').length === 3
    && value.startsWith(`${SEAL_VERSION}.`)
}

export const SEAL_PREFIX = SEAL_VERSION
export const SEAL_MIN_KEY_LENGTH = MIN_KEY_LENGTH
