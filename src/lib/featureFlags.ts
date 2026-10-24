/**
 * Feature flags (plan 3.11): the `feature_flags` setting, a map of flag name to
 * boolean that `get_app_config()` hands every signed-in screen.
 *
 * **A flag the map does not name is off.** That is the whole contract of
 * `useFlag(key)`, and it is what lets a build ship a flag-guarded screen before
 * anybody has written the flag: the screen stays shut until the owner switches
 * it on, and a flag the owner deletes switches it off again.
 *
 * **`FLAG_DEFINITIONS` below is the list of flags this build knows**, and the
 * settings screen draws one switch per entry — never a name an operator typed.
 * The screen had a free-text "new flag" box until 24.10.2026; the owner removed
 * it, and the reason it had been kept does not survive contact with the
 * contract above. It was copied from `plan_features`, where a key the map does
 * not name reads as **premium** — locked — so seeding a key ahead of the
 * release that gates it genuinely matters there. For a flag an unnamed key is
 * **off**, which is the same state as present-and-switched-off, so seeding one
 * early accomplishes nothing at all.
 *
 * A stored flag this build does not know is still shown, with its stored value
 * and marked as unknown, and is still removable: with no add box, removal is
 * the only way out for a stale flag that reached the row by SQL or from an
 * older build.
 *
 * The bounds mirror `app_private.platform_settings_problem_flags` (migration
 * 20260920130000); the database validates every value it stores. **No migration
 * belongs to the registry**: the database must go on storing a flag this build
 * does not know, which is what makes a rollback and an older build's flag
 * readable rather than an error.
 */
import type { TranslationKey } from '../i18n';

export type FeatureFlags = Readonly<Record<string, boolean>>;

/**
 * The flags this build reads, each with the label and the description the
 * settings screen shows. `PAGE_DEFINITIONS`' shape, for the same reason: the
 * operator is choosing among things the build does something with, so the list
 * is in code and the words are translation keys.
 *
 * Adding a flag means adding it here, in the release that reads it, with a
 * description of what switching it on does. `featureFlagCallSites.test.ts`
 * fails a build where a flag is read but not listed, or listed but read by
 * nothing.
 */
export const FLAG_DEFINITIONS = [
  {
    key: 'travel_estimator',
    label: 'admin.flags.flag.travelEstimator',
    description: 'admin.flags.flag.travelEstimator.desc',
  },
] as const satisfies readonly { key: string; label: TranslationKey; description: TranslationKey }[];

export type FlagDefinition = (typeof FLAG_DEFINITIONS)[number];

/** The names of the flags this build knows, in the order the screen shows them. */
export const KNOWN_FLAG_KEYS: readonly string[] = FLAG_DEFINITIONS.map(flag => flag.key);

/** Whether this build knows a flag. An unknown one is stored but read by nothing here. */
export function isKnownFlag(key: string): boolean {
  return KNOWN_FLAG_KEYS.includes(key);
}

/** The definition of a known flag, or null. */
export function flagDefinition(key: string): FlagDefinition | null {
  return FLAG_DEFINITIONS.find(flag => flag.key === key) ?? null;
}

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
  /**
   * Whether `FLAG_DEFINITIONS` names it. An unknown row is a flag stored in the
   * database that this build reads nowhere — shown so it can be seen and
   * removed, never presented as something this build does something with.
   */
  known: boolean;
}

/**
 * The rows the screen draws: every flag this build knows, in registry order and
 * **off when the stored map does not name it** (absent and off are the same
 * state, so an absent known flag is a switch that is off, never an error), then
 * every stored flag this build does not know, sorted by name.
 *
 * The order does not depend on the stored map, so a save does not reorder the
 * list under the operator's hands.
 *
 * A save therefore writes an explicit `false` for a known flag that was absent.
 * That changes no behaviour — `flagEnabled` reads absent and `false` alike — and
 * it leaves the stored document naming what the build knows.
 */
export function flagsToRows(flags: FeatureFlags): FlagRow[] {
  const known = FLAG_DEFINITIONS.map(flag => ({
    key: flag.key,
    enabled: flagEnabled(flags, flag.key),
    known: true,
  }));
  const unknown = Object.keys(flags)
    .filter(key => !isKnownFlag(key))
    .sort()
    .map(key => ({ key, enabled: flags[key], known: false }));
  return [...known, ...unknown];
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
