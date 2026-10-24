/**
 * Test-only stand-in for the `date-fns` barrel (see vitest.config.ts).
 *
 * `import { format } from 'date-fns'` pulls the whole barrel — 250 exports, out
 * of the package's 1426 `.js` files — and the cost is paid once per worker
 * process. Re-measured 24.10.2026 on the dev machine, date-fns 4.1.0:
 *
 *   inside vitest   barrel 969 ms   `date-fns/format` 4 ms
 *                   locale barrel 1289 ms   `date-fns/locale/de` 5 ms
 *   native node     barrel 1.07-1.45 s   the 20 subpaths together 0.19-0.38 s
 *                   both barrels 3.4-6.1 s   subpaths + locale/de 0.19-0.23 s
 *
 * The 20 subpaths below are the same functions from the same package — the same
 * objects, by reference, which dateFnsShim.test.ts asserts rather than assumes.
 * That test also fails when src/ starts using a name not listed here.
 *
 * Those are WARM numbers — the OS file cache already holding the package's 250
 * ESM files. Cold they are far worse, and that is the case the alias really
 * avoids, because with it nothing in the run opens those files at all:
 * dateFnsShim.test.ts, the one test that deliberately does load both barrels,
 * took 49 s in a run where nothing else had touched them and 12-25 s in runs
 * where something had.
 *
 * This header previously claimed "~1000 modules" and "19-65 s natively, 8-15 s
 * inside vitest" for 19 names. Two of the three were wrong and the third was
 * not: the file count is 1426 so "~1000 modules" is fair, the names are 20 and
 * not 19, and the timings disagree with the warm figures above by 5-20x — but
 * the 49 s cold reading suggests the original was measured on a cold cache
 * rather than being wrong, so it is corrected here as a cache-state difference
 * and not withdrawn as an error. The conclusion is unchanged either way; see
 * vitest.config.ts for what the alias is worth on a full run.
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
