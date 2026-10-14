import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Replace deletes income rows, so the one statement that does it is read as
// text: a hand-typed row (source NULL) must stay out of its reach. The kit
// (tests/rls/income-import-uber.sql, section 7) proves the behaviour; this
// holds the shape where the kit cannot run on a developer machine.
const MIGRATION = path.resolve(__dirname, '../../supabase/migrations/20261014100000_income_import_uber_replace.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const body = sql.slice(sql.indexOf('CREATE FUNCTION public.income_import_uber'), sql.indexOf('COMMENT ON FUNCTION'));
const deleteStatement = /DELETE FROM public\.income[\s\S]*?;/.exec(body)?.[0] ?? '';

describe('income_import_uber replace: the delete', () => {
  it('is the only delete, gated by the flag and run before the insert', () => {
    expect(body.match(/DELETE FROM/g)).toHaveLength(1);
    expect(body.indexOf('IF p_replace THEN')).toBeGreaterThan(-1);
    expect(body.indexOf('DELETE FROM')).toBeLessThan(body.indexOf('INSERT INTO public.income'));
  });

  it('is keyed on the company, the source constant and the driver-week, all from the function', () => {
    for (const term of [
      'i.company_id = v_company',
      'i.source = c_source',
      'i.source_driver_key = k.driver_key',
      'i.source_period_start = k.period_start',
    ]) {
      expect(deleteStatement).toContain(term);
    }
  });

  it('is NOT keyed on the row type, although the unique index is', () => {
    // One pull writes one row per type per week, so a week's rows are one
    // artefact. Keyed on the type, a correction that DROPS a type -- tips fall
    // to zero, so the payload carries no `trinkgeld` row -- would leave the old
    // tip standing beside corrected figures, the overlap check would refuse the
    // whole call, and the operator would be stranded exactly where this mode is
    // meant to let him through. The migration's own self-check refuses it too.
    expect(deleteStatement).not.toContain('i.type');
  });

  it('resolves each driver key through a confirmed link of this company', () => {
    expect(deleteStatement).toContain('partner_driver_links');
    expect(deleteStatement).toContain("l.status = 'linked'");
    expect(deleteStatement).toContain('l.company_id = v_company');
  });

  it('cannot match a row with no source and never reads the source from the payload', () => {
    expect(deleteStatement).not.toMatch(/IS NULL/i);
    expect(deleteStatement).not.toMatch(/\sOR\s/i);
    expect(deleteStatement).not.toMatch(/coalesce/i);
    expect(deleteStatement).not.toContain("'source'");
  });

  it('appends the flag last and defaults it to false', () => {
    expect(body).toContain('p_rows jsonb, p_replace boolean DEFAULT false');
  });
});
