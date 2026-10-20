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
