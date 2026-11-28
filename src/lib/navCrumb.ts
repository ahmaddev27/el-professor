import type { TranslationKey } from '../i18n';

/** A navigation destination as the shells list them: a path and its label. */
export interface CrumbSource {
  path: string;
  labelKey: TranslationKey;
  /** Matches only the path itself, not the pages under it (NavLink's `end`). */
  end?: boolean;
}

/**
 * The label of the section the address is in, for the topbar's crumb (Reidey's
 * shell: the crumb at the start of the topbar, the actions at its end).
 *
 * The longest matching path wins, so `/admin/companies/42` names Companies and
 * not the `/admin` home, which is listed with `end`. An address no destination
 * covers answers null and the topbar draws no crumb, rather than a wrong one.
 */
export function navCrumbKey(pathname: string, items: readonly CrumbSource[]): TranslationKey | null {
  let best: CrumbSource | null = null;
  for (const item of items) {
    const matches = pathname === item.path || (!item.end && pathname.startsWith(`${item.path}/`));
    if (matches && (!best || item.path.length > best.path.length)) best = item;
  }
  return best?.labelKey ?? null;
}
