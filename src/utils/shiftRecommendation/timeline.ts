/**
 * Where an instant falls: its slot, its operating day and its day type.
 *
 * ## Why slots are cut in UTC and named in local time
 *
 * Europe/Berlin is always a whole number of hours off UTC, and every supported
 * slot length divides an hour, so every local slot boundary is also a multiple
 * of the slot length in epoch milliseconds — on the two DST days as well. That
 * lets the history be walked in absolute time, which is exact, with each slot
 * *named* by its local wall clock. On the night the clocks go back, local 02:00
 * to 03:00 happens twice and both occurrences land in the same named slots,
 * which is right for a pattern ("what does 02:15 on a Sunday earn"); on the
 * night they go forward those slots simply do not occur.
 *
 * The local zone is the runtime's, as everywhere in this product
 * (`localDayWindow.ts`); vitest pins it to Europe/Berlin.
 */
import { localDateKey } from '../localDayWindow';
import type { DayType, LocalMoment } from './types';

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 'YYYY-MM-DD' shifted by whole calendar days, without a clock or a zone. */
export function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return `${moved.getUTCFullYear()}-${pad2(moved.getUTCMonth() + 1)}-${pad2(moved.getUTCDate())}`;
}

/** Monday 0 … Sunday 6; a holiday is a Sunday. */
export function dayTypeOf(dateKey: string, holidays: ReadonlySet<string>): DayType {
  if (holidays.has(dateKey)) return 6;
  const [year, month, day] = dateKey.split('-').map(Number);
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) as DayType;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function dateKeyOf(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export interface SlotPlace {
  /** The operating day the slot belongs to. */
  readonly operatingDate: string;
  /** 0-based slot within that operating day. */
  readonly position: number;
}

export class SlotClock {
  readonly slotMinutes: number;
  readonly slotMs: number;
  readonly positions: number;
  private readonly dayStartMinute: number;

  constructor(slotMinutes: number, operatingDayStartHour: number) {
    this.slotMinutes = slotMinutes;
    this.slotMs = slotMinutes * MINUTE_MS;
    this.positions = DAY_MINUTES / slotMinutes;
    this.dayStartMinute = operatingDayStartHour * 60;
  }

  /** The start of the slot containing `ms`. */
  slotStart(ms: number): number {
    return Math.floor(ms / this.slotMs) * this.slotMs;
  }

  /** The operating day and position of the slot that starts at `slotStartMs`. */
  place(slotStartMs: number): SlotPlace {
    const local = new Date(slotStartMs);
    const minuteOfDay = local.getHours() * 60 + local.getMinutes();
    const date = localDateKey(slotStartMs);
    if (minuteOfDay < this.dayStartMinute) {
      return {
        operatingDate: addDays(date, -1),
        position: Math.floor((minuteOfDay + DAY_MINUTES - this.dayStartMinute) / this.slotMinutes),
      };
    }
    return { operatingDate: date, position: Math.floor((minuteOfDay - this.dayStartMinute) / this.slotMinutes) };
  }

  /** The wall-clock moment a position boundary names; `position` may be `positions` (the day's end). */
  moment(operatingDate: string, position: number): LocalMoment {
    const minute = this.dayStartMinute + position * this.slotMinutes;
    const dayOffset = Math.floor(minute / DAY_MINUTES);
    const inDay = minute - dayOffset * DAY_MINUTES;
    return {
      date: addDays(operatingDate, dayOffset),
      time: `${pad2(Math.floor(inDay / 60))}:${pad2(inDay % 60)}`,
    };
  }
}
