/**
 * Two figures the platform panel invented when the read behind them came back
 * short, extracted so that the invention can be asserted against.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * A figure whose read did not succeed is not a fact and must not be drawn as
 * one. Both functions here answer `null` for "not known", and both call sites
 * print a dash for null. Neither substitutes a plausible number.
 *
 * Pure: no Supabase, no React, no clock.
 */

/**
 * How often each referral code was used, counted over the companies the caller
 * actually read.
 *
 * `ReferralCodesManagement` counted `companies.filter(...)` and wrote
 * `usage_count: usageMap[r.ref_code] ?? 0`. Its `companies` prop comes from
 * `SuperAdminDashboard`, whose own load sets it to `[]` in its catch — so a
 * failed or refused company read made **every** code report a confident
 * `0 Nutzungen`, which is the one figure that section exists to report. A count
 * over a list that was not read is not a count of zero; it is not a count.
 *
 * @param refCodes        the codes to count for, as stored (`referrals.ref_code`)
 * @param companies       the companies read, each with its `referral_code_used`
 * @param companiesKnown  false when that list was not read, or is incomplete
 * @returns one entry per code: the count, or null for every code when the
 *          companies are not known
 */
export function referralUsageCounts(
  refCodes: readonly string[],
  companies: readonly { referral_code_used: string | null }[],
  companiesKnown: boolean,
): Record<string, number | null> {
  const counts: Record<string, number | null> = {};
  for (const code of refCodes) counts[code] = companiesKnown ? 0 : null;
  if (!companiesKnown) return counts;
  for (const company of companies) {
    const code = company.referral_code_used;
    // A code no longer in `referrals` is ignored rather than added: the caller
    // asked about the codes it holds, and an extra key would render nowhere.
    if (code && counts[code] !== undefined && counts[code] !== null) {
      counts[code] = (counts[code] as number) + 1;
    }
  }
  return counts;
}

/**
 * How many drivers a company may have: its car limit times the drivers allowed
 * per car.
 *
 * `SuperAdminDashboard` wrote `drivers_per_car_limit: dpcMap[c.id] ?? 4`.
 * `collectCompanyCounts` only records that key where the read model returned a
 * number (`if (row.drivers_per_car_limit !== null)`), so a company whose
 * `company_settings` row is missing — or whose column is null — is absent from
 * the map *even on a wholly successful read*, and the screen then printed a
 * denominator of its own making: `–/12` where the truth may be `–/6`, and a red
 * "limit reached" colour decided by the same invented number.
 *
 * @param perCarLimit null where the read model did not report one
 * @returns the allowance, or null when it is not known
 */
export function driversAllowance(carLimit: number, perCarLimit: number | null): number | null {
  if (perCarLimit === null) return null;
  if (!Number.isFinite(carLimit) || !Number.isFinite(perCarLimit)) return null;
  return carLimit * perCarLimit;
}
