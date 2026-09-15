/**
 * Whether the dev server or a build includes the design preview at
 * /design-preview.
 *
 * Off whenever VITE_DEPLOY_ENV names production. A build additionally needs the
 * variable to name another environment: staging sets "staging", and production
 * builds leave it unset (deploy.yml refuses any other value there). For a build
 * an unset or blank value therefore counts as production, so a forgotten
 * variable hides the preview instead of shipping it. The dev server never
 * serves production, so there an unset value means "show it".
 *
 * vite.config.ts turns the answer into the __DESIGN_PREVIEW__ constant, which
 * lets the bundler drop the preview's lazy import from App.tsx entirely.
 */
export function designPreviewEnabled(command: 'build' | 'serve', deployEnv: string | undefined): boolean {
  const environment = (deployEnv ?? '').trim().toLowerCase();
  if (environment === 'production') return false;
  return command === 'serve' || environment !== '';
}
