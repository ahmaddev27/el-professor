/**
 * Test-only stand-in for the `date-fns` barrel (see vitest.config.ts).
 *
 * `import { format } from 'date-fns'` makes Node load every one of the package's
 * ~1000 modules. Measured on the dev machine 21.10.2026: 19-65 s natively, 8-15 s
 * inside vitest, repeated in every worker, and it is what pushed
 * monthlyPlanDocumentBuilders.test.ts past its timeout under parallel load. The
 * subpaths below are the same functions from the same package; only the 19 the
 * product uses are loaded. dateFnsShim.test.ts fails when src/ starts using a
 * name that is not listed here.
 */
export { addDays } from 'date-fns/addDays';
export { addMonths } from 'date-fns/addMonths';
export { addYears } from 'date-fns/addYears';
export { differenceInDays } from 'date-fns/differenceInDays';
export { eachDayOfInterval } from 'date-fns/eachDayOfInterval';
export { endOfMonth } from 'date-fns/endOfMonth';
export { endOfWeek } from 'date-fns/endOfWeek';
export { endOfYear } from 'date-fns/endOfYear';
export { format } from 'date-fns/format';
export { getDay } from 'date-fns/getDay';
export { getDaysInMonth } from 'date-fns/getDaysInMonth';
export { getMonth } from 'date-fns/getMonth';
export { getYear } from 'date-fns/getYear';
export { isAfter } from 'date-fns/isAfter';
export { isWithinInterval } from 'date-fns/isWithinInterval';
export { parseISO } from 'date-fns/parseISO';
export { startOfMonth } from 'date-fns/startOfMonth';
export { startOfWeek } from 'date-fns/startOfWeek';
export { startOfYear } from 'date-fns/startOfYear';
export { subMonths } from 'date-fns/subMonths';
