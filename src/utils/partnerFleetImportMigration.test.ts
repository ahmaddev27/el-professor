/**
 * The fleet import's migration, read as text, because the RLS kit that executes
 * it runs on the VPS and not in this build.
 *
 * What is pinned is the owner's one rule, and the places it is easy to lose:
 * a partner driver whose normalised name already exists in the company is
 * LINKED to that driver and never created again, and the import never writes
 * `drivers.name` of an existing driver. `drivers.name` is text with no foreign
 * key and income, receipts and the Abrechnung join on it, so a second row for
 * the same person splits their money across two names.
 *
 * The driver import is read from 20261128120000, its live definition: that
 * migration restated 20261127120000's body (the rule "link only when certain")
 * with one change, a row a person unlinked is skipped before the rule is asked.
 * The vehicle import is still 20261015110000's. The rule itself lives in
 * app_private.partner_driver_certain_match and is pinned from 20261127120000.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20261015110000_partner_fleet_import.sql'),
  'utf8',
);

const CERTAIN_SQL = readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20261127120000_partner_certain_driver_link.sql'),
  'utf8',
);

const UNLINK_SQL = readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20261128120000_partner_driver_unlink.sql'),
  'utf8',
);

/** The body of one function, from its CREATE to the closing dollar quote. */
function bodyIn(sql: string, schema: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${schema}.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const open = sql.indexOf('AS $$', start);
  return sql.slice(open, sql.indexOf('$$;', open + 5));
}
const body = (name: string): string => bodyIn(SQL, 'public', name);

describe('partner_drivers_import', () => {
  const drivers = bodyIn(UNLINK_SQL, 'public', 'partner_drivers_import');
  const rule = bodyIn(CERTAIN_SQL, 'app_private', 'partner_driver_certain_match');

  it('asks the one rule and compares no name itself', () => {
    expect(drivers).toContain('app_private.partner_driver_certain_match(v_company, v_partner, v_link.proposed_name)');
    expect(drivers).not.toMatch(/btrim\(d\.name\)/);
    expect(drivers).not.toContain('unbekannter fahrer');
  });

  it('the rule looks a driver up by the exact normalised name inside the company', () => {
    expect(rule).toMatch(/d\.company_id = p_company AND lower\(btrim\(d\.name\)\) = v_key/);
    expect(rule).not.toMatch(/similarity|levenshtein|soundex|metaphone|ILIKE/i);
  });

  it('the rule decides in the owner\'s order: none creates, then ambiguous, inactive, taken, else match', () => {
    const order = ["o_action := 'create'", "'name_ambiguous'", "'name_inactive'", "'name_taken'", "o_action := 'match'"]
      .map((needle) => rule.indexOf(needle));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(rule).toContain("v_key = 'unbekannter fahrer'");
  });

  it('creates only when the rule said create, and links through the one apply', () => {
    const create = drivers.indexOf('INSERT INTO public.drivers');
    expect(create).toBeGreaterThan(drivers.indexOf("v_action = 'create'"));
    expect(drivers).toContain('app_private.partner_driver_link_apply(v_link.id, v_driver, v_caller, v_method)');
    expect(drivers).not.toMatch(/SET\s+status\s*=\s*'linked'/);
  });

  it('never writes an existing driver and never names a ruled-out column', () => {
    expect(drivers).not.toMatch(/UPDATE\s+(public\.)?drivers/i);
    expect(drivers).not.toMatch(/employment_type|salary_ratio|personalnummer/i);
  });

  it('never offers a row a person unlinked to the rule, and says why it skipped it', () => {
    const skip = drivers.indexOf('IF v_link.unlinked_at IS NOT NULL THEN');
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(drivers.indexOf('app_private.partner_driver_certain_match('));
    expect(drivers.slice(skip, drivers.indexOf('ELSE', skip))).toContain("v_reason := 'unlinked'");
  });

  it('reports the limit instead of raising it', () => {
    expect(drivers).toContain("'limit_reached'");
    expect(drivers).not.toMatch(/subscription_car_limit/);
  });
});

describe('partner_vehicles_import', () => {
  const vehicles = body('partner_vehicles_import');

  it('never reads an exception detail, which could name another company', () => {
    expect(vehicles).toContain('WHEN unique_violation');
    expect(vehicles).not.toMatch(/PG_EXCEPTION_DETAIL/);
  });

  it('never rewrites a car', () => {
    expect(vehicles).not.toMatch(/UPDATE\s+(public\.)?cars/i);
  });
});
