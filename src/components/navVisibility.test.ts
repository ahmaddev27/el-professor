import { describe, expect, it } from 'vitest';
import { monthlyPlanInNav, tripAnalysisLinkShown } from './navVisibility';

/**
 * The rule that keeps the Monatsplan out of production's sidebar while leaving it
 * in staging's, where the owner is still testing it.
 *
 * The cases mirror `buildFlag.test.ts`, because the two answer the same question
 * and a second rule that behaved differently would be the trap, not the safety.
 */
describe('monthlyPlanInNav', () => {
  it('is off for a build with no VITE_DEPLOY_ENV, which is how production builds', () => {
    // The one that matters: production leaves the variable unset, so a forgotten
    // variable must hide the entry rather than ship it.
    expect(monthlyPlanInNav(undefined, false)).toBe(false);
    expect(monthlyPlanInNav('', false)).toBe(false);
    expect(monthlyPlanInNav('   ', false)).toBe(false);
  });

  it('is off when the variable names production, whatever the case', () => {
    expect(monthlyPlanInNav('production', false)).toBe(false);
    expect(monthlyPlanInNav('Production', false)).toBe(false);
    expect(monthlyPlanInNav(' PRODUCTION ', false)).toBe(false);
    // And a dev server pointed at production still hides it.
    expect(monthlyPlanInNav('production', true)).toBe(false);
  });

  it('is on for staging, which is where it is still being tested', () => {
    expect(monthlyPlanInNav('staging', false)).toBe(true);
    expect(monthlyPlanInNav(' Staging ', false)).toBe(true);
  });

  it('is on for a dev server with no variable set', () => {
    // Otherwise working on the screen locally would mean editing the sidebar
    // first, which is how a temporary hide becomes permanent.
    expect(monthlyPlanInNav(undefined, true)).toBe(true);
  });
});

describe('tripAnalysisLinkShown', () => {
  // The owner's decision of 23.09.2026, restated before the release of
  // 04.10.2026: the Fahrtenbuch **analysis** stays on staging. It is not the
  // Fahrtenbuch itself, which is `/dokumente` and has been on production for
  // months — this hides two links to a separate read-only screen.
  it('is off for production and for a build with no variable set', () => {
    expect(tripAnalysisLinkShown('production', false)).toBe(false);
    expect(tripAnalysisLinkShown(undefined, false)).toBe(false);
    expect(tripAnalysisLinkShown('', false)).toBe(false);
  });

  it('is on for staging and for a dev server', () => {
    expect(tripAnalysisLinkShown('staging', false)).toBe(true);
    expect(tripAnalysisLinkShown(undefined, true)).toBe(true);
  });

  it('answers exactly as the Monatsplan does, so the two cannot drift apart', () => {
    // They are one rule behind two names on purpose. If they ever need to
    // differ, that is a decision to write down, not something to discover from a
    // screen behaving unlike its twin.
    for (const env of [undefined, '', '  ', 'production', 'Production', 'staging', 'other']) {
      for (const dev of [true, false]) {
        expect(tripAnalysisLinkShown(env, dev), `${String(env)} / dev=${dev}`)
          .toBe(monthlyPlanInNav(env, dev));
      }
    }
  });
});
