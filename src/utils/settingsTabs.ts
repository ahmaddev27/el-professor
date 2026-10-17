/**
 * The tabs of the company settings page, and how one is read from the address.
 *
 * The open tab lives in `?tab=` so a reload and a shared link keep it. A value
 * from the query string decides what renders, so it is never trusted: only an
 * exact member of the list below is accepted, and anything else (absent,
 * unknown, an object key such as `__proto__`, a long or hostile string) is the
 * first tab. Membership is tested against the array, not an object, so a
 * prototype name cannot pass.
 */
export const SETTINGS_TABS = ['company', 'legal', 'operations', 'connections'] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const DEFAULT_SETTINGS_TAB: SettingsTab = SETTINGS_TABS[0];

/** The tabs whose fields belong to the one company form and its save bar. */
export const SETTINGS_FORM_TABS: readonly SettingsTab[] = ['company', 'legal', 'operations'];

export function parseSettingsTab(raw: string | null | undefined): SettingsTab {
  if (typeof raw !== 'string') return DEFAULT_SETTINGS_TAB;
  return SETTINGS_TABS.find(tab => tab === raw) ?? DEFAULT_SETTINGS_TAB;
}
