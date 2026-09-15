/**
 * Activation codes as the database keeps them: six digits, stored only as the
 * lower-case hex SHA-256 of those digits plus the last four in the clear.
 *
 * redeem_activation_code hashes what a user types the same way
 * (`encode(sha256(convert_to(code, 'UTF8')), 'hex')`), so the two must never
 * drift apart. The digits come from crypto.getRandomValues through the same
 * rejection sampling as the one-time codes, so every code is equally likely.
 *
 * No Deno, npm: or jsr: import: vitest runs this file in Node.
 */
import { generateCode, secureRandomUint32 } from './otp-core.ts';

export interface GeneratedActivationCode {
  /** Exists only in memory until it is mailed. Never log it, return it or store it. */
  code: string;
  codeHash: string;
  codeLast4: string;
}

const encoder = new TextEncoder();

/** The hash redeem_activation_code looks a typed code up by. */
export async function activationCodeHash(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A new six-digit code with its hash and last four. The random source is injectable for tests. */
export async function generateActivationCode(
  randomUint32: () => number = secureRandomUint32,
): Promise<GeneratedActivationCode> {
  const code = generateCode(randomUint32);
  return { code, codeHash: await activationCodeHash(code), codeLast4: code.slice(-4) };
}
