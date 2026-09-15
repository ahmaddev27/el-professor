import { describe, expect, it } from 'vitest';
import { activationCodeHash, generateActivationCode } from './activation-code.ts';

describe('activationCodeHash', () => {
  it('is the lower-case hex SHA-256 of the digits, as redeem_activation_code computes it', async () => {
    // encode(sha256(convert_to('123456', 'UTF8')), 'hex')
    expect(await activationCodeHash('123456')).toBe('8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92');
  });
});

describe('generateActivationCode', () => {
  it('draws six digits from the random source and keeps the last four', async () => {
    const generated = await generateActivationCode(() => 4_242);
    expect(generated.code).toBe('004242');
    expect(generated.codeLast4).toBe('4242');
    expect(generated.codeHash).toBe(await activationCodeHash('004242'));
  });

  it('draws again when a value would bias the digits', async () => {
    const values = [4_294_967_295, 123_456];
    const generated = await generateActivationCode(() => values.shift() ?? 0);
    expect(generated.code).toBe('123456');
  });

  it('uses crypto.getRandomValues by default', async () => {
    const generated = await generateActivationCode();
    expect(generated.code).toMatch(/^\d{6}$/);
    expect(generated.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.codeLast4).toBe(generated.code.slice(-4));
  });
});
