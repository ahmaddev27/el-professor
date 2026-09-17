/**
 * Calling a platform write RPC from a platform screen (plan 3.5).
 *
 * Every platform write is one SECURITY DEFINER function that checks
 * `platform_can(capability)` and writes its own audit row — the refusal
 * included — in the same transaction. They all answer the same shape:
 *
 *   { success: true,  … }
 *   { success: false, reason: 'denied' | 'invalid' | 'not_found' | …,
 *                     error: 'a German sentence' }
 *
 * `reason` is a stable code; `error` is what a screen shows. The screens here
 * already report failures by throwing inside a try/catch and showing
 * `err.message`, so this helper throws the German sentence and keeps the shape
 * of every call site.
 *
 * Hiding a button a role may not use is a courtesy (`platformCan` from
 * SuperAdminContext). The database refuses regardless, which is what these
 * functions are for.
 */
import { supabase } from './supabase';

export interface PlatformRpcResult {
  success: boolean;
  reason?: string;
  error?: string;
  [key: string]: unknown;
}

/** Raised when a platform RPC answered `success: false`. Carries its reason. */
export class PlatformRpcError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = 'PlatformRpcError';
    this.reason = reason;
  }
}

/**
 * Calls a platform RPC and returns its answer, or throws:
 *
 * - a transport or permission failure (no EXECUTE, no session) keeps Supabase's
 *   own message, as every direct write did before;
 * - `success: false` becomes a PlatformRpcError with the function's German
 *   sentence and its reason code.
 */
export async function callPlatformRpc(
  fn: string,
  args: Record<string, unknown>,
): Promise<PlatformRpcResult> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);

  const result = (data ?? null) as PlatformRpcResult | null;
  if (!result || typeof result.success !== 'boolean') {
    // A function that answered nothing recognisable: treat it as a failure
    // rather than reporting a change that may not have happened.
    throw new PlatformRpcError('Die Aktion konnte nicht ausgeführt werden.', 'unknown');
  }
  if (!result.success) {
    throw new PlatformRpcError(
      result.error ?? 'Die Aktion konnte nicht ausgeführt werden.',
      result.reason ?? 'unknown',
    );
  }
  return result;
}
