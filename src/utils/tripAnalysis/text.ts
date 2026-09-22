/**
 * The German wording of findings. German is the product's source language;
 * a screen may render its own text from an issue's type and values instead.
 * Figures follow German formatting (decimal comma, DD.MM.YYYY).
 */
import { formatNumber } from '../../components/ui/format';
import { fmtAbsDate, fmtRideRange } from '../planningQualityChecks';
import type { BudgetProblem } from './types';

const MINUTE_MS = 60_000;

/** Minutes as German text: whole minutes without a decimal, otherwise one. */
export function minutesText(minutes: number): string {
  const rounded = Math.round(minutes * 10) / 10;
  return Number.isInteger(rounded) ? formatNumber(rounded, 0) : formatNumber(rounded, 1);
}

export function msAsMinutesText(ms: number): string {
  return minutesText(ms / MINUTE_MS);
}

export function hoursText(hours: number): string {
  return formatNumber(hours, 1);
}

/** "01.08.2026 07:00–07:15", or with both dates when the interval crosses midnight. */
export function intervalText(startMs: number, endMs: number): string {
  if (fmtAbsDate(startMs) === fmtAbsDate(endMs)) return `${fmtAbsDate(startMs)} ${fmtRideRange(startMs, endMs)}`;
  return fmtRideRange(startMs, endMs);
}

const BUDGET_PROBLEM_TEXT: Readonly<Record<BudgetProblem, string>> = {
  salary_min_missing: 'Mindestgehalt fehlt',
  salary_min_invalid: 'Mindestgehalt ist keine Zahl',
  salary_min_negative: 'Mindestgehalt ist negativ',
  salary_max_missing: 'Höchstgehalt fehlt',
  salary_max_invalid: 'Höchstgehalt ist keine Zahl',
  salary_max_negative: 'Höchstgehalt ist negativ',
  salary_min_above_max: 'Mindestgehalt liegt über dem Höchstgehalt',
  hourly_rate_missing: 'Stundensatz fehlt',
  hourly_rate_invalid: 'Stundensatz ist keine Zahl',
  hourly_rate_not_positive: 'Stundensatz ist nicht größer als 0',
  reserve_not_set: 'Reserve nicht festgelegt',
  reserve_invalid: 'Reserve ist keine Zahl',
  reserve_negative: 'Reserve ist negativ',
  reserve_above_hours_max: 'Reserve liegt über dem Stundenrahmen',
};

export function budgetProblemsText(problems: readonly BudgetProblem[]): string {
  return problems.map(p => BUDGET_PROBLEM_TEXT[p]).join(', ');
}
