/**
 * Who a week's Abrechnung can be mailed to, and who it cannot.
 *
 * ## Why this is a module and not three lines in the screen
 *
 * The Abrechnung carries **no driver id**. Its rows name a driver and nothing
 * else — `get_weekly_abrechnung` returns `driver_name`, and the screen has worked
 * that way since it was written. So mailing a driver means matching a name
 * against the company's driver list, and a name is not a key.
 *
 * Two drivers called "Mehmet Yılmaz" is not a hypothetical in a fleet that hires
 * from one community, and the cost of taking the first match is **one driver's
 * money figures in another person's inbox**. So an ambiguous name is never
 * resolved by picking one: it is reported, and the operator fixes the data or
 * sends that one by hand.
 *
 * Four outcomes, and the screen shows all four before anything is sent, because
 * the owner asked for the drivers who will be skipped to be named rather than
 * passed over in silence.
 */

/** A driver as the company list holds them. */
export interface RecipientDriver {
  id: string;
  name: string;
  email?: string | null;
}

export interface Recipient {
  /** The name as the Abrechnung row spells it, for a message about that row. */
  rowName: string;
  driverId: string;
  driverName: string;
  email: string;
}

export interface RecipientPlan {
  /** Drivers who will receive the mail. */
  sendable: Recipient[];
  /** Named in the company list, but with no address. Ordinary, not an error. */
  noEmail: string[];
  /** More than one driver carries this name. Never resolved by guessing. */
  ambiguous: string[];
  /** No driver of this company carries this name at all. */
  unknown: string[];
}

/**
 * The comparison key for a name.
 *
 * Case and inner spacing are noise — "Nora  Vogt" and "nora vogt" are one
 * person in anybody's reading. Everything else is kept: accents and non-Latin
 * letters are part of a name, and folding them would make two different people
 * one.
 */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');
}

/**
 * Decides, for the names on a week's table, who can be mailed.
 *
 * Pure: the screen renders what this returns and sends to `sendable` alone. The
 * order of `sendable` follows the order the names came in, so the confirmation
 * reads down the table the operator is looking at.
 */
export function planRecipients(
  rowNames: readonly string[],
  drivers: readonly RecipientDriver[],
): RecipientPlan {
  const byKey = new Map<string, RecipientDriver[]>();
  for (const driver of drivers) {
    const key = nameKey(driver.name);
    const list = byKey.get(key);
    if (list) list.push(driver);
    else byKey.set(key, [driver]);
  }

  const plan: RecipientPlan = { sendable: [], noEmail: [], ambiguous: [], unknown: [] };
  // A name can appear twice on one table — the monthly view groups by driver, but
  // a caller may pass anything. Each distinct name is decided once.
  const seen = new Set<string>();

  for (const rowName of rowNames) {
    const key = nameKey(rowName);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);

    const matches = byKey.get(key) ?? [];
    if (matches.length === 0) {
      plan.unknown.push(rowName);
      continue;
    }
    if (matches.length > 1) {
      // Never "the first one". Two people share this name and only the operator
      // knows which of them drove this week.
      plan.ambiguous.push(rowName);
      continue;
    }

    const driver = matches[0];
    const email = (driver.email ?? '').trim();
    if (email === '') {
      plan.noEmail.push(rowName);
      continue;
    }
    plan.sendable.push({ rowName, driverId: driver.id, driverName: driver.name, email });
  }

  return plan;
}

/**
 * True when there is nothing to send — so the button can say so rather than
 * opening a confirmation with an empty list.
 */
export function nothingToSend(plan: RecipientPlan): boolean {
  return plan.sendable.length === 0;
}
