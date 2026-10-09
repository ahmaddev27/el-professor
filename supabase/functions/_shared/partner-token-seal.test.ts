import { describe, expect, it } from 'vitest'
import {
  looksSealed,
  openPartnerToken,
  sealPartnerToken,
  SEAL_MIN_KEY_LENGTH,
  SEAL_PREFIX,
} from './partner-token-seal'

const KEY = 'k'.repeat(32)
const OTHER_KEY = 'j'.repeat(40)
const TOKEN = '17|AbCdEf0123456789xyzQwErTy'

describe('sealPartnerToken', () => {
  it('round-trips the token', async () => {
    const sealed = await sealPartnerToken(KEY, TOKEN)
    expect(await openPartnerToken(KEY, sealed)).toBe(TOKEN)
  })

  it('carries its version, so a later rotation can tell old rows from new', async () => {
    const sealed = await sealPartnerToken(KEY, TOKEN)
    expect(sealed.startsWith(`${SEAL_PREFIX}.`)).toBe(true)
    expect(sealed.split('.')).toHaveLength(3)
  })

  it('never writes the token into its own output', async () => {
    const sealed = await sealPartnerToken(KEY, TOKEN)
    expect(sealed).not.toContain(TOKEN)
    expect(sealed).not.toContain('AbCdEf')
  })

  it('uses a fresh IV, so the same token twice is two different rows', async () => {
    const a = await sealPartnerToken(KEY, TOKEN)
    const b = await sealPartnerToken(KEY, TOKEN)
    expect(a).not.toBe(b)
    // ...and both still open. A deterministic seal would leak that two
    // companies pasted the same token.
    expect(await openPartnerToken(KEY, a)).toBe(TOKEN)
    expect(await openPartnerToken(KEY, b)).toBe(TOKEN)
  })

  it('handles a token with the characters Sanctum actually produces', async () => {
    for (const token of ['1|abc', '999|' + 'Z'.repeat(40), 'plain-no-pipe', 'ü✓ unicode']) {
      expect(await openPartnerToken(KEY, await sealPartnerToken(KEY, token))).toBe(token)
    }
  })

  it('refuses a key under the floor rather than hashing weak material into a valid key', async () => {
    await expect(sealPartnerToken('short', TOKEN)).rejects.toThrow(/shorter than 32/)
    expect(SEAL_MIN_KEY_LENGTH).toBe(32)
  })

  it('refuses to seal nothing', async () => {
    await expect(sealPartnerToken(KEY, '   ')).rejects.toThrow(/nothing to seal/)
  })

  it('accepts a key longer than the floor', async () => {
    const sealed = await sealPartnerToken(OTHER_KEY, TOKEN)
    expect(await openPartnerToken(OTHER_KEY, sealed)).toBe(TOKEN)
  })
})

describe('openPartnerToken', () => {
  it('answers null for the wrong key, not the wrong token', async () => {
    const sealed = await sealPartnerToken(KEY, TOKEN)
    expect(await openPartnerToken(OTHER_KEY, sealed)).toBeNull()
  })

  it('answers null for a tampered ciphertext — the tag is the point of GCM', async () => {
    const sealed = await sealPartnerToken(KEY, TOKEN)
    const parts = sealed.split('.')
    // Flip one character of the ciphertext. Without the tag this would decrypt
    // to rubbish and be replayed as if it were a token.
    const body = parts[2]
    const flipped = (body[0] === 'A' ? 'B' : 'A') + body.slice(1)
    expect(await openPartnerToken(KEY, `${parts[0]}.${parts[1]}.${flipped}`)).toBeNull()
  })

  it('answers null for a tampered IV', async () => {
    const sealed = await sealPartnerToken(KEY, TOKEN)
    const parts = sealed.split('.')
    const iv = parts[1]
    const flipped = (iv[0] === 'A' ? 'B' : 'A') + iv.slice(1)
    expect(await openPartnerToken(KEY, `${parts[0]}.${flipped}.${parts[2]}`)).toBeNull()
  })

  it.each([
    ['a version this build does not know', 'v2.AAAAAAAAAAAAAAAA.AAAA'],
    ['no version at all', 'AAAAAAAAAAAAAAAA.AAAA'],
    ['too many parts', 'v1.a.b.c'],
    ['empty', ''],
    ['the plaintext itself, stored by mistake', TOKEN],
  ])('answers null for %s', async (_label, stored) => {
    expect(await openPartnerToken(KEY, stored)).toBeNull()
  })

  it('still THROWS for a misconfigured key, which is not one unusable row', async () => {
    // A short key is a deployment fault. Answering null would report it as
    // "this one connection cannot be used", which is the wrong diagnosis for
    // every connection at once.
    const sealed = await sealPartnerToken(KEY, TOKEN)
    await expect(openPartnerToken('short', sealed)).rejects.toThrow(/shorter than 32/)
  })
})

describe('looksSealed', () => {
  it('recognises what this build wrote', async () => {
    expect(looksSealed(await sealPartnerToken(KEY, TOKEN))).toBe(true)
  })

  it.each([null, undefined, 42, {}, '', TOKEN, 'v2.a.b', 'v1.a'])(
    'rejects %s',
    (value) => {
      expect(looksSealed(value)).toBe(false)
    },
  )
})
