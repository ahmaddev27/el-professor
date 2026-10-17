/**
 * Who receives a company's own mail from El-Professor, once the company has
 * named an address (owner request 15.10.2026).
 *
 * Pure: no Deno, `npm:` or `jsr:` import, so vitest runs it and the settings
 * screen imports the same shape check the database constraint mirrors.
 *
 * ─── The rule, stated once: the address REPLACES the administrators ──────────
 *
 * Choice (a), not (b). The owner asked for "the address where the emails will
 * be reached", which is a redirect; adding it to the administrators would send
 * every mail twice to a company that set one. The cost of (a) is real and is
 * accepted on purpose: a well-formed address that is the wrong one means the
 * company receives nothing until it is corrected. The screen says so before it
 * is saved, and clearing the field restores the administrators.
 *
 * Since 20261015140000 the administrator may also list addresses PER KIND of
 * mail (`notification_recipients`); such a list wins over the single address.
 * See `chooseCompanyRecipients` for the precedence.
 *
 * Scope: company-level mail only — the Abrechnung manager summary and the TUEV
 * and trial notices, which all read `loadRecipients()`. Driver mail goes to
 * `drivers.email` and never passes through here, and one-time codes and
 * activation codes keep their own recipients.
 *
 * `abrechnung_schedule_preview` (20261015100000) restates this in SQL.
 */

/** `drivers_email_shape`'s expression, and company_settings_notification_email_shape's. */
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type NotificationAddressInput =
  | { kind: 'empty' }
  | { kind: 'valid'; value: string }
  | { kind: 'invalid' };

/** What an operator typed: blank clears the setting, a malformed value is refused. */
export function parseNotificationAddress(raw: unknown): NotificationAddressInput {
  if (raw === null || raw === undefined) return { kind: 'empty' };
  if (typeof raw !== 'string') return { kind: 'invalid' };
  const value = raw.trim();
  if (value === '') return { kind: 'empty' };
  return ADDRESS_SHAPE.test(value) ? { kind: 'valid', value } : { kind: 'invalid' };
}

/** The stored value if it is a usable address, otherwise null ("not set"). */
export function storedNotificationAddress(raw: unknown): string | null {
  const parsed = parseNotificationAddress(raw);
  return parsed.kind === 'valid' ? parsed.value : null;
}

/**
 * The kinds of company mail whose recipients the administrator can list
 * (migration 20261015140000, `notification_recipients_type_check`): the two
 * expiry notices of notification-core.ts and the weekly Abrechnung summary for
 * the manager. A test pins this list to the migration's CHECK and to
 * `NOTIFICATION_TYPES`, so a kind added in one place and not the others fails
 * the build. Driver mail, one-time codes and activation codes address a person
 * and are not in it.
 */
export const RECIPIENT_KINDS = [
  'tuev_bald_ablaufend',
  'tuev_abgelaufen',
  'manager_summary',
] as const;

export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

/** The most addresses one kind may hold; the database trigger enforces the same number. */
export const MAX_ADDRESSES_PER_KIND = 10;

export function isRecipientKind(value: unknown): value is RecipientKind {
  return RECIPIENT_KINDS.some((kind) => kind === value);
}

/** One stored row of `notification_recipients`, as far as selection is concerned. */
export interface RecipientRow {
  notification_type: unknown;
  email: unknown;
}

/**
 * The usable addresses listed for one kind: well-formed, one per mailbox
 * (compared case-insensitively, the first spelling kept), in the order given.
 */
export function addressesForKind(rows: readonly RecipientRow[], kind: RecipientKind): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    if (row.notification_type !== kind) continue;
    const address = storedNotificationAddress(row.email);
    if (!address || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    out.push(address);
  }
  return out;
}

/** Whether any of these kinds will fall through to the administrators, so they must be looked up. */
export function needsAdministrators(input: {
  kinds: readonly RecipientKind[];
  rows: readonly RecipientRow[];
  configured: unknown;
}): boolean {
  if (storedNotificationAddress(input.configured)) return false;
  return input.kinds.some((kind) => addressesForKind(input.rows, kind).length === 0);
}

/**
 * The recipients of a company-level mail, in order of precedence:
 *
 *   1. the addresses listed for this kind, if there is at least one;
 *   2. otherwise the company's single notification address;
 *   3. otherwise the administrators.
 *
 * A list REPLACES the lower steps, it is not added to them, for the reason
 * given in the header: the administrator named who should get this mail.
 * `listed` is optional so the two-step callers keep working unchanged.
 * `preview` in abrechnung_schedule_preview restates this in SQL.
 */
export function chooseCompanyRecipients(input: {
  listed?: readonly string[];
  configured: unknown;
  admins: readonly string[];
}): string[] {
  if (input.listed && input.listed.length > 0) return [...input.listed];
  const address = storedNotificationAddress(input.configured);
  return address ? [address] : [...input.admins];
}
