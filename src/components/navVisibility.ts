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
export function monthlyPlanInNav(deployEnv: string | undefined, isDev: boolean): boolean {
  const environment = (deployEnv ?? '').trim().toLowerCase();
  if (environment === 'production') return false;
  return isDev || environment !== '';
}
