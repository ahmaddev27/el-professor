import { startOfMonth, endOfMonth, eachDayOfInterval, getDay, format, addDays, startOfWeek, endOfWeek, getMonth, getYear } from 'date-fns';

export interface WeekOfMonth {
  weekNumber: number;
  label: string;
  firstDay: Date;
  lastDay: Date;
}

export interface BusinessMonthYear {
  month: number;
  year: number;
}

/**
 * BUSINESS CALENDAR CORE FUNCTIONS
 *
 * Core Rule: A week belongs to the month where its MONDAY is.
 * - Weeks run Monday to Sunday and are never split
 * - A business month contains all weeks whose Monday falls in that calendar month
 * - If a date is in April but its week's Monday was in March, it belongs to March
 */

/**
 * Get the Monday of the week for any given date
 * @param date Any date
 * @returns The Monday of that week
 */
export function getWeekMonday(date: Date): Date {
  return startOfWeek(date, { weekStartsOn: 1 });
}

/**
 * Get the full week range (Monday to Sunday) for any given date
 * @param date Any date
 * @returns Object with monday and sunday dates
 */
export function getBusinessWeekRange(date: Date): { monday: Date; sunday: Date } {
  const monday = getWeekMonday(date);
  const sunday = endOfWeek(date, { weekStartsOn: 1 });
  return { monday, sunday };
}

/**
 * Get the business month and year for a date
 * Business month is determined by the week's Monday
 * @param date Any date
 * @returns Object with month (0-11) and year
 */
export function getBusinessMonth(date: Date): BusinessMonthYear {
  const monday = getWeekMonday(date);
  return {
    month: getMonth(monday),
    year: getYear(monday)
  };
}

/**
 * Get all business weeks for a given month/year
 * Returns all weeks whose Monday falls within that calendar month
 * @param month Month (0-11)
 * @param year Year
 * @returns Array of weeks with their Monday-Sunday ranges
 */
export function getBusinessWeeksForMonth(month: number, year: number): WeekOfMonth[] {
  const monthStart = new Date(year, month, 1);
  const monthEnd = endOfMonth(monthStart);

  const allDays = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const mondays = allDays.filter(day => getDay(day) === 1);

  if (mondays.length === 0) {
    return [{
      weekNumber: 1,
      label: 'Woche 1',
      firstDay: monthStart,
      lastDay: monthEnd
    }];
  }

  const weeks: WeekOfMonth[] = mondays.map((monday, index) => {
    const sunday = addDays(monday, 6);

    return {
      weekNumber: index + 1,
      label: `Woche ${index + 1} (${format(monday, 'dd.MM')} - ${format(sunday, 'dd.MM')})`,
      firstDay: monday,
      lastDay: sunday
    };
  });

  return weeks;
}

/**
 * Get all business weeks for a given date's month
 * Uses the business month of the date (based on its week's Monday)
 * @param date Any date
 * @returns Array of weeks for that business month
 */
export function getWeeksOfMonth(date: Date): WeekOfMonth[] {
  const businessMonth = getBusinessMonth(date);
  return getBusinessWeeksForMonth(businessMonth.month, businessMonth.year);
}

/**
 * Get the week number within the business month for a given date
 * @param date Any date
 * @returns Week number (1-based) within the business month
 */
export function getWeekNumberForDate(date: Date): number {
  const businessMonth = getBusinessMonth(date);
  const weeks = getBusinessWeeksForMonth(businessMonth.month, businessMonth.year);
  const monday = getWeekMonday(date);

  for (const week of weeks) {
    if (monday.getTime() === week.firstDay.getTime()) {
      return week.weekNumber;
    }
  }

  return 1;
}

/**
 * Get ISO week number for a date
 * @param date Any date
 * @returns Object with week number and year
 */
export function getWeekNumber(date: Date): { week: number; year: number } {
  const target = new Date(date.valueOf());
  const dayNr = (date.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  const week = 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
  return { week, year: target.getFullYear() };
}

/**
 * Check if a date belongs to a specific business month
 * @param date Date to check
 * @param month Month (0-11)
 * @param year Year
 * @returns true if the date's week belongs to the specified business month
 */
export function isDateInBusinessMonth(date: Date, month: number, year: number): boolean {
  const businessMonth = getBusinessMonth(date);
  return businessMonth.month === month && businessMonth.year === year;
}

/**
 * Get the date range for a business month (earliest Monday to latest Sunday)
 * @param month Month (0-11)
 * @param year Year
 * @returns Object with start and end dates
 */
export function getBusinessMonthRange(month: number, year: number): { start: Date; end: Date } {
  const weeks = getBusinessWeeksForMonth(month, year);

  if (weeks.length === 0) {
    const monthStart = new Date(year, month, 1);
    const monthEnd = endOfMonth(monthStart);
    return { start: monthStart, end: monthEnd };
  }

  return {
    start: weeks[0].firstDay,
    end: weeks[weeks.length - 1].lastDay
  };
}
