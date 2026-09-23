import type { Plan } from '../../contexts/PlanContext';
import type { TranslationKey } from '../../i18n';

/**
 * The three tiers as the signup screens present them.
 *
 * Lifted out of SignupPage unchanged when the Google registration screen
 * (plan 1.6) needed the same list: two copies of a plan table would let the
 * two screens sell different things.
 *
 * `sub` and `features` hold TranslationKeys because this list is module-level
 * and `t()` is a hook value. Every consumer resolves it at the render site.
 * `name` is not a key: a tier is called Basic, Advanced or Premium in every
 * language.
 *
 * Each tier used to carry a colour of its own, which painted its card, its
 * price and the fleet slider (audit finding 9: three colours for three plans).
 * Since phase 5 batch 4 the one brand colour marks the chosen tier, so the
 * field is gone; nothing else read it.
 */
export interface PlanDef {
  id: Plan;
  name: string;
  sub: TranslationKey;
  highlight: boolean;
  features: TranslationKey[];
}

export const PLANS: PlanDef[] = [
  {
    id: 'basic',
    name: 'Basic',
    sub: 'signup.plan.basicSub',
    highlight: false,
    features: ['nav.overview', 'nav.belege', 'nav.fahrer', 'nav.cars', 'nav.umsaetze', 'nav.fixkosten', 'nav.bargeldbestand'],
  },
  {
    id: 'advanced',
    name: 'Advanced',
    sub: 'landing.plan.advancedSub',
    highlight: true,
    features: ['signup.plan.everythingInBasic', 'nav.werkstatt', 'nav.abrechnung', 'nav.notes', 'locked.feature.rollenNutzer'],
  },
  {
    id: 'premium',
    name: 'Premium',
    sub: 'landing.plan.premiumSub',
    highlight: false,
    features: ['signup.plan.everythingInAdvanced', 'nav.salaries', 'nav.documents', 'locked.feature.stundennachweis'],
  },
];

/** The definition of a tier. Every Plan has one, so this never returns undefined. */
export const planDef = (plan: Plan): PlanDef => PLANS.find(entry => entry.id === plan) ?? PLANS[0];
