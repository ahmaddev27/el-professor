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
 * The recipients of a company-level mail. A usable configured address wins and
 * the administrators are not added; an unset or unusable one falls back to them.
 */
export function chooseCompanyRecipients(input: {
  configured: unknown;
  admins: readonly string[];
}): string[] {
  const address = storedNotificationAddress(input.configured);
  return address ? [address] : [...input.admins];
}
