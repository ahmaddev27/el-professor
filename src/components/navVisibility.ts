/**
 * Which navigation entries an environment shows.
 *
 * The owner, 04.10.2026: hide the Monatsplan from the sidebar until it is agreed
 * — said while asking for a production release. Hiding it everywhere would also
 * have hidden it from **staging**, which is the one place he is still testing it,
 * so the rule is per environment rather than absolute.
 *
 * The shape deliberately mirrors `designPreviewEnabled`, which decides the same
 * kind of question for `/design-preview` and has been in the build for a while:
 * production builds leave `VITE_DEPLOY_ENV` unset, so for a build an unset or
 * blank value counts as production and a forgotten variable **hides** the entry
 * rather than shipping it. A dev server never serves production, so there an
 * unset value means "show it".
 *
 * This hides a link, nothing else. The route stays registered in `App.tsx` behind
 * its plan gate, so `/monatsplan` is reachable by address in every environment —
 * which is what lets the feature be used and tested while it is not advertised.
 */
function shownOutsideProduction(deployEnv: string | undefined, isDev: boolean): boolean {
  const environment = (deployEnv ?? '').trim().toLowerCase();
  if (environment === 'production') return false;
  return isDev || environment !== '';
}

export function monthlyPlanInNav(deployEnv: string | undefined, isDev: boolean): boolean {
  return shownOutsideProduction(deployEnv, isDev);
}

/**
 * Whether a link to the Fahrtenanalyse is offered.
 *
 * The owner's decision of 23.09.2026, restated on 04.10.2026 when he was asked
 * before the release: the Fahrtenbuch analysis stays on staging. **It is not the
 * Fahrtenbuch** — that is `/fahrtenbuch`, it is on production, and nothing here
 * touches it. This hides two links to a separate read-only screen that explains
 * an imported month and changes no trip.
 *
 * Same rule as the Monatsplan, deliberately: two screens hidden by one tested
 * function, rather than two rules that could drift apart.
 */
export function tripAnalysisLinkShown(deployEnv: string | undefined, isDev: boolean): boolean {
  return shownOutsideProduction(deployEnv, isDev);
}

/**
 * Whether the entry to the simulated-ride generator is offered.
 *
 * The generator writes **invented rides into the statutory ride log** — the trip
 * table itself, which this file deliberately does not name: `readers.test.ts`
 * inventories every file under `src/` whose text carries that table's name, and
 * this one reads no table at all, so naming it here would record a reader that
 * does not exist. Every invented ride is permanently marked SIMULIERT — in the database,
 * in the trip list and in any Fahrtenbuch file built from them — so this is a
 * marked document rather than a laundered one. But a Stundennachweis, the
 * Lohnart premiums and the planning all read the **times** of a trip, and those
 * times are invented; such a document reaches a Steuerberater. The owner has not
 * agreed to customers generating them, and until he does the safe default is
 * that the door is not advertised on production.
 *
 * Same rule as the Monatsplan and the Fahrtenanalyse — one `shownOutsideProduction`
 * behind every name, so none of the three can answer differently. It is a third
 * **name** and not a third rule, and the parity test in `navVisibility.test.ts`
 * is what holds that.
 *
 * It is a separate name from `tripAnalysisLinkShown` on purpose, because the two
 * are separate owner decisions that merely agree today. The Fahrtenanalyse is a
 * read-only screen that changes no trip; this generator writes. Sharing one name
 * would mean that the day the owner releases the read-only screen, flipping it
 * also unhides the write-capable generator — the coupling the wrong way round.
 *
 * This hides a link, nothing else. The route stays registered, the page stays
 * whole and the database keeps its own gate (`documents` edit right), so the
 * generator is reachable by address in every environment and fully usable on
 * staging, exactly as the Monatsplan is.
 */
export function simulatedRidesEntryShown(deployEnv: string | undefined, isDev: boolean): boolean {
  return shownOutsideProduction(deployEnv, isDev);
}
