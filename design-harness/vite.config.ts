import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, searchForWorkspaceRoot, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The phase 5 screen harness: a real screen, inside the real AppLayout, on
 * invented data, with no Supabase anywhere.
 *
 * It exists so a screen moving onto the design system can be looked at before
 * and after — the check the plan asks of every phase 5 batch — on a machine
 * that cannot reach staging. `/design-preview` renders invented data too, but
 * only its own prototype pages; this renders the production components
 * themselves, unchanged, by swapping eight modules underneath them:
 *
 *   src/lib/supabase.ts                  -> fakes/supabase.ts (an in-memory table store)
 *   src/contexts/AuthContext.tsx         -> fakes/AuthContext.tsx
 *   src/contexts/SuperAdminContext.tsx   -> fakes/SuperAdminContext.tsx
 *   src/contexts/PlanContext.tsx         -> fakes/PlanContext.tsx
 *   src/contexts/CompanySettingsContext.tsx -> fakes/CompanySettingsContext.tsx
 *   src/hooks/useCompanyScope.ts         -> fakes/useCompanyScope.ts
 *   src/utils/germanPostalCodes.ts       -> fakes/germanPostalCodes.ts (no request to a postcode API)
 *   src/utils/receiptOcr.ts              -> fakes/receiptOcr.ts (a scripted OCR answer, no Tesseract)
 *
 * Each fake re-exports its real module and replaces only what it must, so
 * every other export a screen imports is the real one. The swap happens here,
 * at module resolution, and nowhere in src/: the application build never sees
 * it.
 *
 * The `view` and `billing` roles open the company as a platform read context
 * (fakes/SuperAdminContext.tsx); fakes/useCompanyScope.ts then refuses every
 * write, as the real hook's scopedWriteRights does.
 *
 *   npm run harness            open http://localhost:5199/design-harness/?screen=fahrzeuge
 *   npm run harness:capture -- --set after
 *
 * The scenario is read from the query string; see scenario.ts.
 */

const root = resolve(__dirname, '..');
const normalize = (path: string) => path.replace(/\\/g, '/').split('?')[0].toLowerCase();

/**
 * The harness's own dependency cache, one per checkout.
 *
 * A worktree's node_modules is a junction to the main checkout's, so Vite's
 * default cache, node_modules/.vite, is ONE directory for every harness running
 * on the machine at once. Vite hashes the root into its config hash, so each
 * worktree's server finds the others' cache stale, re-optimizes, and replaces
 * the directory under the servers already running: their pages then ask for
 * chunk files that are gone or changed, and a capture stalls on its first page
 * or dies with a module-link error ("does not provide an export named …").
 * A directory keyed by the checkout ends that.
 */
const cacheDir = resolve(root, 'node_modules', '.vite-harness', createHash('sha256').update(normalize(root)).digest('hex').slice(0, 12));

const FAKES: Record<string, string> = {
  'src/lib/supabase.ts': 'design-harness/fakes/supabase.ts',
  'src/contexts/AuthContext.tsx': 'design-harness/fakes/AuthContext.tsx',
  'src/contexts/SuperAdminContext.tsx': 'design-harness/fakes/SuperAdminContext.tsx',
  'src/contexts/PlanContext.tsx': 'design-harness/fakes/PlanContext.tsx',
  'src/contexts/CompanySettingsContext.tsx': 'design-harness/fakes/CompanySettingsContext.tsx',
  'src/hooks/useCompanyScope.ts': 'design-harness/fakes/useCompanyScope.ts',
  'src/utils/germanPostalCodes.ts': 'design-harness/fakes/germanPostalCodes.ts',
  'src/utils/receiptOcr.ts': 'design-harness/fakes/receiptOcr.ts',
};

function harnessFakes(): Plugin {
  const redirects = new Map(
    Object.entries(FAKES).map(([real, fake]) => [normalize(resolve(root, real)), resolve(root, fake)]),
  );
  const fakesDir = normalize(resolve(root, 'design-harness/fakes')) + '/';
  // What Vite's plugin container passes as the importer when it resolves a URL
  // the browser asked for, rather than an import written in a module.
  const urlRequestImporter = normalize(resolve(root, 'index.html'));

  return {
    name: 'design-harness-fakes',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // A fake imports its real module to re-export it; that one import must
      // reach the real file. It reaches the server twice: once while the fake
      // is transformed (importer: the fake), and once as the URL the browser
      // then fetches, `/src/utils/receiptOcr.ts`, which Vite resolves with
      // `<root>/index.html` as the importer. Redirecting that second one served
      // the fake under the real module's URL, so `export * from` the real
      // module re-exported the fake itself: every export the fake does not
      // redefine (formatAmountDE, isValidGermanPostalCode) was missing, the
      // module graph failed to link, and the harness never booted. A module's
      // own import of a real path is always redirected in the first pass, so
      // a URL request never needs it.
      if (!importer || normalize(importer).startsWith(fakesDir)) return null;
      if (normalize(importer) === urlRequestImporter) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      return redirects.get(normalize(resolved.id)) ?? null;
    },
  };
}

export default defineConfig({
  root,
  cacheDir,
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
    // Transform the whole screen graph while the server starts, not while the
    // first page waits for it: on a loaded machine that first page otherwise
    // outlasts every timeout (see capture.mjs, "warm up").
    warmup: { clientFiles: ['./design-harness/main.tsx'] },
    fs: {
      // A checkout whose node_modules is a junction to another one's (how
      // capture.mjs --root and a fresh worktree run) resolves the self-hosted
      // Barlow files outside its own root; without this Vite refuses them and
      // every shot falls back to the system font.
      allow: [searchForWorkspaceRoot(root), realpathSync(resolve(root, 'node_modules'))],
    },
  },
  optimizeDeps: {
    entries: ['design-harness/index.html'],
    // Pre-bundled here, unlike the app's own config: unbundled, lucide-react's
    // entry pulls some 1,500 icon modules (3,034 files with their maps), and
    // every screenshot opens a fresh browser context with an empty cache, so
    // each shot fetched them all again. The icons drawn are the same.
    include: ['lucide-react'],
  },
});
