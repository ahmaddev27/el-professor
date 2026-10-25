import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const support = (file: string) => fileURLToPath(new URL(`./tests/support/${file}`, import.meta.url));

// The payroll code reads local time throughout — computeLohnartSeconds walks
// calendar days with `new Date(y, m, d)`, and the business-week rule is defined
// on local Mondays. A run in another timezone would classify night, Sunday and
// holiday hours differently, so the golden masters are only meaningful pinned to
// the zone the product actually runs in.
//
// Set here rather than in the npm script so it applies on Windows too, before
// any module evaluates a Date.
process.env.TZ = 'Europe/Berlin';

export default defineConfig({
  // Test-only, and test-only by construction rather than by intention: `vite
  // build` and `vite serve` both resolve `vite.config.ts`, and Vite's config
  // loader has no knowledge of this file's name — only vitest looks for
  // `vitest.config` first and `vite.config` second. So nothing here can reach a
  // production bundle, and the shipped bundle still imports the real barrel.
  //
  // Why `date-fns` is aliased at all: `import { format } from 'date-fns'` pulls
  // the whole barrel, 250 exports over the package's 1426 `.js` files, once per
  // worker process. Measured here inside vitest: the barrel costs 969 ms against
  // 4 ms for `date-fns/format`, and `date-fns/locale` 1289 ms against 5 ms for
  // `date-fns/locale/de`. The product uses 20 names and one locale, and the two
  // shims re-export exactly those from the package's own subpaths — the same
  // function objects, proven by reference equality in dateFnsShim.test.ts.
  //
  // What that is worth, measured 24.10.2026 on this 8-core box, same window,
  // identical counts (281 files, 6118 tests) on both sides:
  //
  //   full suite, machine idle      273.8 s / 243.8 s  ->  197.3 s / 211.5 s
  //   full suite, two gates at once 711.9 s / 722.3 s  ->  414.0 s / 425.6 s
  //
  // Idle, both sides pass — on this box the suite is green idle either way, so
  // the starvation other branches have reported is a property of the machine's
  // state and not of the tree. Under two concurrent gates the un-aliased side
  // fails both times, in two different files, and only the first is this alias's
  // business:
  //
  //   monthlyPlanDocumentBuilders.test.ts  exceeds the 30 s timeouts written into
  //     its own two heaviest tests, which lazily `await import()` the PDF and
  //     XLSX builders and so pay the barrel inside the test body. Aliased, that
  //     file runs in 8.2 s and 15.6 s under the same load. This one is fixed.
  //
  //   tests/deploy/google-signin-guards.test.ts  starves on the bash subprocesses
  //     it spawns per test. It imports no date-fns, and the alias is measured not
  //     to move it: 157 s / 175 s / 142 s idle un-aliased against 152 s / 152 s
  //     idle aliased, a difference inside its own spread. It passed under two
  //     gates aliased (372 s, 403 s) only because less total work was competing.
  //     That is a side effect, not a fix, and a third gate would likely undo it.
  //
  // So the supportable claim is "this removes one known starvation failure and
  // makes the suite cheaper", not "the suite is now reliable under load". The
  // standing rule — a local red build may be starvation, and parallel gates
  // belong capped at two — is unchanged.
  //
  // `collect` is where the saving lands, which is the phase a module alias can
  // touch: 655.7 s / 544.0 s against 234.1 s / 374.3 s on the idle pair.
  //
  // The `find` values MUST stay regular expressions anchored at both ends. A
  // string `find` is matched by @rollup/plugin-alias as `importee === find ||
  // importee.startsWith(find + '/')`, so a string `'date-fns'` also captures
  // `'date-fns/addDays'` — including the shims' own subpath imports, which then
  // resolve against the shim's path and the run dies with `Cannot find module
  // 'date-fns/addDays' imported from tests/support/date-fns-shim.ts`.
  resolve: {
    alias: [
      { find: /^date-fns$/, replacement: support('date-fns-shim.ts') },
      { find: /^date-fns\/locale$/, replacement: support('date-fns-locale-shim.ts') },
    ],
  },
  test: {
    // The edge functions' pure modules (_shared/otp-core.ts, smtp-core.ts,
    // oauth-account-core.ts, the mail layout and its copy) use only web-standard
    // APIs, so Node runs them unchanged. Anything that touches Deno is kept out
    // of those files. tests/deploy pins the compose and Kong settings that keep
    // account creation closed, and runs deploy.sh's sign-in guards.
    // scripts/ holds the build gates' own rules (the style ratchet's counter).
    include: [
      'src/**/*.test.ts',
      'supabase/functions/_shared/**/*.test.ts',
      'tests/deploy/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
  },
});
