/**
 * The drivers a day's Uber pull created or linked itself (`uber_pull_runs.placed_drivers`).
 *
 * The column is JSON written by the pull, so every entry is checked: anything
 * that is not `{name: string, action: 'created' | 'linked'}` is dropped rather
 * than shown, and a column that is not an array is no entries at all.
 */
export type PlacedAction = 'created' | 'linked';

export interface PlacedDriver {
  name: string;
  action: PlacedAction;
}

export function parsePlacedDrivers(raw: unknown): PlacedDriver[] {
  if (!Array.isArray(raw)) return [];
  const out: PlacedDriver[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, action } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim() === '') continue;
    if (action !== 'created' && action !== 'linked') continue;
    out.push({ name: name.trim(), action });
  }
  return out;
}

export function placedNames(placed: readonly PlacedDriver[], action: PlacedAction): string[] {
  return placed.filter(p => p.action === action).map(p => p.name);
}
