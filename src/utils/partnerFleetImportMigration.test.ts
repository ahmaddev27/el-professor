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
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20261015100000_partner_fleet_import.sql'),
  'utf8',
);

/** The body of one function, from its CREATE to the closing dollar quote. */
function body(name: string): string {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const open = SQL.indexOf('AS $$', start);
  return SQL.slice(open, SQL.indexOf('$$;', open + 5));
}

describe('partner_drivers_import', () => {
  const drivers = body('partner_drivers_import');

  it('looks an existing driver up by the normalised name inside the company', () => {
    // Anchored on what follows: a name compared with anything but the bare key
    // would find nobody, and the import would create everyone.
    expect(drivers).toMatch(
      /d\.company_id = v_company AND lower\(btrim\(d\.name\)\) = v_key\s*\n\s*AND NOT EXISTS/,
    );
    expect(drivers).toMatch(
      /d\.company_id = v_company AND lower\(btrim\(d\.name\)\) = v_key\s*\n\s*\) THEN/,
    );
  });

  it('links to the found driver and only creates when none was found', () => {
    const lookup = drivers.indexOf('lower(btrim(d.name)) = v_key');
    const create = drivers.indexOf('INSERT INTO public.drivers');
    expect(lookup).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(lookup);
    expect(drivers).toMatch(/IF v_reason IS NULL AND v_driver IS NULL THEN\s+v_email/);
  });

  it('never writes an existing driver and never names a ruled-out column', () => {
    expect(drivers).not.toMatch(/UPDATE\s+(public\.)?drivers/i);
    expect(drivers).not.toMatch(/employment_type|salary_ratio|personalnummer/i);
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
