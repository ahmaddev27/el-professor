import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapDriverRow, type DriverRow } from './driverRow';

const row = (over: Partial<DriverRow> = {}): DriverRow => ({
  id: 'd1',
  name: 'Erika Mustermann',
  salary_ratio: 0.5,
  ...over,
});

describe('mapDriverRow', () => {
  it('keeps an Inhaber an Inhaber, so the edit form does not save them as an employee', () => {
    expect(mapDriverRow(row({ employment_type: 'company_owner' })).employment_type).toBe('company_owner');
  });

  it('reads an employee as an employee', () => {
    expect(mapDriverRow(row({ employment_type: 'employee' })).employment_type).toBe('employee');
  });

  it('treats a row without the column as an employee, as the database default does', () => {
    expect(mapDriverRow(row()).employment_type).toBe('employee');
    expect(mapDriverRow(row({ employment_type: null })).employment_type).toBe('employee');
  });

  it('keeps every field the list read carried before, with the same defaults', () => {
    expect(mapDriverRow(row())).toEqual({
      id: 'd1',
      name: 'Erika Mustermann',
      salary_ratio: 0.5,
      salaryRatio: 0.5,
      createdBy: undefined,
      createdAt: undefined,
      status: 'active',
      personalnummer: undefined,
      gender: null,
      employment_type: 'employee',
      driver_usage_type: 'regular',
      // The two monthly-hours columns are gone from the mapping: the plan works
      // from salaries since 01.10.2026 and nothing reads them. The assertion is
      // exact (`toEqual`), so their absence here is what pins the removal — if
      // one came back, this test would fail and say so.
      planning_target_salary: null,
      planning_min_salary: null,
      planning_max_salary: null,
      planning_hourly_rate: null,
      planning_priority: 100,
      planning_enabled: true,
      can_cover_other_drivers: true,
      allowed_weekdays: null,
      work_window_start: null,
      work_window_end: null,
      allow_outside_shift_exceptions: false,
      is_full_day_available: false,
    });
  });

  it('carries created_at, which the Fahrer export prints as "Erstellt am"', () => {
    expect(mapDriverRow(row({ created_at: '2026-09-29T08:30:00Z' })).createdAt)
      .toBe('2026-09-29T08:30:00Z');
  });
});

/**
 * The Fahrer export's rows are the objects `mapDriverRow` builds, and
 * `exportTableToExcel` reads each column as `dataRow[col.key]`. A key the
 * mapper does not emit therefore exports a blank cell for every driver, in
 * every company, for ever — with nothing thrown and nothing logged, because
 * `ExportColumn.key` is a bare `string` and the call site casts its rows to
 * `Record<string, unknown>`. That is how the `createdAt` column shipped blank.
 *
 * This reads the keys out of the screen rather than importing it, so the check
 * needs no renderer and none of the five contexts `DriversManagement` pulls in.
 * The same shape catches the next missing column for free.
 */
describe('the Fahrer export declares no column the mapper cannot fill', () => {
  const source = readFileSync(
    new URL('../components/DriversManagement.tsx', import.meta.url),
    'utf8',
  );

  /** The `key: '…'` literals of the `columns: [ … ]` array inside handleExport. */
  const declaredKeys = (): string[] => {
    const start = source.indexOf('columns: [');
    const end   = source.indexOf('rows:', start);
    if (start === -1 || end === -1 || end <= start) return [];
    return [...source.slice(start, end).matchAll(/\bkey:\s*'([^']+)'/g)].map(m => m[1]);
  };

  it('finds the column list at all, so a restructured screen cannot pass by silence', () => {
    // A negative control: without this, deleting the export would make the
    // assertion below vacuously true.
    expect(declaredKeys().length).toBeGreaterThanOrEqual(20);
    expect(declaredKeys()).toContain('name');
  });

  it('emits every key the export declares', () => {
    const emitted = Object.keys(mapDriverRow(row()));
    const missing = declaredKeys().filter(key => !emitted.includes(key));
    expect(missing).toEqual([]);
  });
});
