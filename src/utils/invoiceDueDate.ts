/**
 * The due date a generated subscription invoice carries.
 *
 * This exists as its own function for one reason: the obvious way to build it is
 * wrong, and it was wrong in production. `new Date(year, month - 1, day)` is
 * local midnight, and `.toISOString()` converts to UTC — so anywhere east of
 * Greenwich the day moves back by one. Measured in Europe/Berlin before the fix:
 * a September invoice with the default `billing_day = 1` stored `2026-08-31`,
 * due in August; `billing_day = 15` stored the 14th; and January stored the 9th
 * for the 10th, so the winter offset does it too. On production, both existing
 * invoices carried it — 2026-05 due 2026-04-30 and 2026-06 due 2026-05-31, each
 * showing the red "Überfällig" badge from the moment it was created.
 *
 * A stored date is a calendar day, not an instant, so it must never be built by
 * converting an instant. There is no Date object here on purpose.
 *
 * `billing_day` is `CHECK (billing_day BETWEEN 1 AND 28)` in the database
 * (20260607125649), and the caller clamps to 28 as well, so February needs no
 * special case; the clamp stays here so the function is correct on its own.
 */
export function invoiceDueDate(year: number, month: number, billingDay: number): string {
  const day = Math.min(Math.max(Math.trunc(billingDay) || 1, 1), 28)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
