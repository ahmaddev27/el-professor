/**
 * Feature flags (plan 3.11): the `feature_flags` setting, a map of flag name to
 * boolean that `get_app_config()` hands every signed-in screen.
 *
 * **A flag the map does not name is off.** That is the whole contract of
 * `useFlag(key)`, and it is what lets a build ship a flag-guarded screen before
 * anybody has written the flag: the screen stays shut until the owner switches
 * it on, and a flag the owner deletes switches it off again.
 *
 * Nothing in the product reads a flag yet. This module and the settings screen
 * are the machinery; the first screen that needs one wires itself to it.
 *
 * The bounds mirror `app_private.platform_settings_problem_flags` (migration
 * 20260920130000); the database validates every value it stores.
 */

export type FeatureFlags = Readonly<Record<string, boolean>>;

export const FLAG_KEY = /^[a-z][a-z0-9_]*$/;
export const FLAG_KEY_MAX = 60;
export const FLAGS_MAX = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isFlagKey(key: string): boolean {
  return key.length <= FLAG_KEY_MAX && FLAG_KEY.test(key);
}

/**
 * The flags an answer carries, or null for anything that is not a map. An
 * entry that is not a boolean under a valid name is dropped — and so reads as
 * off — rather than failing the whole map: one bad entry must not switch the
 * others off.
 */
export function parseFeatureFlags(value: unknown): FeatureFlags | null {
  if (!isRecord(value)) return null;
  const flags: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (isFlagKey(key) && typeof enabled === 'boolean') flags[key] = enabled;
  }
  return flags;
}

/** Whether a flag is on. Unknown, malformed or absent: off. */
export function flagEnabled(flags: FeatureFlags, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, key) && flags[key] === true;
}

// ─── The editor ──────────────────────────────────────────────────────────────

export interface FlagRow {
  key: string;
  enabled: boolean;
}

/** The stored map as rows, sorted by name so the screen does not reorder on save. */
export function flagsToRows(flags: FeatureFlags): FlagRow[] {
  return Object.keys(flags)
    .sort()
    .map(key => ({ key, enabled: flags[key] }));
}

/**
 * Rows back into the map a save would send, or the first thing the database
 * would refuse — named the way it names it (`feature_flags.key`,
 * `feature_flags`).
 */
export function flagsFromRows(rows: readonly FlagRow[]): { value: FeatureFlags } | { error: string } {
  if (rows.length > FLAGS_MAX) return { error: 'feature_flags' };
  const flags: Record<string, boolean> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!isFlagKey(key)) return { error: 'feature_flags.key' };
    // Two rows with one name would silently keep only the last.
    if (Object.prototype.hasOwnProperty.call(flags, key)) return { error: 'feature_flags.key' };
    flags[key] = row.enabled;
  }
  return { value: flags };
}
