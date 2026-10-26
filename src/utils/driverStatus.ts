/**
 * What "deactivated" means for a driver, in one place.
 *
 * A driver is never deleted (owner's decision, 25.10.2026, confirming what
 * `8da4e26` built on 21.10.2026). Eight foreign keys CASCADE off
 * `public.drivers` — `salaries`, `driver_notes`, `car_driver_assignments`,
 * `historical_reconciliation_drivers`, `historical_reconciliation_results`,
 * `salary_cash_receipts`, `driver_month_budget` and `driver_month_assignments` —
 * and `salary_cash_receipts` holds the signed, numbered `GQ-YYYY-NNNN` receipts
 * that are gapless per company and year and go to a Steuerberater. Deleting a
 * driver would tear a gap in a numbered financial document series and nothing
 * else holds the receipt's text. (`saved_stundennachweise` is the one child with
 * no `ON DELETE` action at all, so it would have *refused* the delete rather
 * than cascade — it was never at risk.) Ten more keys `SET NULL`, so the ride
 * log's own rows would survive with no driver at all.
 *
 * (The ride-log table is deliberately named in words here and not by its
 * identifier: `src/utils/simulatedRides/readers.test.ts` holds an inventory of
 * every file under `src/` that names it, on the premise that such a file is a
 * reader needing a decision about simulated rides. This file is not a reader,
 * and adding it to that inventory to quiet the guard would weaken it.)
 *
 * So `drivers.status` carries the state, and the browser's job is to apply it.
 *
 * THE RULE THIS FILE HAS TO KEEP — and it is the one the call sites get wrong:
 * **a list to pick from and a list of what happened are different, and only the
 * first may hide anyone.**
 *
 * - A **chooser** offers a driver for *future* work — the plan generator's pool,
 *   a dropdown on a modal, the Fahrtenbuch's assignment picker. It excludes a
 *   deactivated driver. That is the owner's instruction: "ما يبين في الليستات
 *   الأخريات" — they appear in no other list.
 * - A **record** is a past month's Stundennachweis, a salary already paid, a
 *   Gehaltsquittung, a finished week's Abrechnung, the trips a driver actually
 *   drove. It still shows them, or the product starts hiding what happened. A
 *   driver who worked in September is in September's figures, and dropping them
 *   would change a statutory document and break reconciliation with the
 *   Steuerberater.
 *
 * `src/utils/driverReads.test.ts` is the registry that makes a new
 * `from('drivers')` read declare which of the two it is.
 *
 * ## Why an absent status is not "active"
 *
 * In the database the column is `text DEFAULT 'active' NOT NULL` with
 * `CHECK (status IN ('active','inactive'))`, so it is never NULL there. In the
 * browser `Driver.status` is optional for a different reason: several reads do
 * not *select* the column (`CarsManagement` asks for `id, name`). So an absent
 * status means "nobody asked", never "this driver has no status" — and
 * `isDeactivatedDriver` answers false for it, because it does not know.
 *
 * That is why a chooser's real boundary is the **query**: filter with
 * `.eq('status', ACTIVE_DRIVER_STATUS)` wherever the list is built for picking.
 * `selectableDrivers` is for the lists that are already in memory in full —
 * `select('*')`, or a select that names `status` — where filtering again at the
 * query would mean a second place the rule lives.
 */

/** The value `drivers.status` holds for a driver who may be picked. */
export const ACTIVE_DRIVER_STATUS = 'active';

/** The value `drivers.status` holds for a driver who has been deactivated. */
export const DEACTIVATED_DRIVER_STATUS = 'inactive';

/**
 * Anything carrying a driver's status, however it was read.
 *
 * Structural on purpose: `Driver`, `PlanningDriver`, `CompanyDriver`,
 * `ReceiptDriver` and a raw `drivers` row all satisfy it without being
 * converted first.
 */
export interface DriverStatusLike {
  status?: string | null;
}

/**
 * Whether this driver is known to be deactivated.
 *
 * False for a row that does not carry the column — see the file header. A
 * caller that needs certainty reads `status`, or filters in the query.
 */
export function isDeactivatedDriver(driver: DriverStatusLike): boolean {
  return driver.status === DEACTIVATED_DRIVER_STATUS;
}

/**
 * The drivers a chooser may offer, in the order they came.
 *
 * For a list already held in full. A chooser that issues its own query filters
 * there instead, with `ACTIVE_DRIVER_STATUS`.
 */
export function selectableDrivers<T extends DriverStatusLike>(drivers: readonly T[]): T[] {
  return drivers.filter(driver => !isDeactivatedDriver(driver));
}

/**
 * A driver's name with the deactivated marker appended, for a **record** that
 * still shows them.
 *
 * The caller passes its own translator so the marker follows the UI language.
 *
 * The key is `gq.driver.inactive` — `{name} (inaktiv)` / `{name} (inactive)` —
 * and **no new key was added**, because that one is already the codebase's
 * shared "(inaktiv)" suffix: the Gehaltsquittung picker has used it since 3.13
 * and `NotesPage` reuses it verbatim for a retired car's plate, with a comment
 * at that call site saying so. A second key with the same text in both
 * languages would be a second visual language for one idea. Its `gq.` prefix is
 * now wrong for four consumers, two of which are not Gehaltsquittung screens;
 * renaming it is a dictionary change of its own and is noted in HANDOFF.md
 * rather than folded in here.
 */
export function driverNameWithStatus(
  driver: DriverStatusLike & { name: string },
  t: (key: 'gq.driver.inactive', vars: { name: string }) => string,
): string {
  return isDeactivatedDriver(driver) ? t('gq.driver.inactive', { name: driver.name }) : driver.name;
}
