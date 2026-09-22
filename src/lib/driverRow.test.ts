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
      status: 'active',
      personalnummer: undefined,
      gender: null,
      employment_type: 'employee',
      driver_usage_type: 'regular',
      target_monthly_hours: null,
      max_monthly_hours: null,
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
});
