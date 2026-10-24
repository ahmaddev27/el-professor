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
 * This header previously claimed "~1000 modules" and "19-65 s natively, 8-15 s
 * inside vitest" for 19 names. The file count makes "~1000 modules" fair, the
 * names are 20 and not 19, and the timings could NOT be reproduced: repeated
 * runs put the barrel at about a second, not tens of seconds.
 *
 * One reading did come in at 49 s, and it is recorded here because the obvious
 * explanation for it was wrong. It was not a cold file cache. It was
 * dateFnsShim.test.ts importing the real barrel by a bare absolute path, which
 * Vite does not externalize, so all 250 of its modules went through the
 * transform pipeline; as a `file://` URL the same assertions cost 2.1 s. So that
 * figure measured the instrument, not the package — and "the first measurement
 * was 24x too high because the harness was transforming what it meant to time"
 * is the more useful thing for the next person to know than any reconciliation
 * of the original numbers, which stand unexplained.
 *
 * See vitest.config.ts for what the alias is worth on a full run, which is where
 * the claim actually rests.
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
