import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The phase-5 batch-4 harness: the sign-in and account screens, Benutzer,
 * Rollen, Einstellungen and Abonnement, on invented data, with no Supabase.
 *
 * Its own entry and its own fakes, beside the batch-1 harness rather than inside
 * it, because other batches are extending that one at the same time. The
 * mechanism is the same: modules are swapped at resolution, nothing in src/
 * knows, and the application build never sees any of it.
 *
 *   src/lib/supabase.ts                     -> fakes/supabase.ts
 *   src/contexts/AuthContext.tsx            -> fakes/AuthContext.tsx
 *   src/contexts/SuperAdminContext.tsx      -> fakes/SuperAdminContext.tsx
 *   src/contexts/PlanContext.tsx            -> fakes/PlanContext.tsx
 *   src/contexts/CompanySettingsContext.tsx -> fakes/CompanySettingsContext.tsx
 *   src/hooks/useOtpSessionHandoff.ts       -> fakes/useOtpSessionHandoff.ts
 *
 * The edge functions and GoTrue's settings route are answered by fakeFetch.ts,
 * which replaces window.fetch, so the fetch calls in the screens stay as they
 * ship.
 *
 *   npm run harness:batch4           open http://localhost:5199/design-harness/batch4/?screen=login
 *   npm run harness:batch4:capture -- --set after
 *   npm run harness:batch4:flows
 */

const root = resolve(__dirname, '../..');
const here = resolve(__dirname);
const normalize = (path: string) => path.replace(/\\/g, '/').split('?')[0].toLowerCase();

// The fetches in the screens start with this; fakeFetch.ts answers it. Without
// a URL the provider-settings read gives up before asking, and the Google
// button could never be shown.
process.env.VITE_SUPABASE_URL = 'https://harness.invalid';
process.env.VITE_SUPABASE_ANON_KEY = 'harness-anon-key';

const FAKES: Record<string, string> = {
  'src/lib/supabase.ts': 'fakes/supabase.ts',
  'src/contexts/AuthContext.tsx': 'fakes/AuthContext.tsx',
  'src/contexts/SuperAdminContext.tsx': 'fakes/SuperAdminContext.tsx',
  'src/contexts/PlanContext.tsx': 'fakes/PlanContext.tsx',
  'src/contexts/CompanySettingsContext.tsx': 'fakes/CompanySettingsContext.tsx',
  'src/hooks/useOtpSessionHandoff.ts': 'fakes/useOtpSessionHandoff.ts',
};

function harnessFakes(): Plugin {
  const redirects = new Map(
    Object.entries(FAKES).map(([real, fake]) => [normalize(resolve(root, real)), resolve(here, fake)]),
  );
  const fakesDir = normalize(resolve(here, 'fakes')) + '/';

  return {
    name: 'design-harness-batch4-fakes',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // A fake imports its real module to re-export it; that one import must
      // reach the real file.
      if (!importer || normalize(importer).startsWith(fakesDir)) return null;
      // So must the browser's request for it. A URL is resolved with Vite's
      // default importer, the root index.html, and the only URL that names a
      // real faked module is the one a fake's re-export was rewritten to —
      // every other importer was already sent to the fake's own URL. Redirected
      // here, the fake would re-export itself and lose every other export
      // (BLOCK_MESSAGE_KEYS first), depending on which request came first.
      if (normalize(importer).endsWith('/index.html')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      return redirects.get(normalize(resolved.id)) ?? null;
    },
  };
}

/**
 * The staging banner reads VITE_DEPLOY_ENV once, when its module loads, so the
 * scenario cannot switch it with a prop. This plugin rewrites that one read in
 * EnvironmentBanner.tsx to a global index.html sets from `?env=staging`; every
 * other module keeps Vite's own value.
 */
function deployEnvFromScenario(): Plugin {
  const banner = normalize(resolve(root, 'src/components/EnvironmentBanner.tsx'));
  return {
    name: 'design-harness-batch4-deploy-env',
    enforce: 'pre',
    transform(code, id) {
      if (normalize(id) !== banner) return null;
      return code.replace('import.meta.env.VITE_DEPLOY_ENV', 'globalThis.__HARNESS_DEPLOY_ENV__');
    },
  };
}

export default defineConfig({
  root,
  plugins: [harnessFakes(), deployEnvFromScenario(), react()],
  // Not the shared node_modules/.vite: other checkouts share that folder
  // through a junction, and two harnesses must not rebuild each other's cache.
  cacheDir: resolve(tmpdir(), 'el-professor-harness-batch4'),
  define: {
    __DESIGN_PREVIEW__: 'false',
  },
  server: {
    port: 5199,
    strictPort: false,
    open: false,
  },
  optimizeDeps: {
    entries: ['design-harness/batch4/index.html'],
    // Pre-bundled here, unlike in the app's own config: unbundled, lucide's
    // ESM entry is some 1,500 modules, and every cold page load of this
    // harness waited over a minute for them. Bundling changes no icon.
    include: ['lucide-react'],
  },
});
