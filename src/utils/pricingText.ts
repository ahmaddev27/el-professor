import type { TranslationKey, TranslationVars } from '../i18n';
import { fleetDiscountBands, type PriceBook } from './pricing';

type Translate = (key: TranslationKey, vars?: TranslationVars) => string;
type TranslatePlural = (
  keys: { one: TranslationKey; other: TranslationKey },
  count: number,
  vars?: TranslationVars,
) => string;

/**
 * The fleet discount tiers in one line, built from the price book so a changed
 * tier changes the sentence. For today's book:
 * "1–5 Fahrzeuge: 0% · 6–10 Fahrzeuge: 5% · 11+ Fahrzeuge: 10%".
 */
export function fleetDiscountSummary(book: PriceBook, t: Translate, tPlural: TranslatePlural): string {
  return fleetDiscountBands(book)
    .map((band) => {
      if (band.toCars === null) {
        return t('landing.pricing.fleetBandFrom', { from: band.fromCars, pct: band.percent });
      }
      if (band.toCars === band.fromCars) {
        return tPlural(
          { one: 'landing.pricing.fleetBandExactOne', other: 'landing.pricing.fleetBandExactOther' },
          band.fromCars,
          { pct: band.percent },
        );
      }
      return t('landing.pricing.fleetBandRange', { from: band.fromCars, to: band.toCars, pct: band.percent });
    })
    .join(' · ');
}
