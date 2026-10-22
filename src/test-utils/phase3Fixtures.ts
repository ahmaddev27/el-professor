import type { Phase1VehicleBlock } from '../utils/monatsplanungPhase1';
import type { StructuredNote } from '../utils/monatsplanungPhase3';
import type { PlanningDriver } from '../components/MonatsplanungDriverPool';

/**
 * The smallest Phase 1 block, Phase 3 driver and structured note that Phase 3's
 * tests can ask a question about. Dates are local wall clock, which is what Phase 1
 * builds and what vitest.config.ts pins to Europe/Berlin.
 *
 * monatsplanungPhase3.windows.test.ts predates this file and keeps copies of its own
 * (its driver has a night Dienstzeit and its block takes a vehicle); it can move over
 * the next time that file is touched for another reason.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const isoLocal = (dt: Date) =>
  `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;

/** A one-trip block as Phase 1 builds one; an end at or before the start runs into the next day. */
export function block(id: string, date: string, startHHMM: string, endHHMM: string): Phase1VehicleBlock {
  const [y, mo, d] = date.split('-').map(Number);
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  const start = new Date(y, mo - 1, d, sh, sm);
  let end = new Date(y, mo - 1, d, eh, em);
  if (end.getTime() <= start.getTime()) end = new Date(y, mo - 1, d + 1, eh, em);
  return {
    block_id: id,
    vehicle_id: 'V1',
    vehicle_identifier: 'V1-AB-123',
    service_date: date,
    block_start_datetime: isoLocal(start),
    block_end_datetime: isoLocal(end),
    duration_minutes: Math.round((end.getTime() - start.getTime()) / 60_000),
    trip_ids: [`${id}-t1`],
    trip_count: 1,
    first_trip_id: `${id}-t1`,
    last_trip_id: `${id}-t1`,
    first_excel_row: 1,
    last_excel_row: 1,
    trip_rows: [{ trip_id: `${id}-t1`, excel_row: 1, start_datetime: isoLocal(start), end_datetime: isoLocal(end) }],
    split_reason: 'gap_gt_60',
    internal_gaps: [],
    longest_internal_gap_minutes: 0,
    merge_status: 'none',
    actual_start_ms: start.getTime(),
    actual_end_ms: end.getTime(),
  };
}

/** No Dienstzeit and no weekday rule, so a note is the only thing that can refuse a block. */
export function driver(over: Partial<PlanningDriver> = {}): PlanningDriver {
  return {
    id: 'D1',
    name: 'Fahrer Eins',
    driver_usage_type: 'regular',
    planning_enabled: true,
    status: 'active',
    work_window_start: null,
    work_window_end: null,
    allowed_weekdays: null,
    max_daily_hours: 10,
    target_monthly_hours: 160,
    max_monthly_hours: 300,
    planning_target_salary: null,
    planning_min_salary: null,
    planning_max_salary: null,
    planning_hourly_rate: null,
    notes: null,
    is_full_day_available: true,
    employment_type: 'employee',
    ...over,
  };
}

/** A full-day `exclude_from_plan` note on Friday 22.05.2026; each test overrides what it needs. */
export function note(over: Partial<StructuredNote> = {}): StructuredNote {
  return {
    id: 'N1',
    driver_id: 'D1',
    note_type: 'sick',
    note_text: '',
    note_planning_behavior: 'exclude_from_plan',
    is_full_day: true,
    start_date: '2026-05-22',
    end_date: '2026-05-22',
    note_date: null,
    start_time: null,
    end_time: null,
    ...over,
  };
}
