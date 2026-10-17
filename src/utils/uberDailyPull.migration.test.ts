import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The system writer deletes income rows only on a recheck, and writes nothing
// that the human path would not. The kit (tests/rls/uber-daily-pull.sql) proves
// the behaviour; this holds the shape where the kit cannot run on a developer
// machine, the way incomeImportReplace.test.ts does for the button.
const MIGRATION = path.resolve(__dirname, '../../supabase/migrations/20261015130000_uber_daily_pull.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const from = sql.indexOf('CREATE OR REPLACE FUNCTION public.income_import_uber_system');
const body = sql.slice(from, sql.indexOf('COMMENT ON FUNCTION public.income_import_uber_system'));

describe('income_import_uber_system', () => {
  it('refuses a period that overlaps one already imported, so a day is not written twice', () => {
    const overlap = body.indexOf("i.source_period_start <= (e->>'period_end')::date");
    expect(overlap).toBeGreaterThan(-1);
    expect(body).toContain("HINT = 'already_imported'");
    // The check runs after the delete and before the insert, as in the human path.
    expect(overlap).toBeGreaterThan(body.indexOf('DELETE FROM'));
    expect(overlap).toBeLessThan(body.indexOf('INSERT INTO public.income'));
  });

  it('takes replace from the claim and never from an argument', () => {
    expect(body).toContain("v_replace := v_run.pass = 'recheck'");
    expect(body).not.toContain('p_replace');
    expect(body).toContain('IF v_replace THEN');
  });

  it('has one delete, keyed on the index columns and not on the type', () => {
    expect(body.match(/DELETE FROM/g)).toHaveLength(1);
    const del = /DELETE FROM public\.income[\s\S]*?;/.exec(body)?.[0] ?? '';
    for (const term of ['i.company_id = v_company', 'i.source = c_source',
      'i.source_driver_key = k.driver_key', 'i.source_period_start = k.period_start']) {
      expect(del).toContain(term);
    }
    expect(del).not.toContain('i.type');
    expect(del).not.toMatch(/\sOR\s|IS NULL|coalesce/i);
  });

  it('resolves the driver through a confirmed link and writes OUR name', () => {
    expect(body).toContain("l.status = 'linked'");
    expect(body).toContain('d.name,');
    expect(body).toContain("HINT = 'driver_not_linked'");
  });

  it('names no session and returns no message text', () => {
    expect(body).not.toContain('auth.uid()');
    expect(body).not.toContain('current_role_permits');
    expect(body).not.toContain('SQLERRM');
  });

  it('is granted to service_role alone', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.income_import_uber_system\(uuid, jsonb\)\s+FROM PUBLIC, anon, authenticated, service_role;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.income_import_uber_system\(uuid, jsonb\)\s+TO service_role;/);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.income_import_uber_system[^;]*authenticated/);
  });
});
