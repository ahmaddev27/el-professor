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
 * One reading did come in at 49 s, in dateFnsShim.test.ts, and it is recorded
 * here for the reason the plan-cache note in CLAUDE.md gives: **a reading of it
 * has now been wrong twice, and the pattern is more useful than a third guess.**
 * It was first written up as a cold file cache, which was wrong. It was then
 * written up as Vite transforming a bare absolute path instead of externalizing
 * it, together with the prediction that the bare path would fail on Linux — and
 * CI then ran the bare path green twice, at 2433 ms, so that was wrong too.
 * What is measured, and all that is measured:
 *
 *   Windows (dev box)   bare path 12-25 s, once 49 s   file:// 2.0-2.5 s
 *   Linux (CI)          bare path 2433 ms              file:// 2470 ms
 *
 * So the slowness is real, Windows-only, and **unexplained**; the `file://` form
 * is kept because it is portable and fast everywhere, not because the mechanism
 * is understood. Do not write a third confident paragraph here. What the episode
 * does establish is the repository's own standing lesson: the first attempt at
 * this number measured the instrument rather than the package, twice over.
 *
 * None of it touches the claim the alias rests on, which is two full runs of the
 * same suite in the same window; neither side ever imports a barrel by path. See
 * vitest.config.ts.
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
