import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The phase 5 screen harness: a real screen, inside the real AppLayout, on
 * invented data, with no Supabase anywhere.
 *
 * It exists so a screen moving onto the design system can be looked at before
 * and after — the check the plan asks of every phase 5 batch — on a machine
 * that cannot reach staging. `/design-preview` renders invented data too, but
 * only its own prototype pages; this renders the production components
 * themselves, unchanged, by swapping six modules underneath them:
 *
 *   src/lib/supabase.ts                  -> fakes/supabase.ts (an in-memory table store)
 *   src/contexts/AuthContext.tsx         -> fakes/AuthContext.tsx
 *   src/contexts/SuperAdminContext.tsx   -> fakes/SuperAdminContext.tsx
 *   src/contexts/PlanContext.tsx         -> fakes/PlanContext.tsx
 *   src/contexts/CompanySettingsContext.tsx -> fakes/CompanySettingsContext.tsx
 *   src/hooks/useCompanyScope.ts         -> fakes/useCompanyScope.ts
 *
 * Each fake re-exports its real module and replaces only the hook, so every
 * other export a screen imports is the real one. The swap happens here, at
 * module resolution, and nowhere in src/: the application build never sees it.
 *
 *   npm run harness            open http://localhost:5199/design-harness/?screen=fahrzeuge
 *   npm run harness:capture -- --set after
 *
 * The scenario is read from the query string; see scenario.ts.
 */

const root = resolve(__dirname, '..');
const normalize = (path: string) => path.replace(/\\/g, '/').split('?')[0].toLowerCase();

const FAKES: Record<string, string> = {
  'src/lib/supabase.ts': 'design-harness/fakes/supabase.ts',
  'src/contexts/AuthContext.tsx': 'design-harness/fakes/AuthContext.tsx',
  'src/contexts/SuperAdminContext.tsx': 'design-harness/fakes/SuperAdminContext.tsx',
  'src/contexts/PlanContext.tsx': 'design-harness/fakes/PlanContext.tsx',
  'src/contexts/CompanySettingsContext.tsx': 'design-harness/fakes/CompanySettingsContext.tsx',
  'src/hooks/useCompanyScope.ts': 'design-harness/fakes/useCompanyScope.ts',
};

function harnessFakes(): Plugin {
  const redirects = new Map(
    Object.entries(FAKES).map(([real, fake]) => [normalize(resolve(root, real)), resolve(root, fake)]),
  );
  const fakesDir = normalize(resolve(root, 'design-harness/fakes')) + '/';

  return {
    name: 'design-harness-fakes',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // A fake imports its real module to re-export it; that one import must
      // reach the real file.
      if (!importer || normalize(importer).startsWith(fakesDir)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      return redirects.get(normalize(resolved.id)) ?? null;
    },
  };
}

export default defineConfig({
  root,
  plugins: [harnessFakes(), react()],
  define: {
    // App.tsx is not part of the harness, but keep the flag defined for any
    // module that reads it.
    __DESIGN_PREVIEW__: 'false',
  },
  server: {
    // The next free port when 5199 is taken; capture.mjs asks the server
    // which one it got.
    port: 5199,
    strictPort: false,
    open: false,
    // A worktree may link node_modules to another checkout's (a directory
    // junction). Vite resolves a file to its real path, so the self-hosted
    // Barlow fonts would be refused as outside the root; allow that path too.
    fs: { allow: [root, realpathSync(resolve(root, 'node_modules'))] },
  },
  optimizeDeps: {
    entries: ['design-harness/index.html'],
    exclude: ['lucide-react'],
  },
});
