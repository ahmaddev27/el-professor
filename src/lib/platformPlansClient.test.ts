import { describe, expect, it, vi } from 'vitest';
import { de } from '../i18n/de';
import { translate } from '../i18n';
import {
  derivedMinPlan,
  parseCatalogue,
  planProblemMessage,
  setPlanFeature,
  type PlanRow,
} from './platformPlansClient';

vi.mock('./supabase', () => ({ supabase: {} }));

const plan = (slug: string, rank: number, features: string[], is_active = true): PlanRow => ({
  slug, name: slug.toUpperCase(), rank, price_per_car_cents: 1000, features, is_active,
});

const PLANS = [
  plan('basic', 0, ['belege']),
  plan('advanced', 1, ['belege', 'fahrer']),
  plan('premium', 2, ['belege', 'fahrer', 'gehaelter']),
];

describe('derivedMinPlan', () => {
  it('names the lowest-rank plan granting the feature', () => {
    expect(derivedMinPlan(PLANS, 'belege')).toBe('basic');
    expect(derivedMinPlan(PLANS, 'fahrer')).toBe('advanced');
    expect(derivedMinPlan(PLANS, 'gehaelter')).toBe('premium');
  });

  it('is independent of the array order', () => {
    expect(derivedMinPlan([...PLANS].reverse(), 'fahrer')).toBe('advanced');
  });

  it('ignores inactive plans and answers null when nobody grants it', () => {
    const inactiveAdvanced = [PLANS[0], { ...PLANS[1], is_active: false }, PLANS[2]];
    expect(derivedMinPlan(inactiveAdvanced, 'fahrer')).toBe('premium');
    expect(derivedMinPlan(PLANS, 'unknown_key')).toBeNull();
  });
});

describe('setPlanFeature', () => {
  it('ticking a feature on a plan ticks it on every higher plan only', () => {
    const next = setPlanFeature(PLANS, 'advanced', 'werkstatt', true);
    expect(next.map(p => p.features.includes('werkstatt'))).toEqual([false, true, true]);
  });

  it('unticking removes it from every lower plan too', () => {
    const next = setPlanFeature(PLANS, 'advanced', 'belege', false);
    expect(next.map(p => p.features.includes('belege'))).toEqual([false, false, true]);
  });
});

describe('parseCatalogue', () => {
  const answer = { ok: true, plans: PLANS, version: 3, fixed_slugs: ['basic'], feature_keys: ['belege'] };

  it('reads the documented shape', () => {
    expect(parseCatalogue(answer).version).toBe(3);
  });

  it('refuses a refusal, an empty list and a fractional price instead of inventing a catalogue', () => {
    expect(() => parseCatalogue({ ok: false, reason: 'denied' })).toThrow();
    expect(() => parseCatalogue({ ...answer, plans: [] })).toThrow();
    expect(() => parseCatalogue({ ...answer, plans: [{ ...PLANS[0], price_per_car_cents: 12.5 }] })).toThrow();
  });
});

describe('planProblemMessage', () => {
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
    translate('de', key, vars);
  const labels = { plan: (s: string) => `P:${s}`, feature: (k: string) => `F:${k}` };

  it('names the plan and the feature of a monotonicity violation', () => {
    const message = planProblemMessage('plans.monotonicity.basic.premium.gehaelter', t, labels);
    expect(message).toContain('P:basic');
    expect(message).toContain('P:premium');
    expect(message).toContain('F:gehaelter');
    // The lower plan holds the feature, the higher one lacks it: order matters.
    expect(message.indexOf('P:basic')).toBeLessThan(message.indexOf('P:premium'));
  });

  it('names the plan of a price, a required and an extra plan', () => {
    expect(planProblemMessage('plans.price.advanced', t, labels)).toContain('P:advanced');
    expect(planProblemMessage('plans.required.premium', t, labels)).toContain('P:premium');
    expect(planProblemMessage('plans.extra.gold', t, labels)).toContain('P:gold');
  });

  it('names the feature nobody grants and the duplicate rank', () => {
    expect(planProblemMessage('plans.missing.werkstatt', t, labels)).toContain('F:werkstatt');
    expect(planProblemMessage('plans.rank.duplicate.1', t, labels)).toContain('1');
  });

  it('counts entries from one for a person', () => {
    expect(planProblemMessage('plans.entry.0', t, labels)).toContain('1');
  });

  it('shows a code it does not know rather than hiding it', () => {
    expect(planProblemMessage('something.else', t, labels)).toContain('something.else');
  });

  it('has a German sentence for every message key it uses', () => {
    for (const key of Object.keys(de).filter(k => k.startsWith('admin.plans.problem.'))) {
      expect((de as Record<string, string>)[key].length).toBeGreaterThan(10);
    }
  });
});
