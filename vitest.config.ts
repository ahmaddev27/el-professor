import { defineConfig } from 'vitest/config';

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
  test: {
    // The edge functions' pure modules (_shared/otp-core.ts, smtp-core.ts, the
    // mail layout and its copy) use only web-standard APIs, so Node runs them
    // unchanged. Anything that touches Deno is kept out of those files.
    include: ['src/**/*.test.ts', 'supabase/functions/_shared/**/*.test.ts'],
    environment: 'node',
  },
});
